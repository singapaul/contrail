'use strict';
// Contrail — 3D multiplayer server (Node.js + ws)
// Run: npm install && npm start   →  http://localhost:3000   (PORT=4321 npm start to change port)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30;
const WORLD_R = 3000;          // arena radius (storm wall beyond)
const CEIL = 340;              // service ceiling
const ORB_TARGET = 1400;
const ROOM_HUMANS = +(process.env.ROOM_HUMANS || 50);
const BOT_FILL = +(process.env.BOT_FILL ?? 30);
const MIN_BOTS = +(process.env.MIN_BOTS ?? 8);
const CELL = 100;
const VIEW = 1900;             // interest radius (client fog hides beyond ~1800)
const SPEED = 5.6, BOOST_SPEED = 10.5;

const COLORS = ['#ff4d4d', '#ffb020', '#ffe14d', '#4dff88', '#2ee6d6', '#4da6ff', '#a066ff', '#ff66c4', '#ffffff', '#ff8a3d'];
const BOT_NAMES = ['Maverick', 'Goose', 'Iceman', 'Viper', 'Red Baron', 'Skyfox', 'Ace', 'Falcon', 'Nova', 'Blaze',
  'Hawkeye', 'Phantom', 'Raptor', 'Jet', 'Comet', 'Zephyr', 'Storm', 'Cobra', 'Talon', 'Ghost', 'Sparrow', 'Bandit',
  'Rookie', 'Skipper', 'Wingnut', 'Loop', 'Barrel', 'Kite', 'Orbit', 'Flak', 'Pixel', 'Cirrus', 'Nimbus', 'Gale'];

// Shared formulas (mirrored in the client)
const trailTarget = s => Math.min(7000, 160 + s * 3);
const planeWidth = s => 16 + Math.min(34, Math.sqrt(s) * 1.1);
const turnRate = s => 0.085 * (1 - Math.min(0.45, s / 6000));

const gkey = (cx, cy) => ((cx + 512) << 10) | (cy + 512);
const cellOf = v => Math.floor(v / CELL);
const r1 = v => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// ---------- terrain: deterministic low-poly mountains ----------
function makeIslands(seed) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = [];
  while (out.length < 16) {
    const a = rnd() * Math.PI * 2, d = 500 + Math.sqrt(rnd()) * (WORLD_R - 700);
    const x = Math.cos(a) * d, y = Math.sin(a) * d, r = 160 + rnd() * 260, h = 80 + rnd() * 200;
    if (out.some(o => Math.hypot(o[0] - x, o[1] - y) < o[2] + r + 120)) continue;
    out.push([Math.round(x), Math.round(y), Math.round(r), Math.round(h)]);
  }
  return out;
}
const ISLANDS = makeIslands(424242);
function terrainH(x, y) {
  let m = 0;
  for (const [ix, iy, r, h] of ISLANDS) {
    const rc = r * 0.92, d = Math.hypot(x - ix, y - iy);
    if (d < rc) m = Math.max(m, h * (1 - d / rc));
  }
  return m;
}

class Room {
  constructor(id) {
    this.id = id;
    this.planes = new Map(); this.orbs = new Map(); this.orbGrid = new Map(); this.grid = new Map();
    this.clients = new Set();
    this.nextId = 1; this.nextOrb = 1; this.tickN = 0; this.natural = 0; this.deaths = [];
    while (this.natural < ORB_TARGET) this.spawnNaturalOrb();
  }

  // ---------- orbs ----------
  addOrb(x, y, h, v, ttl = 0) {
    const o = { id: this.nextOrb++, x: r1(x), y: r1(y), h: r1(h), v, c: (Math.random() * COLORS.length) | 0, ttl };
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
    const [x, y] = this.randomPoint(WORLD_R - 80);
    const g = terrainH(x, y) + 25;
    this.addOrb(x, y, g + Math.random() * Math.max(10, CEIL - 50 - g), [1, 1, 1, 2, 3][(Math.random() * 5) | 0]);
  }

  // ---------- planes ----------
  trailNear(x, y, h, r, self) {
    const cx = cellOf(x), cy = cellOf(y);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const c = this.grid.get(gkey(cx + i, cy + j)); if (!c) continue;
      for (let k = 0; k < c.length; k += 4) {
        const p = c[k]; if (p === self || !p.alive) continue;
        const rr = r + p.w / 2, dx = c[k + 1] - x, dy = c[k + 2] - y, dh = c[k + 3] - h;
        if (dx * dx + dy * dy + dh * dh < rr * rr) return p;
      }
    }
    return null;
  }
  addPlane(name, colorIdx, client) {
    let best = null, bestD = -1;
    for (let i = 0; i < 14; i++) {
      const [x, y] = this.randomPoint(WORLD_R * 0.75);
      if (terrainH(x, y) > 0 || this.trailNear(x, y, 140, 200, null)) continue;
      let d = 1e9;
      for (const p of this.planes.values()) d = Math.min(d, Math.hypot(p.x - x, p.y - y));
      if (d > bestD) { bestD = d; best = [x, y]; }
    }
    if (!best) best = this.randomPoint(WORLD_R * 0.5);
    const [x, y] = best, h = 120 + Math.random() * 60;
    const a = Math.atan2(-y, -x) + (Math.random() - 0.5);
    const p = {
      id: this.nextId++, name, color: COLORS[colorIdx % COLORS.length], bot: !client, client,
      x, y, h, a, pitch: 0, roll: 0, tu: 0, pv: 0, boost: false, score: 10, w: planeWidth(10),
      trail: [[x, y, h]], len: 0, alive: true, kills: 0, born: Date.now(),
      ai: client ? null : { target: null, skill: 0.6 + Math.random() * 0.37, boostT: 0, hunt: null, huntT: 0 },
    };
    this.planes.set(p.id, p);
    return p;
  }
  humanCount() { return this.clients.size; }

  kill(p, killer, cause) {
    if (!p.alive) return;
    p.alive = false;
    const t = p.trail, total = Math.max(5, p.score * 0.75);
    const count = Math.min(150, Math.max(6, Math.floor(t.length / 2)));
    const step = t.length / count, ci = COLORS.indexOf(p.color);
    for (let i = 0; i < count; i++) {
      const pt = t[Math.min(t.length - 1, Math.floor(i * step))];
      const j = () => (Math.random() - 0.5) * 24;
      const o = this.addOrb(pt[0] + j(), pt[1] + j(), Math.max(terrainH(pt[0], pt[1]) + 8, pt[2] + j()),
        r1(Math.max(1, total / count)), this.tickN + TICK_RATE * 45);
      o.c = ci;
    }
    this.deaths.push([Math.round(p.x), Math.round(p.y), Math.round(p.h), ci]);
    const msg = killer ? `${killer.name} shot down ${p.name}` : `${p.name} ${cause}`;
    if (killer) { killer.kills++; if (killer.client) send(killer.client, { t: 'kill', name: p.name }); }
    if (p.score > 60 || !p.bot || (killer && !killer.bot)) for (const c of this.clients) send(c, { t: 'k', m: msg });
    if (p.client) {
      const c = p.client;
      c.plane = null; c.cam = [p.x, p.y];
      send(c, { t: 'dead', score: Math.floor(p.score), kills: p.kills, by: killer ? killer.name : null, cause,
        secs: Math.round((Date.now() - p.born) / 1000) });
    }
    this.planes.delete(p.id);
  }

  botThink(p) {
    const ai = p.ai;
    let tx, ty, th, forceA = null;
    if (Math.hypot(p.x, p.y) > WORLD_R - 420) forceA = Math.atan2(-p.y, -p.x);

    // obstacle avoidance (trails + terrain + sea)
    if (Math.random() < ai.skill) {
      const look = 55 + p.w * 2;
      const danger = (ang, pit) => {
        let s = 0;
        for (const d of [look * 0.5, look, look * 1.8]) {
          const x = p.x + Math.cos(ang) * Math.cos(pit) * d, y = p.y + Math.sin(ang) * Math.cos(pit) * d, h = p.h + Math.sin(pit) * d;
          if (h < terrainH(x, y) + 14 || this.trailNear(x, y, h, p.w * 0.5, p)) s++;
        }
        return s;
      };
      if (danger(p.a, p.pitch) > 0) {
        const opts = [[-1, p.pv], [1, p.pv], [p.tu, 1], [p.tu, -1]];
        let best = opts[0], bs = 99;
        for (const [u, v] of opts) {
          const sc = danger(p.a + u * 0.9, clamp(p.pitch + v * 0.5, -0.7, 0.7)) + (v < 0 && p.h < 70 ? 2 : 0);
          if (sc < bs) { bs = sc; best = [u, v]; }
        }
        p.tu = best[0]; p.pv = best[1]; p.boost = false; ai.target = null;
        return;
      }
    }

    // hunting: try to cut in front of a nearby plane
    if (ai.huntT > 0) {
      const q = this.planes.get(ai.hunt);
      if (q && q.alive) {
        const lead = 110 + q.w * 3;
        tx = q.x + Math.cos(q.a) * lead; ty = q.y + Math.sin(q.a) * lead; th = q.h; ai.huntT--;
        const dist = Math.hypot(q.x - p.x, q.y - p.y);
        p.boost = dist > 140 && dist < 600 && p.score > 35;
      } else ai.huntT = 0;
    } else if (p.score > 25 && (this.tickN + p.id) % 15 === 0 && Math.random() < 0.35) {
      for (const q of this.planes.values()) {
        if (q === p || Math.hypot(q.x - p.x, q.y - p.y) > 550 || Math.abs(q.h - p.h) > 120) continue;
        ai.hunt = q.id; ai.huntT = 60 + Math.random() * 60; break;
      }
    }

    if (tx === undefined) {
      if (!ai.target || (this.tickN + p.id) % 10 === 0) {
        let best = null, bs = 0;
        const cx = cellOf(p.x), cy = cellOf(p.y);
        for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) {
          const s = this.orbGrid.get(gkey(cx + i, cy + j)); if (!s) continue;
          for (const o of s) {
            const d = Math.hypot(o.x - p.x, o.y - p.y, (o.h - p.h) * 1.5) + 30;
            if (o.v / d > bs) { bs = o.v / d; best = o; }
          }
        }
        if (best) ai.target = [best.x, best.y, best.h];
        else { const [x, y] = this.randomPoint(WORLD_R * 0.7); ai.target = [x, y, 100 + Math.random() * 150]; }
      }
      [tx, ty, th] = ai.target;
      if (Math.hypot(tx - p.x, ty - p.y) < 30) ai.target = null;
      if (ai.boostT > 0) { ai.boostT--; p.boost = true; }
      else { p.boost = false; if (p.score > 50 && Math.random() < 0.004) ai.boostT = 20 + Math.random() * 40; }
    }

    const ang = forceA ?? Math.atan2(ty - p.y, tx - p.x);
    p.tu = clamp(wrap(ang - p.a) / 0.3, -1, 1);
    let dp = Math.atan2(th - p.h, Math.max(40, Math.hypot(tx - p.x, ty - p.y)));
    if (p.h < 60) dp = 0.5; else if (p.h > CEIL - 40) dp = -0.4;
    p.pv = clamp(dp / 0.7, -1, 1);
  }

  manageBots() {
    const bots = [...this.planes.values()].filter(p => p.bot);
    const want = Math.max(MIN_BOTS, BOT_FILL - this.humanCount());
    if (bots.length < want && this.tickN % 5 === 0) {
      this.addPlane(BOT_NAMES[(Math.random() * BOT_NAMES.length) | 0], (Math.random() * COLORS.length) | 0, null);
    } else if (bots.length > want && this.tickN % 30 === 0) {
      bots.sort((a, b) => a.score - b.score);
      this.planes.delete(bots[0].id);
    }
  }

  tick() {
    this.tickN++;
    this.deaths = [];
    this.manageBots();

    for (const p of this.planes.values()) {
      if (p.bot) this.botThink(p);
      const boosting = p.boost && p.score > 15;
      p.a = wrap(p.a + p.tu * turnRate(p.score) * (boosting ? 0.8 : 1));
      p.pitch += clamp(p.pv * 0.7 - p.pitch, -0.05, 0.05);
      if (p.h > CEIL - 25 && p.pitch > 0) p.pitch = Math.max(-0.3, p.pitch - 0.08);  // ceiling pushes the nose down
      p.roll += (p.tu * 0.9 - p.roll) * 0.2;
      const spd = boosting ? BOOST_SPEED : SPEED;
      if (boosting) {
        p.score -= 0.15;
        if (this.tickN % 6 === 0) { const t0 = p.trail[0]; this.addOrb(t0[0], t0[1], t0[2], 0.8, this.tickN + TICK_RATE * 30); }
      }
      p.x = r1(p.x + Math.cos(p.a) * Math.cos(p.pitch) * spd);
      p.y = r1(p.y + Math.sin(p.a) * Math.cos(p.pitch) * spd);
      p.h = r1(Math.min(CEIL, p.h + Math.sin(p.pitch) * spd));
      const t = p.trail, l = t[t.length - 1];
      p.len += Math.hypot(p.x - l[0], p.y - l[1], p.h - l[2]);
      t.push([p.x, p.y, p.h]);
      const target = trailTarget(p.score);
      while (p.len > target && t.length > 2) { p.len -= Math.hypot(t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]); t.shift(); }
      p.w = planeWidth(p.score);
    }

    // spatial grid of trail points + bounding boxes
    this.grid = new Map();
    for (const p of this.planes.values()) {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const pt of p.trail) {
        const k = gkey(cellOf(pt[0]), cellOf(pt[1]));
        let c = this.grid.get(k); if (!c) this.grid.set(k, c = []);
        c.push(p, pt[0], pt[1], pt[2]);
        if (pt[0] < x0) x0 = pt[0]; if (pt[0] > x1) x1 = pt[0];
        if (pt[1] < y0) y0 = pt[1]; if (pt[1] > y1) y1 = pt[1];
      }
      p.bb = [x0 - p.w, y0 - p.w, x1 + p.w, y1 + p.w];
    }

    // collisions
    const dead = [];
    for (const p of this.planes.values()) {
      if (Math.hypot(p.x, p.y) > WORLD_R) { dead.push([p, null, 'flew into the storm']); continue; }
      const g = terrainH(p.x, p.y);
      if (p.h < g + 3) { dead.push([p, null, g > 0 ? 'hit a mountain' : 'crashed into the sea']); continue; }
      const hit = this.trailNear(p.x, p.y, p.h, p.w * 0.45, p);
      if (hit) dead.push([p, hit, '']);
    }
    for (const [p, k, cause] of dead) this.kill(p, k, cause);

    // orb pickup
    for (const p of this.planes.values()) {
      const rad = p.w * 0.9 + 18, cr = Math.ceil(rad / CELL), cx = cellOf(p.x), cy = cellOf(p.y);
      for (let i = -cr; i <= cr; i++) for (let j = -cr; j <= cr; j++) {
        const s = this.orbGrid.get(gkey(cx + i, cy + j)); if (!s) continue;
        for (const o of s) {
          const dx = o.x - p.x, dy = o.y - p.y, dh = o.h - p.h;
          if (dx * dx + dy * dy + dh * dh < rad * rad) { p.score += o.v; this.removeOrb(o); }
        }
      }
    }

    if (this.tickN % 30 === 0) for (const o of this.orbs.values()) if (o.ttl && o.ttl < this.tickN) this.removeOrb(o);
    for (let i = 0; i < 15 && this.natural < ORB_TARGET; i++) this.spawnNaturalOrb();

    for (const c of this.clients) this.sendState(c);
    if (this.tickN % 15 === 0) this.sendBoard();
  }

  sendState(c) {
    const me = c.plane;
    const cx = me ? me.x : c.cam[0], cy = me ? me.y : c.cam[1];
    const vx0 = cx - VIEW, vx1 = cx + VIEW, vy0 = cy - VIEW, vy1 = cy + VIEW;
    const msg = { t: 's', me: me ? me.id : 0 };
    const P = [], N = [], G = [], O = [], X = [], D = [];
    const seen = new Set();
    for (const p of this.planes.values()) {
      const b = p.bb;
      if (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1) continue;
      seen.add(p.id);
      if (!c.knownP.has(p.id)) {
        c.knownP.add(p.id);
        N.push([p.id, p.name, p.color, r1(p.score), Math.round(p.a * 100), Math.round(p.pitch * 100), p.trail.flat()]);
      } else {
        P.push([p.id, p.x, p.y, p.h, Math.round(p.a * 100), Math.round(p.pitch * 100), Math.round(p.roll * 100), r1(p.score), p.boost && p.score > 15 ? 1 : 0]);
      }
    }
    for (const id of c.knownP) if (!seen.has(id)) { c.knownP.delete(id); G.push(id); }

    const seenO = new Set();
    for (let i = cellOf(vx0); i <= cellOf(vx1); i++) for (let j = cellOf(vy0); j <= cellOf(vy1); j++) {
      const s = this.orbGrid.get(gkey(i, j)); if (!s) continue;
      for (const o of s) {
        seenO.add(o.id);
        if (!c.knownO.has(o.id)) { c.knownO.add(o.id); O.push([o.id, o.x, o.y, o.h, o.v, o.c]); }
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
      send(c, { t: 'lb', top, mm, rank: c.plane ? all.indexOf(c.plane) + 1 : 0, n: all.length });
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

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
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
  const c = { ws, room, plane: null, cam: [0, 0], knownP: new Set(), knownO: new Set() };
  room.clients.add(c);
  send(c, { t: 'welcome', R: WORLD_R, CEIL, islands: ISLANDS, colors: COLORS });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'in' && c.plane) {
      if (Number.isFinite(m.u)) c.plane.tu = clamp(m.u, -1, 1);
      if (Number.isFinite(m.v)) c.plane.pv = clamp(m.v, -1, 1);
      c.plane.boost = !!m.b;
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
server.listen(PORT, () => console.log(`Contrail running on http://localhost:${PORT}`));
