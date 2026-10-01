import argparse, threading, cmd, hashlib

from datetime import datetime
from pow_block import PoWBlockchain as Blockchain

from xmlrpc.server import SimpleXMLRPCServer
from xmlrpc.client import ServerProxy

from peer_ui import attach_visualiser


blockchain_state = Blockchain()
known_peers = []


def receive(blockchain: Blockchain):
    global blockchain_state
    blockchain = Blockchain(**blockchain)
    if not Blockchain.validate(blockchain.blocks):
        print("\nReceived blockhain is not valid!")
        return False

    if len(blockchain.blocks) <= len(blockchain_state.blocks):
        return False

    blockchain_state = blockchain
    return True


def ping():
    return "pong"


def hello(peer_port: str):
    known_peers.append(f"http://localhost:{peer_port}")
    return known_peers


class ServerThread(threading.Thread):
    def __init__(self, port: int):
        threading.Thread.__init__(self)
        self.port = port
        self.localServer = SimpleXMLRPCServer(
            ("localhost", port),
            logRequests=False,
            allow_none=True,
            use_builtin_types=True,
        )
        self.localServer.register_function(receive)
        self.localServer.register_function(ping)
        self.localServer.register_function(hello)

    def run(self):
        self.localServer.serve_forever()


class PeerShell(cmd.Cmd):
    intro = "Welcome to the COMP1830 peer shell.   Type help or ? to list commands.\n"
    prompt = "(peer)> "

    def __init__(self, server, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.server = server
    
    def set_state(self, state):
        global blockchain_state
        blockchain_state = state

    # ----- basic peer commands -----
    def do_ping(self, arg):
        s = ServerProxy(f"http://localhost:{self.server.port}")
        print(s.ping())

    def do_hello(self, arg):
        try:
            s = ServerProxy(f"http://localhost:{arg}")
            s.hello(self.server.port)
        except Exception as e:
            print("Could not add peer")
            return
        hello(arg)
        print("Peer added successfully")

    def do_pow(self, arg):
        """
        Proof of work. Add nonce to block.
        """      
        prefix = "00000"  
        nonce = 0
        index, timestamp,data,previous_block = arg.split("#")
        header_hash = hashlib.sha256(
            (
                str(index)
                + str(int(timestamp))
                + str(data)
                + str(previous_block)
            ).encode("utf-8")
        ).hexdigest()
        ghash = hashlib.sha256(''.join((header_hash, str(nonce))).encode('utf-8')).hexdigest()
        while ghash[:len(prefix)] != prefix:
            nonce += 1
            ghash = hashlib.sha256(''.join((header_hash, str(nonce))).encode('utf-8')).hexdigest()
        print(ghash, nonce)

    def do_peers(self, arg):
        for peer in known_peers:
            print(peer)

    def do_state(self, arg):
        print(blockchain_state)
        # return blockchain_state

    def do_broadcast(self, arg):
        for peer in known_peers:
            s = ServerProxy(peer, allow_none=True, use_builtin_types=True)
            if s.receive(blockchain_state):
                print(f"Updated state on {peer}")
            else:
                print(f"Failed to update state on {peer}")

    def do_append(self, arg):
        blockchain_state.append_block(arg)

    def do_settimestamp(self, arg):
        index, timestamp = arg.split("#")
        index, timestamp = int(index), float(timestamp)
        timestamp = datetime.fromtimestamp(timestamp)
        blockchain_state.blocks[index].timestamp = timestamp

    def do_setdata(self, arg):
        index, data = arg.split("#")
        index, data = int(index), str(data)
        blockchain_state.blocks[index].data = data

    def do_setprevious(self, arg):
        index, previous = arg.split("#")
        index, previous = int(index), str(previous)
        blockchain_state.blocks[index].previous_block = previous

    def do_setnonce(self, arg):
        index, nonce = arg.split("#")
        index, nonce = int(index), str(nonce)
        blockchain_state.blocks[index].nonce = nonce

    def do_validate(self, args):
        print(Blockchain.validate(blockchain_state.blocks))


def start_peer(port):
    server = ServerThread(port)
    server.start()  # The server is now running
    return server

def run(port):
    server = start_peer(port)
    shell = PeerShell(server)
    attach_visualiser(server, shell, globals())  # lets visualiser.py show and control this peer
    return shell.cmdloop()


if __name__ == "__main__":

    parser = argparse.ArgumentParser(description="Description of your program")
    parser.add_argument("-p", "--port", help="Port_number", type=int, required=True)
    args = vars(parser.parse_args())
    run(args["port"])
