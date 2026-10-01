"""
Glue between a peer and the lab visualiser (visualiser.py).

You don't need to read this file for the lab exercises. It adds two XML-RPC
functions to a peer so that the visualiser can show the peer's state and run
shell commands on it. Every action in the visualiser is one of the shell
commands you can type in the peer's terminal, and it is echoed there.
"""
import inspect, io, json, queue, re, sys, threading, time

from contextlib import contextmanager


class _ThreadStdout:
    """sys.stdout replacement that can also capture print() output per thread."""

    def __init__(self, real):
        self.real = real
        self.local = threading.local()

    def write(self, text):
        buffer = getattr(self.local, "buffer", None)
        if buffer is not None:
            buffer.write(text)
        return self.real.write(text)

    def flush(self):
        self.real.flush()

    def __getattr__(self, name):
        return getattr(self.real, name)

    @contextmanager
    def capture(self):
        self.local.buffer = io.StringIO()
        try:
            yield self.local.buffer
        finally:
            self.local.buffer = None


class _EventLog:
    def __init__(self, size=300):
        self.lock = threading.Lock()
        self.size = size
        self.events = []
        self.next_id = 1

    def add(self, kind, **fields):
        with self.lock:
            event = {"id": self.next_id, "t": time.time(), "type": kind, **fields}
            self.next_id += 1
            self.events.append(event)
            del self.events[:-self.size]

    def since(self, last_id):
        with self.lock:
            return [e for e in self.events if e["id"] > last_id]


def _difficulty(valid_function):
    """Number of leading zeros required by PoWBlock.valid (read from its source)."""
    try:
        match = re.search(r"prefix\s*=\s*[\"'](0*)[\"']", inspect.getsource(valid_function))
        return len(match.group(1)) if match else None
    except (OSError, TypeError):
        return None


def attach_visualiser(server, shell, namespace):
    """
    Expose a peer to visualiser.py.

    server:    the peer's ServerThread
    shell:     the peer's PeerShell
    namespace: the peer module's globals() (blockchain_state, known_peers, ...)
    """
    log = _EventLog()
    booted = time.time()
    command_lock = threading.Lock()

    if not isinstance(sys.stdout, _ThreadStdout):
        sys.stdout = _ThreadStdout(sys.stdout)
    stdout = sys.stdout

    block_cls = type(namespace["blockchain_state"].genesis)
    is_pow = hasattr(block_cls, "pow")
    mining = {"active": False, "what": None, "index": None, "nonce": None, "started": 0.0, "thread": None}

    # ----- run shell commands and record them ----- #
    run_shell_command = shell.onecmd

    def run_command(line, source, request=None):
        with command_lock:
            if source == "visualiser":
                print(f"\n[visualiser] {line}")
                last_cmd = shell.lastcmd  # so pressing Enter in the terminal doesn't repeat it
            with stdout.capture() as output:
                try:
                    stop = run_shell_command(line)
                except Exception as e:
                    print(f"Error: {e!r}")
                    stop = None
            if source == "visualiser":
                shell.lastcmd = last_cmd
                print(shell.prompt, end="", flush=True)

        output = output.getvalue()
        log.add("command", line=line or shell.lastcmd, source=source, output=output, request=request)
        for result, port in re.findall(r"(Updated|Failed to update) state on http://localhost:(\d+)", output):
            log.add("send", to=int(port), accepted=result == "Updated")
        return stop

    shell.onecmd = lambda line: run_command(line, "terminal")

    # Commands from the visualiser run one at a time, in the order they were sent
    pending = queue.Queue()
    requests = iter(range(1, sys.maxsize))

    def run_pending():
        while True:
            run_command(*pending.get())

    threading.Thread(target=run_pending, daemon=True).start()

    def vis_command(line):
        request = next(requests)
        pending.put((line, "visualiser", request))
        return request

    # ----- record what other peers send us ----- #
    receive_chain = namespace["receive"]
    chain_cls = namespace["Blockchain"]

    def receive(blockchain):
        try:
            valid = chain_cls.validate(chain_cls(**blockchain).blocks)
        except Exception:
            valid = False
        accepted = receive_chain(blockchain)
        reason = "accepted" if accepted else ("invalid" if not valid else "not longer")
        log.add("receive", accepted=bool(accepted), reason=reason, length=len(blockchain.get("blocks") or []))
        return accepted

    # ----- follow mining progress (Proof-of-Work peers only) ----- #
    if is_pow:
        mine_block, check_nonce = block_cls.pow, block_cls.valid

        def start_mining(what, index):
            mining.update(active=True, what=what, index=index, nonce=None,
                          started=time.time(), thread=threading.get_ident())

        def pow(self):
            start_mining("block", self.index)
            try:
                return mine_block(self)
            finally:
                mining["active"] = False
                log.add("mined", index=self.index, nonce=str(self.nonce),
                        seconds=round(time.time() - mining["started"], 2))

        def valid(self, nonce):
            if mining["active"] and mining["thread"] == threading.get_ident():
                mining["nonce"] = nonce
            return check_nonce(self, nonce)

        block_cls.pow, block_cls.valid = pow, valid

        if hasattr(shell, "do_pow"):
            find_nonce = shell.do_pow

            def do_pow(arg):
                start_mining("pow command", None)
                try:
                    return find_nonce(arg)
                finally:
                    mining["active"] = False

            do_pow.__doc__ = find_nonce.__doc__
            shell.do_pow = do_pow

    # ----- state snapshot for the visualiser ----- #
    def block_info(block):
        info = {
            "index": block.index,
            "timestamp": None,
            "data": str(block.data),
            "previous": block.previous_block,
            "hash": None,
        }
        try:
            info["timestamp"] = int(block.timestamp.timestamp())
            if is_pow:
                info["nonce"] = None if block.nonce is None else str(block.nonce)
                info["hash"] = block.ghash(block.nonce)
                info["pow_ok"] = bool(check_nonce(block, block.nonce))
            else:
                info["hash"] = block.header_hash()
        except Exception as e:
            info["error"] = repr(e)
        return info

    def vis_snapshot(since=0):
        chain = namespace["blockchain_state"]
        blocks = [block_info(b) for b in chain.blocks]
        for i, block in enumerate(blocks):
            block["link_ok"] = i == 0 or blocks[i - 1]["hash"] == block["previous"]
        try:
            valid = bool(chain_cls.validate(chain.blocks))
        except Exception:
            valid = False

        peers = []
        for url in namespace["known_peers"]:
            match = re.search(r":(\d+)$", str(url))
            if match and int(match.group(1)) not in peers:
                peers.append(int(match.group(1)))

        progress = None
        if mining["active"]:
            progress = {k: mining[k] for k in ("what", "index", "nonce")}
            progress["elapsed"] = round(time.time() - mining["started"], 2)

        return json.dumps({
            "port": server.port,
            "booted": booted,
            "kind": "pow" if is_pow else "basic",
            "difficulty": _difficulty(check_nonce) if is_pow else None,
            "valid": valid,
            "blocks": blocks,
            "peers": peers,
            "mining": progress,
            "events": log.since(since),
        })

    rpc = server.localServer
    rpc.register_function(receive, "receive")
    rpc.register_function(vis_snapshot)
    rpc.register_function(vis_command)
