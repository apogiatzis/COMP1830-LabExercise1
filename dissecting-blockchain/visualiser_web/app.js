import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';

// University of Greenwich palette
const COLOR = {
  navy: 0x00033d, peer: 0x1b2a6b, blue: 0x0058aa, bright: 0x3abff0,
  teal: 0x218474, red: 0xcc4b37, link: 0x9a99a6, floor: 0xeeedee,
};
const POLL_MS = 500;
const TAMPER = /^(setdata|settimestamp|setprevious|setnonce)\b/;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (h) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : '—');
const fmt = (n) => Number(n).toLocaleString('en-GB');
const clock = (t) => new Date(t * 1000).toLocaleTimeString('en-GB');
const duration = (s) => {
  s = Math.max(0, Math.round(s));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const app = {
  connected: true,
  peers: new Map(),      // port -> latest snapshot from the peer
  since: {},             // port -> id of the last event we have seen
  booted: {},            // port -> boot time, to notice restarts
  receives: new Map(),   // port -> recent "receive" events (to explain rejections)
  lastMined: new Map(),  // port -> last "mined" event
  mode: 'basic',
  modeChosen: false,
  selected: null,        // port we act as
  block: null,           // { port, index } shown in the inspector
  pending: null,         // { port, request } waiting for output
  attack: null,          // { port, started, ended }
  portRange: [8001, 8010],
};

function blockStatus(blocks, i) {
  const b = blocks[i];
  const next = blocks[i + 1];
  const linkOk = b.link_ok;
  const powOk = i === 0 || b.pow_ok !== false; // the genesis block isn't mined
  const pointedOk = !next || next.link_ok;
  return { linkOk, powOk, pointedOk, ok: linkOk && powOk && pointedOk && !b.error };
}

function chainProblem(snap) {
  const blocks = snap.blocks;
  for (let i = 1; i < blocks.length; i++) {
    if (!blocks[i].link_ok) return `block #${i}'s previous hash doesn't match the hash of block #${i - 1}`;
    if (snap.kind === 'pow' && blocks[i].pow_ok === false) return `block #${i} doesn't have a valid proof-of-work`;
  }
  return null;
}

const visiblePorts = () => [...app.peers.values()]
  .filter((p) => p.kind === app.mode)
  .map((p) => p.port)
  .sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// Talking to visualiser.py
// ---------------------------------------------------------------------------
async function poll() {
  try {
    const since = Object.entries(app.since).map(([p, id]) => `${p}:${id}`).join(',');
    const res = await fetch(`/api/state?since=${since}`, { cache: 'no-store' });
    const data = await res.json();
    app.portRange = data.ports;
    app.connected = true;
    ingest(data.peers);
  } catch (e) {
    app.connected = false;
  }
  render();
  setTimeout(poll, POLL_MS);
}

async function runCommand(line, port = app.selected) {
  line = line.trim();
  if (!line || !port) return;
  showOutput(line, '…');
  try {
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port, line }),
    });
    const body = await res.json();
    if (body.error) return showOutput(line, body.error);
    app.pending = { port, request: body.request };
  } catch (e) {
    showOutput(line, 'Could not reach visualiser.py. Is it still running?');
  }
}

function ingest(snapshots) {
  const seen = new Set();
  const events = [];
  for (const snap of snapshots) {
    const port = snap.port;
    seen.add(port);
    if (snap.busy || snap.error) {
      const known = app.peers.get(port);
      if (known) known.busy = !!snap.busy;
      else if (snap.error && !app.booted[port]) {
        app.booted[port] = 'error';
        addActivity('bad', `Port ${port}: ${snap.error}`);
      }
      continue;
    }
    const firstSight = app.booted[port] === undefined || app.booted[port] === 'error';
    if (app.booted[port] !== snap.booted) {
      addActivity('info', firstSight ? `Peer ${port} is online (${snap.kind === 'pow' ? 'Proof-of-Work' : 'no consensus'})` : `Peer ${port} restarted`);
      if (!firstSight) {
        // Event ids start again from 1 after a restart: fetch them next time
        app.booted[port] = snap.booted;
        app.since[port] = 0;
        app.peers.set(port, snap);
        continue;
      }
      app.booted[port] = snap.booted;
    }
    for (const e of snap.events) events.push({ ...e, port, animate: !firstSight });
    if (snap.events.length) app.since[port] = snap.events.at(-1).id;
    app.peers.set(port, snap);
  }

  for (const port of [...app.peers.keys()]) {
    if (!seen.has(port)) {
      app.peers.delete(port);
      delete app.since[port];
      delete app.booted[port];
      if (app.block?.port === port) app.block = null;
      addActivity('bad', `Peer ${port} went offline`);
    }
  }

  if (!app.modeChosen && app.peers.size) {
    const pow = [...app.peers.values()].filter((p) => p.kind === 'pow').length;
    app.mode = pow > app.peers.size - pow ? 'pow' : 'basic';
  }
  const visible = visiblePorts();
  if (!visible.includes(app.selected)) app.selected = visible[0] ?? null;

  events.sort((a, b) => a.t - b.t).forEach(handleEvent);
}

// ---------------------------------------------------------------------------
// Events -> activity log, animations, attack timer
// ---------------------------------------------------------------------------
function describeCommand(e) {
  const [cmd, ...rest] = e.line.trim().split(/\s+/);
  const arg = rest.join(' ');
  const [index, value] = arg.split('#');
  const out = e.output.trim();
  const p = e.port;
  if (out.startsWith('Error:') || out.startsWith('*** Unknown syntax')) return ['bad', `${p} › ${e.line}`];
  switch (cmd) {
    case 'hello':
      return out.includes('successfully') ? ['ok', `${p} connected to ${arg}`] : ['bad', `${p} could not connect to ${arg}`];
    case 'append': return ['info', `${p} appended a block ‘${arg}’`];
    case 'broadcast': return ['info', `${p} broadcast its chain`];
    case 'validate': return out === 'True' ? ['ok', `${p} validated its chain: valid`] : ['bad', `${p} validated its chain: not valid`];
    case 'setdata': return ['bad', `${p} changed the data of block #${index} to ‘${value}’`];
    case 'setprevious': return ['bad', `${p} changed the previous hash of block #${index} to ${short(value)}`];
    case 'settimestamp': return ['bad', `${p} changed the timestamp of block #${index}`];
    case 'setnonce': return ['bad', `${p} changed the nonce of block #${index} to ${value}`];
    case 'pow': return ['info', `${p} searched for a nonce`];
    default: return ['info', `${p} › ${e.line}`];
  }
}

function handleEvent(e) {
  if (e.type === 'command') {
    const [tone, text] = describeCommand(e);
    const quiet = ['broadcast', 'append', 'hello'].some((c) => e.line.startsWith(c));
    addActivity(tone, text, {
      time: e.t, command: e.line, source: e.source,
      output: quiet ? '' : e.output.trim(),
    });
    if (e.animate && TAMPER.test(e.line.trim()) && (!app.attack || app.attack.ended)) {
      app.attack = { port: e.port, started: e.t, ended: null };
    }
    if (app.pending && app.pending.port === e.port && app.pending.request === e.request) {
      showOutput(e.line, e.output.trim() || '(no output)');
      app.pending = null;
    }
  } else if (e.type === 'receive') {
    const list = app.receives.get(e.port) || [];
    list.push(e);
    app.receives.set(e.port, list.slice(-10));
  } else if (e.type === 'send') {
    const answer = (app.receives.get(e.to) || []).filter((r) => Math.abs(r.t - e.t) < 5).at(-1);
    const why = !answer || answer.accepted ? '' : answer.reason === 'invalid' ? ' (not valid)' : ' (not longer than its own)';
    addActivity(e.accepted ? 'ok' : 'bad',
      e.accepted ? `${e.to} accepted the chain from ${e.port}` : `${e.to} rejected the chain from ${e.port}${why}`,
      { time: e.t });
    if (e.animate) sendPacket(e.port, e.to, e.accepted, !answer || answer.accepted ? '' : answer.reason === 'invalid' ? 'not valid' : 'not longer');
    if (e.accepted && app.attack && !app.attack.ended && app.attack.port === e.port) {
      app.attack.ended = e.t;
      addActivity('bad', `Attack succeeded: ${e.to} accepted the tampered chain ${duration(e.t - app.attack.started)} after the first edit`, { time: e.t });
    }
  } else if (e.type === 'mined') {
    app.lastMined.set(e.port, e);
    addActivity('ok', `${e.port} mined block #${e.index} in ${e.seconds} s (nonce ${fmt(e.nonce)})`, { time: e.t });
  }
}

function addActivity(tone, text, { time = Date.now() / 1000, command, source, output } = {}) {
  const li = el('li');
  li.append(el('span', `dot ${tone}`));
  const body = el('div');
  body.append(el('div', '', esc(text)));
  if (command) {
    const cmd = el('div', 'mono', `<span>${esc(command)}</span><span class="src">${source === 'visualiser' ? 'from visualiser' : 'from terminal'}</span>`);
    cmd.style.cssText = 'font-size:11px;color:var(--navy-light);margin-top:2px';
    body.append(cmd);
  }
  if (output) body.append(el('pre', '', esc(output)));
  li.append(body, el('span', 'time', clock(time)));
  li.dataset.t = time;
  // Newest first. Events from before the page was opened go below newer entries
  const list = $('activity');
  const after = [...list.children].find((item) => Number(item.dataset.t) <= time);
  list.insertBefore(li, after ?? null);
  while (list.children.length > 150) list.lastChild.remove();
}

function showOutput(line, text) {
  $('output').hidden = false;
  $('output-cmd').textContent = line;
  $('output-text').textContent = text;
}

// ---------------------------------------------------------------------------
// 3D scene
// ---------------------------------------------------------------------------
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.prepend(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none';
stage.append(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(COLOR.floor);
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 300);
camera.position.set(0, 14, 16);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.42;
controls.minDistance = 5;
controls.maxDistance = 60;

scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d6da, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(-5, 16, 9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 50 });
scene.add(sun);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.ShadowMaterial({ opacity: 0.06 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const world = new THREE.Group();
scene.add(world);

const GEO = {
  sphere: new THREE.SphereGeometry(0.55, 48, 32),
  ring: new THREE.RingGeometry(0.78, 0.84, 64),
  cube: new THREE.BoxGeometry(1, 1, 1),
  edges: new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
  packet: new THREE.SphereGeometry(0.09, 16, 12),
};
const MAT = {
  peer: new THREE.MeshStandardMaterial({ color: COLOR.peer, roughness: 0.5, metalness: 0.05 }),
  ring: new THREE.MeshBasicMaterial({ color: COLOR.blue, side: THREE.DoubleSide }),
  cube: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
  ghost: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, transparent: true, opacity: 0.55 }),
  edgeOk: new THREE.LineBasicMaterial({ color: COLOR.teal }),
  edgeBad: new THREE.LineBasicMaterial({ color: COLOR.red }),
  edgeSelected: new THREE.LineBasicMaterial({ color: COLOR.blue }),
  edgeMining: new THREE.LineBasicMaterial({ color: COLOR.bright }),
  link: new THREE.LineBasicMaterial({ color: COLOR.link }),
  linkBad: new THREE.LineDashedMaterial({ color: COLOR.red, dashSize: 0.08, gapSize: 0.06 }),
  peerLink: new THREE.LineBasicMaterial({ color: COLOR.blue, transparent: true, opacity: 0.75 }),
  packet: new THREE.MeshBasicMaterial({ color: COLOR.blue }),
};

const views = new Map();     // port -> peer view
const peerLinks = new Map(); // "a-b" -> line
const packets = [];
let layoutInfo = { count: -1, positions: [], rowWidth: 0 };
let pxPerUnit = 50; // screen pixels per world unit, set by fitCamera()

function layout(n) {
  const radius = n <= 1 ? 0 : n === 2 ? 4.5 : 5.6 + Math.max(0, n - 4) * 1.1;
  const gap = n <= 1 ? 12 : n === 2 ? 9 : 2 * radius * Math.sin(Math.PI / n);
  const positions = [...Array(n)].map((_, i) => {
    const a = (n === 2 ? Math.PI : -Math.PI / 2) + (i * 2 * Math.PI) / n; // two peers side by side
    return new THREE.Vector3(radius * Math.cos(a), 0, radius * Math.sin(a));
  });
  return { positions, radius, rowWidth: Math.min(gap * 0.85, 10) };
}

function disposeTree(object) {
  object.traverse((o) => {
    if (o.isCSS2DObject) o.element.remove();
    if (o.userData.ownGeometry) o.geometry.dispose();
  });
  object.removeFromParent();
}

function label(className, html, position) {
  const div = el('div', className, html);
  const obj = new CSS2DObject(div);
  obj.position.copy(position);
  return obj;
}

function createPeerView(port, position) {
  const group = new THREE.Group();
  group.position.copy(position);
  const sphere = new THREE.Mesh(GEO.sphere, MAT.peer);
  sphere.position.y = 0.55;
  sphere.castShadow = true;
  sphere.userData = { type: 'peer', port };
  const ring = new THREE.Mesh(GEO.ring, MAT.ring);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  const name = label('label-anchor', `<div class="label-peer"><div class="name">Peer ${port}</div><div class="meta"></div></div>`, new THREE.Vector3(0, 0.55, 0));
  const chain = new THREE.Group();
  group.add(sphere, ring, name, chain);
  world.add(group);
  return { port, group, sphere, ring, name, chain, target: position.clone(), signature: null, mining: null };
}

function buildChain(view, snap, side, rowWidth) {
  view.chain.children.slice().forEach(disposeTree);
  view.mining = null;

  const mining = snap.mining && snap.mining.what === 'block' ? snap.mining : null;
  const count = snap.blocks.length + (mining ? 1 : 0);
  const spacing = Math.min(1.35, rowWidth / Math.max(count, 1));
  const size = spacing * 0.6;
  const rowZ = side < 0 ? -1.75 : 1.55;
  // Labels go above the back row and below the front row, anchored to the cube's edge
  const anchor = (x) => (side < 0 ? new THREE.Vector3(x, size, rowZ - size / 2) : new THREE.Vector3(x, 0, rowZ + size / 2));
  const place = side < 0 ? 'above' : 'below';
  const x0 = (-(count - 1) * spacing) / 2;
  const labelWidth = Math.round(spacing * pxPerUnit) - 6;
  const showData = labelWidth >= 38;

  snap.blocks.forEach((b, i) => {
    const status = blockStatus(snap.blocks, i);
    const selected = app.block && app.block.port === snap.port && app.block.index === i;
    const x = x0 + i * spacing;
    const cube = new THREE.Mesh(GEO.cube, MAT.cube);
    cube.scale.setScalar(size);
    cube.position.set(x, size / 2 + (selected ? 0.18 : 0), rowZ);
    cube.castShadow = true;
    cube.userData = { type: 'block', port: snap.port, index: i };
    cube.add(new THREE.LineSegments(GEO.edges, !status.ok ? MAT.edgeBad : selected ? MAT.edgeSelected : MAT.edgeOk));
    view.chain.add(cube);

    const data = showData ? `<div class="data" style="max-width:${labelWidth}px">${esc(b.data)}</div>` : '';
    view.chain.add(label('label-anchor', `<div class="label-block ${place}"><div class="idx">#${i}</div>${data}</div>`, anchor(x)));

    if (i > 0) {
      const from = new THREE.Vector3(x - spacing + size / 2, size / 2, rowZ);
      const to = new THREE.Vector3(x - size / 2, size / 2, rowZ);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, to]), b.link_ok ? MAT.link : MAT.linkBad);
      line.computeLineDistances();
      line.userData.ownGeometry = true;
      view.chain.add(line);
    }
  });

  if (mining) {
    const x = x0 + snap.blocks.length * spacing;
    const cube = new THREE.Mesh(GEO.cube, MAT.ghost);
    cube.scale.setScalar(size);
    cube.position.set(x, size / 2 + 0.15, rowZ);
    cube.add(new THREE.LineSegments(GEO.edges, MAT.edgeMining));
    const text = label('label-anchor', `<div class="label-block label-mining ${place}"></div>`, anchor(x));
    view.chain.add(cube, text);
    view.mining = { cube, text, baseY: size / 2 + 0.15 };
  }
}

function syncScene() {
  const ports = visiblePorts();
  for (const [port, view] of views) {
    if (!ports.includes(port)) {
      disposeTree(view.group);
      views.delete(port);
    }
  }

  const { positions, radius, rowWidth } = layout(ports.length);
  ports.forEach((port, i) => {
    const snap = app.peers.get(port);
    let view = views.get(port);
    if (!view) views.set(port, (view = createPeerView(port, positions[i])));
    view.target.copy(positions[i]);
    const side = positions[i].z < -0.5 ? -1 : 1;

    const signature = JSON.stringify([snap.blocks, side, rowWidth, Math.round(pxPerUnit), app.block, snap.mining?.what]);
    if (signature !== view.signature) {
      buildChain(view, snap, side, rowWidth);
      view.signature = signature;
    }
    if (view.mining) {
      const m = snap.mining;
      view.mining.text.element.firstChild.textContent = m.nonce == null ? 'Mining…' : `Mining… nonce ${fmt(m.nonce)}`;
    }

    view.ring.visible = port === app.selected;
    const problem = chainProblem(snap);
    view.name.element.classList.toggle('left', positions[i].x < -0.5);
    view.name.element.classList.toggle('selected', port === app.selected);
    view.name.element.querySelector('.meta').innerHTML =
      `${snap.blocks.length} block${snap.blocks.length === 1 ? '' : 's'} · ` +
      (snap.busy ? 'busy…' : snap.valid ? '<span style="color:var(--teal)">valid</span>' : `<span style="color:var(--red)" title="${esc(problem)}">not valid</span>`);
  });

  // Lines between peers that know each other
  const wanted = new Set();
  for (const port of ports) {
    for (const other of app.peers.get(port).peers) {
      if (ports.includes(other) && other !== port) wanted.add([port, other].sort((a, b) => a - b).join('-'));
    }
  }
  for (const [key, line] of peerLinks) {
    if (!wanted.has(key)) {
      disposeTree(line);
      peerLinks.delete(key);
    }
  }
  for (const key of wanted) {
    if (peerLinks.has(key)) continue;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), MAT.peerLink);
    line.userData = { ownGeometry: true, ports: key.split('-').map(Number) };
    line.frustumCulled = false;
    world.add(line);
    peerLinks.set(key, line);
  }

  if (ports.length !== layoutInfo.count) {
    layoutInfo = { count: ports.length, positions, rowWidth };
    fitCamera();
  }
}

// Zoom so that every peer, chain and label fits on screen
function fitCamera() {
  const { positions, rowWidth } = layoutInfo;
  const box = new THREE.Box3();
  for (const p of positions.length ? positions : [new THREE.Vector3()]) {
    const back = p.z < -0.5;
    box.expandByPoint(new THREE.Vector3(p.x - rowWidth / 2 - 0.4, 0, p.z + (back ? -2.6 : -0.8)));
    box.expandByPoint(new THREE.Vector3(p.x + rowWidth / 2 + 0.4, 1.6, p.z + (back ? 0.8 : 3.0)));
  }
  const center = box.getCenter(new THREE.Vector3()).setY(0);
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(
    i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
  const dir = new THREE.Vector3(0, 0.78, 0.63).normalize();
  // Peer names and badges are a fixed size in pixels beside the spheres: keep room for them at the sides
  const maxX = Math.max(0.3, 1 - 360 / stage.clientWidth);
  const fits = (dist) => {
    camera.position.copy(dir).multiplyScalar(dist).add(center);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    return corners.every((c) => {
      const v = c.clone().project(camera);
      return Math.abs(v.x) < maxX && Math.abs(v.y) < 0.9;
    });
  };
  let lo = 4, hi = 80;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid; else lo = mid;
  }
  fits(hi);
  const origin = center.clone().project(camera);
  const unit = center.clone().add(new THREE.Vector3(1, 0, 0)).project(camera);
  pxPerUnit = (Math.abs(unit.x - origin.x) * stage.clientWidth) / 2;
  controls.target.copy(center);
  controls.update();
}

function peerPosition(port) {
  const view = views.get(port);
  return view ? view.group.position.clone().setY(0.55) : null;
}

function sendPacket(from, to, accepted, reason) {
  const start = peerPosition(from);
  const end = peerPosition(to);
  if (!start || !end) return;
  const mesh = new THREE.Mesh(GEO.packet, MAT.packet);
  mesh.position.copy(start);
  world.add(mesh);
  const delay = packets.filter((p) => p.from === from).length * 140;
  packets.push({ mesh, from, to, accepted, reason, born: performance.now() + delay, duration: 900 });
}

const badges = new Set();

function showBadge(port, accepted, reason) {
  const view = views.get(port);
  if (!view) return;
  // Stack the badge on the peer's name: below it for peers at the back, above it for the rest
  const nameOnLeft = view.target.x < -0.5;
  const back = view.target.z < -0.5;
  const text = accepted ? 'Accepted' : `Rejected${reason ? ` — ${reason}` : ''}`;
  const wrap = el('div');
  wrap.style.cssText = 'width:0;height:0;position:relative';
  const badge = el('div', `badge ${accepted ? 'ok' : 'bad'}`, `<span class="icon">${accepted ? '✓' : '✕'}</span>${esc(text)}`);
  badge.style.cssText = `position:absolute;${back ? 'top:24px' : 'bottom:24px'};${nameOnLeft ? 'right:34px' : 'left:34px'}`;
  wrap.append(badge);
  const obj = new CSS2DObject(wrap);
  obj.position.set(0, 0.55, 0);
  view.group.add(obj);
  badges.add(badge);
  setTimeout(() => (badge.style.opacity = '0'), 3500);
  setTimeout(() => { badges.delete(badge); disposeTree(obj); }, 4200);
}

function frame(now) {
  controls.update();
  for (const view of views.values()) view.group.position.lerp(view.target, 0.12);

  for (const line of peerLinks.values()) {
    const [a, b] = line.userData.ports.map(peerPosition);
    if (!a || !b) continue;
    const pos = line.geometry.attributes.position;
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
  }

  for (let i = packets.length - 1; i >= 0; i--) {
    const p = packets[i];
    const a = peerPosition(p.from);
    const b = peerPosition(p.to);
    const t = Math.min(1, Math.max(0, (now - p.born) / p.duration));
    if (a && b) p.mesh.position.lerpVectors(a, b, t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
    p.mesh.visible = now >= p.born;
    if (t >= 1 || !a || !b) {
      disposeTree(p.mesh);
      packets.splice(i, 1);
      if (a && b) showBadge(p.to, p.accepted, p.reason);
    }
  }

  for (const view of views.values()) {
    if (view.mining) view.mining.cube.position.y = view.mining.baseY + Math.sin(now / 400) * 0.05;
  }

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  // Keep badges inside the stage: nudge them in if they stick out at the sides
  if (badges.size) {
    const area = stage.getBoundingClientRect();
    for (const badge of badges) {
      const current = Number(badge.dataset.shift || 0);
      const box = badge.getBoundingClientRect();
      const left = box.left - current, right = box.right - current;
      const shift = Math.max(0, area.left + 8 - left) - Math.max(0, right - (area.right - 8));
      if (shift !== current) {
        badge.dataset.shift = shift;
        badge.style.transform = shift ? `translateX(${shift}px)` : '';
      }
    }
  }
  requestAnimationFrame(frame);
}

new ResizeObserver(() => {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (layoutInfo.count >= 0) fitCamera();
}).observe(stage);

// Clicking peers and blocks
const raycaster = new THREE.Raycaster();
let pointerDown = null;
renderer.domElement.addEventListener('pointerdown', (e) => (pointerDown = [e.clientX, e.clientY]));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!pointerDown || Math.hypot(e.clientX - pointerDown[0], e.clientY - pointerDown[1]) > 5) return;
  const hit = pick(e);
  if (hit?.type === 'block') {
    app.selected = hit.port;
    app.block = { port: hit.port, index: hit.index };
  } else if (hit?.type === 'peer') {
    if (app.block?.port !== hit.port) app.block = null;
    app.selected = hit.port;
  } else {
    app.block = null;
  }
  render();
});
renderer.domElement.addEventListener('pointermove', (e) => {
  renderer.domElement.style.cursor = pick(e) ? 'pointer' : '';
});

function pick(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const targets = [];
  for (const view of views.values()) {
    targets.push(view.sphere);
    view.chain.children.forEach((c) => c.userData.type === 'block' && targets.push(c));
  }
  return raycaster.intersectObjects(targets, false)[0]?.object.userData ?? null;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------
function render() {
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === app.mode));
  renderEmptyState();
  renderPeerSelect();
  syncScene();
  renderInspector();
  renderMining();
  renderStatus();
}

function renderEmptyState() {
  const empty = $('empty');
  const [first, last] = app.portRange;
  const script = app.mode === 'pow' ? 'pow_peer.py' : 'peer.py';
  if (!app.connected) {
    empty.innerHTML = `<h3>Lost connection to the visualiser</h3><p>Start it again from the <b>dissecting-blockchain</b> folder:</p><p><code>python visualiser.py</code></p>`;
  } else if (!visiblePorts().length) {
    const other = app.peers.size ? `<p>There are peers running in the other mode. Switch at the top right.</p>` : '';
    empty.innerHTML = `<h3>No ${app.mode === 'pow' ? 'Proof-of-Work ' : ''}peers running</h3>
      <p>Start each peer in its own terminal, from the <b>dissecting-blockchain</b> folder:</p>
      <p><code>python ${script} -p ${first}</code></p>
      <p>The visualiser looks for peers on ports ${first}–${last}.</p>${other}`;
  } else {
    empty.hidden = true;
    return;
  }
  empty.hidden = false;
}

function renderPeerSelect() {
  const select = $('peer-select');
  const ports = visiblePorts();
  const options = ports.map((p) => `<option value="${p}">Peer ${p}</option>`).join('');
  if (select.dataset.options !== options) {
    select.innerHTML = options || '<option>No peers</option>';
    select.dataset.options = options;
  }
  select.value = app.selected ?? '';
  const disabled = !app.selected;
  document.querySelectorAll('.controls .btn, .controls input, .controls select').forEach((c) => (c.disabled = disabled));
}

function renderInspector() {
  const box = $('inspector');
  const snap = app.block && app.peers.get(app.block.port);
  const block = snap?.blocks[app.block.index];
  if (!block || !visiblePorts().includes(snap.port)) {
    box.hidden = true;
    box.dataset.key = '';
    return;
  }
  box.hidden = false;
  const i = app.block.index;
  const pow = snap.kind === 'pow';
  const key = `${snap.port}:${i}:${pow}`;

  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = `
      <div class="inspector-head"><h2>Block #${i} · Peer ${snap.port}</h2><button class="close" title="Close">×</button></div>
      <div class="prop"><div class="k">Data</div><input data-field="data" data-cmd="setdata"></div>
      <div class="prop"><div class="k">Timestamp <span data-v="time"></span></div><input class="mono" data-field="timestamp" data-cmd="settimestamp"></div>
      <div class="prop"><div class="k">Previous hash</div><input class="mono" data-field="previous" data-cmd="setprevious"><div class="check" data-check="link"></div></div>
      ${pow ? '<div class="prop"><div class="k">Nonce</div><input class="mono" data-field="nonce" data-cmd="setnonce"><div class="check" data-check="pow"></div></div>' : ''}
      <div class="prop"><div class="k">${pow ? 'Block hash (header hash + nonce)' : 'Block hash'} <button class="copy" data-copy>Copy</button></div>
        <div class="v mono" data-v="hash"></div><div class="check" data-check="next"></div></div>
      <div class="apply-row"><button class="btn small primary" data-apply disabled>Apply changes</button><span class="preview mono"></span></div>`;
    box.querySelector('.close').onclick = () => { app.block = null; render(); };
    box.querySelector('[data-copy]').onclick = (e) => {
      navigator.clipboard?.writeText(box.querySelector('[data-v="hash"]').textContent);
      e.target.textContent = 'Copied';
      setTimeout(() => (e.target.textContent = 'Copy'), 1200);
    };
    box.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', () => updateApply(box));
      input.addEventListener('keydown', (e) => e.key === 'Enter' && applyEdits(box));
    });
    box.querySelector('[data-apply]').onclick = () => applyEdits(box);
  }

  const values = { data: block.data, timestamp: block.timestamp ?? '', previous: block.previous ?? '', nonce: block.nonce ?? '' };
  box.querySelectorAll('input').forEach((input) => {
    const value = String(values[input.dataset.field]);
    if (input.dataset.orig !== value && !input.classList.contains('dirty')) input.value = value;
    input.dataset.orig = value;
  });
  updateApply(box);
  box.querySelector('[data-v="time"]').textContent = block.timestamp ? new Date(block.timestamp * 1000).toLocaleString('en-GB') : '';
  box.querySelector('[data-v="hash"]').textContent = block.hash ?? block.error ?? '—';

  const status = blockStatus(snap.blocks, i);
  const prev = snap.blocks[i - 1];
  const next = snap.blocks[i + 1];
  const check = (name, ok, text) => {
    const c = box.querySelector(`[data-check="${name}"]`);
    if (!c) return;
    c.className = `check ${ok === null ? '' : ok ? 'ok' : 'bad'}`;
    c.textContent = ok === null ? text : `${ok ? '✓' : '✕'} ${text}`;
  };
  if (i === 0) check('link', null, 'The genesis block has no previous block.');
  else check('link', status.linkOk, status.linkOk ? `Matches the hash of block #${i - 1}` : `Block #${i - 1}'s hash is now ${short(prev.hash)}`);
  if (next) check('next', status.pointedOk, status.pointedOk ? `Block #${i + 1} points to this hash` : `Block #${i + 1} expects ${short(next.previous)}`);
  else check('next', null, 'This is the latest block.');
  if (pow) {
    const zeros = '0'.repeat(snap.difficulty ?? 0);
    if (i === 0) check('pow', null, 'The genesis block isn\'t mined.');
    else check('pow', status.powOk, status.powOk ? `Hash starts with ${zeros}` : `Hash must start with ${zeros}`);
  }
}

function editsFor(box) {
  const i = app.block.index;
  return [...box.querySelectorAll('input')]
    .filter((input) => input.value !== input.dataset.orig)
    .map((input) => `${input.dataset.cmd} ${i}#${input.value}`);
}

function updateApply(box) {
  const edits = editsFor(box);
  box.querySelectorAll('input').forEach((input) => input.classList.toggle('dirty', input.value !== input.dataset.orig));
  box.querySelector('[data-apply]').disabled = !edits.length;
  box.querySelector('.preview').textContent = edits.length ? `Runs: ${edits.join('; ')}` : '';
}

async function applyEdits(box) {
  const port = app.block.port;
  const edits = editsFor(box);
  box.querySelectorAll('input').forEach((input) => input.classList.remove('dirty'));
  for (const line of edits) await runCommand(line, port);
}

function renderMining() {
  const snap = app.peers.get(app.selected);
  const panel = $('mining');
  if (!snap || snap.kind !== 'pow') {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const d = snap.difficulty;
  $('pow-difficulty').textContent = d == null ? 'unknown' : `${d} leading zero${d === 1 ? '' : 's'}`;
  $('pow-work').textContent = d == null ? '–' : `≈ ${fmt(16 ** d)} hashes`;

  const live = $('mining-live');
  const m = snap.mining;
  const last = app.lastMined.get(snap.port);
  if (m && m.nonce != null) {
    const rate = m.elapsed > 0 ? m.nonce / m.elapsed : 0;
    live.innerHTML = `<span class="busy">Mining block #${m.index}…</span><span class="nonce">nonce ${fmt(m.nonce)}</span>${fmt(Math.round(rate))} hashes/s · ${m.elapsed.toFixed(1)} s`;
  } else if (m) {
    live.innerHTML = `<span class="busy">Searching for a nonce (pow command)…</span><br>${m.elapsed.toFixed(1)} s`;
  } else if (last) {
    live.textContent = `Last block mined: #${last.index} in ${last.seconds} s (nonce ${fmt(last.nonce)}).`;
  } else {
    live.textContent = 'Appending a block mines it: the peer tries nonces until the hash starts with enough zeros.';
  }
}

function renderStatus() {
  const snap = app.peers.get(app.selected);
  const chain = $('status-chain');
  if (!snap) {
    chain.innerHTML = '<span class="dot"></span>No peer selected';
  } else {
    const problem = chainProblem(snap);
    chain.innerHTML = problem
      ? `<span class="dot bad"></span><span class="bad">Peer ${snap.port}: chain not valid — ${esc(problem)}</span>`
      : `<span class="dot ok"></span><span>Peer ${snap.port}: chain valid · ${snap.blocks.length} blocks</span>`;
  }

  const ports = visiblePorts();
  const tips = new Set(ports.map((p) => app.peers.get(p).blocks.map((b) => b.hash).join()));
  $('status-network').innerHTML = ports.length < 2 ? ''
    : tips.size === 1 ? `<span class="ok">All ${ports.length} peers have the same chain</span>`
    : `<span>Peers have ${tips.size} different chains</span>`;

  const timer = $('status-timer');
  const a = app.attack;
  if (!a) {
    timer.innerHTML = '<span style="color:var(--muted)">Attack timer starts when you first edit a block</span>';
  } else if (a.ended) {
    timer.innerHTML = `Attack from ${a.port} succeeded in <span class="timer">${duration(a.ended - a.started)}</span>`;
  } else {
    const s = Math.max(0, Date.now() / 1000 - a.started);
    timer.innerHTML = `Attack from ${a.port} · <span class="timer">${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}</span>`;
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
$('peer-select').onchange = (e) => {
  app.selected = Number(e.target.value);
  if (app.block?.port !== app.selected) app.block = null;
  render();
};
document.querySelectorAll('#mode button').forEach((b) => (b.onclick = () => {
  app.mode = b.dataset.mode;
  app.modeChosen = true;
  app.block = null;
  app.selected = visiblePorts()[0] ?? null;
  render();
}));

const onEnter = (id, fn) => $(id).addEventListener('keydown', (e) => e.key === 'Enter' && fn());
const hello = () => {
  const port = $('hello-port').value.trim();
  if (/^\d+$/.test(port)) runCommand(`hello ${port}`);
  $('hello-port').value = '';
};
const append = () => {
  const data = $('append-data').value;
  if (data.trim()) runCommand(`append ${data}`);
  $('append-data').value = '';
};
const command = () => {
  runCommand($('cmd').value);
  $('cmd').value = '';
};
$('btn-hello').onclick = hello;
onEnter('hello-port', hello);
$('btn-append').onclick = append;
onEnter('append-data', append);
$('btn-cmd').onclick = command;
onEnter('cmd', command);
$('btn-broadcast').onclick = () => runCommand('broadcast');
$('btn-validate').onclick = () => runCommand('validate');

setInterval(renderStatus, 1000);
requestAnimationFrame(frame);
poll();
