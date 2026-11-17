'use strict';
// Contrail.io — authoritative multiplayer server (Node.js + ws)
// Run: npm install && npm start   →  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30;
const WORLD_R = 3000;
const ORB_TARGET = 1200;
const ROOM_HUMANS = +(process.env.ROOM_HUMANS || 50); // humans per arena before a new arena opens
const BOT_FILL = +(process.env.BOT_FILL ?? 30);       // bots top up an arena to this many planes
const MIN_BOTS = +(process.env.MIN_BOTS ?? 8);
const CELL = 80;
const SPEED = 5.2, BOOST_SPEED = 10;

const COLORS = ['#ff4d4d', '#ffb020', '#ffe14d', '#4dff88', '#2ee6d6', '#4da6ff', '#a066ff', '#ff66c4', '#ffffff', '#ff8a3d'];
const BOT_NAMES = ['Maverick', 'Goose', 'Iceman', 'Viper', 'Red Baron', 'Skyfox', 'Ace', 'Falcon', 'Nova', 'Blaze',
  'Hawkeye', 'Phantom', 'Raptor', 'Jet', 'Comet', 'Zephyr', 'Storm', 'Cobra', 'Talon', 'Ghost', 'Sparrow', 'Bandit',
  'Rookie', 'Skipper', 'Wingnut', 'Loop', 'Barrel', 'Kite', 'Orbit', 'Flak', 'Pixel', 'Cirrus', 'Nimbus', 'Gale'];

// Shared formulas (mirrored in the client)
const trailTarget = s => Math.min(7000, 140 + s * 3);
const planeWidth = s => 12 + Math.min(28, Math.sqrt(s) * 0.9);
const zoomFor = s => 1 + Math.min(1.3, Math.max(0, s - 10) / 1500);
const turnRate = s => 0.11 * (1 - Math.min(0.45, s / 6000));

const gkey = (cx, cy) => ((cx + 512) << 10) | (cy + 512);
const cellOf = v => Math.floor(v / CELL);
const r1 = v => Math.round(v * 10) / 10;

class Room {
  constructor(id) {
    this.id = id;
    this.planes = new Map();
    this.orbs = new Map();
    this.orbGrid = new Map();
    this.grid = new Map();
    this.clients = new Set();
    this.nextId = 1; this.nextOrb = 1; this.tickN = 0; this.natural = 0;
    while (this.natural < ORB_TARGET) this.spawnNaturalOrb();
  }

  // ---------- orbs ----------
  addOrb(x, y, v, ttl = 0) {
    const o = { id: this.nextOrb++, x: r1(x), y: r1(y), v, c: (Math.random() * COLORS.length) | 0, ttl };
    o.k = gkey(cellOf(x), cellOf(y));
    let s = this.orbGrid.get(o.k); if (!s) this.orbGrid.set(o.k, s = new Set());
    s.add(o); this.orbs.set(o.id, o);
    if (!ttl) this.natural++;
    return o;
  }
  removeOrb(o) {
    this.orbs.delete(o.id);
    const s = this.orbGrid.get(o.k); if (s) s.delete(o);
    if (!o.ttl) this.natural--;
  }
  randomPoint(maxR) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * maxR;
    return [Math.cos(a) * r, Math.sin(a) * r];
  }
  spawnNaturalOrb() {
    const [x, y] = this.randomPoint(WORLD_R - 60);
    this.addOrb(x, y, [1, 1, 1, 2, 3][(Math.random() * 5) | 0]);
  }

  // ---------- planes ----------
  trailNear(x, y, r, self) {
    const cx = cellOf(x), cy = cellOf(y);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const c = this.grid.get(gkey(cx + i, cy + j)); if (!c) continue;
      for (let k = 0; k < c.length; k += 3) {
        const p = c[k]; if (p === self || !p.alive) continue;
        const rr = r + p.w / 2, dx = c[k + 1] - x, dy = c[k + 2] - y;
        if (dx * dx + dy * dy < rr * rr) return p;
      }
    }
    return null;
  }
  addPlane(name, colorIdx, client) {
    let best = null, bestD = -1;
    for (let i = 0; i < 12; i++) {
      const [x, y] = this.randomPoint(WORLD_R * 0.75);
      if (this.trailNear(x, y, 160, null)) continue;
      let d = 1e9;
      for (const p of this.planes.values()) d = Math.min(d, Math.hypot(p.x - x, p.y - y));
      if (d > bestD) { bestD = d; best = [x, y]; }
    }
    if (!best) best = this.randomPoint(WORLD_R * 0.75);
    const [x, y] = best;
    const a = Math.atan2(-y, -x) + (Math.random() - 0.5);
    const p = {
      id: this.nextId++, name, color: COLORS[colorIdx % COLORS.length], bot: !client, client,
      x, y, a, ta: a, boost: false, score: 10, w: planeWidth(10), trail: [[x, y]], len: 0,
      alive: true, kills: 0, born: Date.now(),
      ai: client ? null : { target: null, skill: 0.55 + Math.random() * 0.4, boostT: 0 },
    };
    this.planes.set(p.id, p);
    return p;
  }
  humanCount() { return this.clients.size; }

  kill(p, killer) {
    if (!p.alive) return;
    p.alive = false;
    const t = p.trail, total = Math.max(5, p.score * 0.75);
    const count = Math.min(150, Math.max(6, Math.floor(t.length / 2)));
    const step = t.length / count;
    for (let i = 0; i < count; i++) {
      const pt = t[Math.min(t.length - 1, Math.floor(i * step))];
      const o = this.addOrb(pt[0] + (Math.random() - 0.5) * 24, pt[1] + (Math.random() - 0.5) * 24,
        r1(Math.max(1, total / count)), this.tickN + TICK_RATE * 45);
      o.c = COLORS.indexOf(p.color);
    }
    this.deaths.push([Math.round(p.x), Math.round(p.y), COLORS.indexOf(p.color)]);
    const msg = killer ? `${killer.name} shot down ${p.name}` : `${p.name} crashed`;
    if (killer) {
      killer.kills++;
      if (killer.client) send(killer.client, { t: 'kill', name: p.name });
    }
    if (p.score > 60 || !p.bot || (killer && !killer.bot)) for (const c of this.clients) send(c, { t: 'k', m: msg });
    if (p.client) {
      const c = p.client;
      c.plane = null; c.cam = [p.x, p.y]; c.lastScore = p.score;
      send(c, { t: 'dead', score: Math.floor(p.score), kills: p.kills, by: killer ? killer.name : null,
        secs: Math.round((Date.now() - p.born) / 1000) });
    }
    this.planes.delete(p.id);
  }

  botThink(p) {
    const ai = p.ai;
    if (Math.hypot(p.x, p.y) > WORLD_R - 380) { p.ta = Math.atan2(-p.y, -p.x); p.boost = false; return; }
    if (Math.random() < ai.skill) {
      const look = 50 + p.w * 2;
      const danger = ang => {
        let s = 0;
        for (const d of [look * 0.5, look, look * 1.7]) {
          if (this.trailNear(p.x + Math.cos(ang) * d, p.y + Math.sin(ang) * d, 18, p)) s += 1;
        }
        return s;
      };
      if (danger(p.a) > 0) {
        const l = danger(p.a - 0.9), r = danger(p.a + 0.9);
        p.ta = p.a + (l <= r ? -1.5 : 1.5); p.boost = false; ai.target = null; return;
      }
    }
    if (!ai.target || (this.tickN + p.id) % 10 === 0) {
      let best = null, bs = 0;
      const cx = cellOf(p.x), cy = cellOf(p.y);
      for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) {
        const s = this.orbGrid.get(gkey(cx + i, cy + j)); if (!s) continue;
        for (const o of s) {
          const d = Math.hypot(o.x - p.x, o.y - p.y) + 30;
          const sc = o.v / d;
          if (sc > bs) { bs = sc; best = o; }
        }
      }
      ai.target = best ? [best.x, best.y] : this.randomPoint(WORLD_R * 0.7);
    }
    p.ta = Math.atan2(ai.target[1] - p.y, ai.target[0] - p.x);
    if (Math.hypot(ai.target[0] - p.x, ai.target[1] - p.y) < 25) ai.target = null;
    if (ai.boostT > 0) { ai.boostT--; p.boost = true; }
    else { p.boost = false; if (p.score > 50 && Math.random() < 0.004) ai.boostT = 20 + Math.random() * 40; }
  }

  manageBots() {
    let bots = 0, botList = [];
    for (const p of this.planes.values()) if (p.bot) { bots++; botList.push(p); }
    const want = Math.max(MIN_BOTS, BOT_FILL - this.humanCount());
    if (bots < want && this.tickN % 5 === 0) {
      this.addPlane(BOT_NAMES[(Math.random() * BOT_NAMES.length) | 0], (Math.random() * COLORS.length) | 0, null);
    } else if (bots > want && this.tickN % 30 === 0) {
      botList.sort((a, b) => a.score - b.score);
      this.planes.delete(botList[0].id);
    }
  }

  tick() {
    this.tickN++;
    this.deaths = [];
    this.manageBots();

    // AI + movement
    for (const p of this.planes.values()) {
      if (p.bot) this.botThink(p);
      let d = p.ta - p.a;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const tr = turnRate(p.score) * (p.boost ? 0.8 : 1);
      p.a += Math.max(-tr, Math.min(tr, d));
      const boosting = p.boost && p.score > 15;
      const spd = boosting ? BOOST_SPEED : SPEED;
      if (boosting) {
        p.score -= 0.15;
        if (this.tickN % 6 === 0) { const t0 = p.trail[0]; this.addOrb(t0[0], t0[1], 0.8, this.tickN + TICK_RATE * 30); }
      }
      p.x += Math.cos(p.a) * spd; p.y += Math.sin(p.a) * spd;
      p.x = r1(p.x); p.y = r1(p.y);
      const t = p.trail, l = t[t.length - 1];
      p.len += Math.hypot(p.x - l[0], p.y - l[1]);
      t.push([p.x, p.y]);
      const target = trailTarget(p.score);
      while (p.len > target && t.length > 2) { p.len -= Math.hypot(t[1][0] - t[0][0], t[1][1] - t[0][1]); t.shift(); }
      p.w = planeWidth(p.score);
    }

    // spatial grid of trail points + bounding boxes
    this.grid = new Map();
    for (const p of this.planes.values()) {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const pt of p.trail) {
        const k = gkey(cellOf(pt[0]), cellOf(pt[1]));
        let c = this.grid.get(k); if (!c) this.grid.set(k, c = []);
        c.push(p, pt[0], pt[1]);
        if (pt[0] < x0) x0 = pt[0]; if (pt[0] > x1) x1 = pt[0];
        if (pt[1] < y0) y0 = pt[1]; if (pt[1] > y1) y1 = pt[1];
      }
      p.bb = [x0 - p.w, y0 - p.w, x1 + p.w, y1 + p.w];
    }

    // collisions
    const dead = [];
    for (const p of this.planes.values()) {
      if (Math.hypot(p.x, p.y) > WORLD_R) { dead.push([p, null]); continue; }
      const hit = this.trailNear(p.x, p.y, p.w * 0.25, p);
      if (hit) dead.push([p, hit]);
    }
    for (const [p, k] of dead) this.kill(p, k);

    // orb pickup
    for (const p of this.planes.values()) {
      const rad = p.w * 0.8 + 22, cr = Math.ceil(rad / CELL), cx = cellOf(p.x), cy = cellOf(p.y);
      for (let i = -cr; i <= cr; i++) for (let j = -cr; j <= cr; j++) {
        const s = this.orbGrid.get(gkey(cx + i, cy + j)); if (!s) continue;
        for (const o of s) {
          const dx = o.x - p.x, dy = o.y - p.y;
          if (dx * dx + dy * dy < rad * rad) { p.score += o.v; this.removeOrb(o); }
        }
      }
    }

    // orb upkeep
    if (this.tickN % 30 === 0) for (const o of this.orbs.values()) if (o.ttl && o.ttl < this.tickN) this.removeOrb(o);
    for (let i = 0; i < 15 && this.natural < ORB_TARGET; i++) this.spawnNaturalOrb();

    // network
    for (const c of this.clients) this.sendState(c);
    if (this.tickN % 15 === 0) this.sendBoard();
  }

  sendState(c) {
    const me = c.plane;
    const cx = me ? me.x : c.cam[0], cy = me ? me.y : c.cam[1];
    const z = zoomFor(me ? me.score : (c.lastScore || 10));
    const hw = c.w / 2 * z + 250, hh = c.h / 2 * z + 250;
    const vx0 = cx - hw, vx1 = cx + hw, vy0 = cy - hh, vy1 = cy + hh;
    const msg = { t: 's', me: me ? me.id : 0 };
    const P = [], N = [], G = [], O = [], X = [], D = [];
    const seen = new Set();
    for (const p of this.planes.values()) {
      const b = p.bb;
      if (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1) continue;
      seen.add(p.id);
      if (!c.knownP.has(p.id)) {
        c.knownP.add(p.id);
        N.push([p.id, p.name, p.color, r1(p.score), r1(p.a), p.trail.flat()]);
      } else {
        P.push([p.id, p.x, p.y, Math.round(p.a * 100), r1(p.score), p.boost && p.score > 15 ? 1 : 0]);
      }
    }
    for (const id of c.knownP) if (!seen.has(id)) { c.knownP.delete(id); G.push(id); }

    const seenO = new Set();
    for (let i = cellOf(vx0); i <= cellOf(vx1); i++) for (let j = cellOf(vy0); j <= cellOf(vy1); j++) {
      const s = this.orbGrid.get(gkey(i, j)); if (!s) continue;
      for (const o of s) {
        seenO.add(o.id);
        if (!c.knownO.has(o.id)) { c.knownO.add(o.id); O.push([o.id, o.x, o.y, o.v, o.c]); }
      }
    }
    for (const id of c.knownO) if (!seenO.has(id)) { c.knownO.delete(id); X.push(id); }
    for (const d of this.deaths) if (d[0] > vx0 && d[0] < vx1 && d[1] > vy0 && d[1] < vy1) D.push(d);

    if (P.length) msg.p = P; if (N.length) msg.n = N; if (G.length) msg.g = G;
    if (O.length) msg.o = O; if (X.length) msg.x = X; if (D.length) msg.d = D;
    send(c, msg);
  }

  sendBoard() {
    const all = [...this.planes.values()].sort((a, b) => b.score - a.score);
    const top = all.slice(0, 10).map(p => [p.name, Math.floor(p.score), p.id]);
    const mm = all.map((p, i) => [Math.round(p.x / WORLD_R * 100), Math.round(p.y / WORLD_R * 100), i === 0 ? 1 : 0, p.id]);
    for (const c of this.clients) {
      const rank = c.plane ? all.indexOf(c.plane) + 1 : 0;
      send(c, { t: 'lb', top, mm, rank, n: all.length, online: totalOnline() });
    }
  }
}

// ---------- rooms & sockets ----------
const rooms = [new Room(0)];
let roomSeq = 1;
const totalOnline = () => rooms.reduce((a, r) => a + r.clients.size, 0);
function send(c, obj) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); }
function pickRoom() {
  let r = rooms.find(r => r.humanCount() < ROOM_HUMANS);
  if (!r) { r = new Room(roomSeq++); rooms.push(r); }
  return r;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain' };
const PUB = path.join(__dirname, 'public');
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/health') { res.end(JSON.stringify({ ok: true, online: totalOnline(), rooms: rooms.length })); return; }
  const file = path.normalize(path.join(PUB, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 512 });
wss.on('connection', ws => {
  const room = pickRoom();
  const c = { ws, room, plane: null, cam: [0, 0], w: 1280, h: 800, knownP: new Set(), knownO: new Set(), lastScore: 10 };
  room.clients.add(c);
  send(c, { t: 'welcome', R: WORLD_R, colors: COLORS, online: totalOnline() });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'in' && c.plane) {
      if (Number.isFinite(m.a)) c.plane.ta = m.a;
      c.plane.boost = !!m.b;
    } else if (m.t === 'view') {
      c.w = Math.max(320, Math.min(2560, +m.w || 1280)); c.h = Math.max(320, Math.min(1600, +m.h || 800));
    } else if (m.t === 'join' && !c.plane) {
      const name = String(m.name || '').replace(/[^\w \-.!?']/g, '').trim().slice(0, 16) || 'Pilot';
      c.plane = room.addPlane(name, Math.abs(m.c | 0), c);
    }
  });
  ws.on('close', () => {
    if (c.plane) room.planes.delete(c.plane.id);
    room.clients.delete(c);
    if (room.clients.size === 0 && room !== rooms[0]) rooms.splice(rooms.indexOf(room), 1);
  });
});

setInterval(() => { for (const r of rooms) r.tick(); }, 1000 / TICK_RATE);
server.listen(PORT, () => console.log(`Contrail.io running on http://localhost:${PORT}`));
