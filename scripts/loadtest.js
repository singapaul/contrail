'use strict';
// Load test: N bot clients join and fly randomly; prints bytes/s per client and the server's tick timing.
//   node scripts/loadtest.js [clients=50] [url=ws://localhost:3000] [seconds=30]
const WebSocket = require('ws');
const N = +(process.argv[2] || 50);
const URL = process.argv[3] || 'ws://localhost:3000';
const SECS = +(process.argv[4] || 30);
const HTTP = URL.replace(/^ws/, 'http');

let bytes = 0, open = 0, full = 0, deaths = 0, closedEarly = 0;
const socks = [];
for (let i = 0; i < N; i++) {
  setTimeout(() => {
    const ws = new WebSocket(URL, { headers: { 'X-Forwarded-For': `10.0.${(i >> 8) & 255}.${i & 255}` } });
    let u = 0, v = 0;
    const join = () => ws.send(JSON.stringify({ t: 'join', name: 'Load' + i, c: i }));
    ws.on('open', () => { open++; join(); });
    ws.on('message', raw => {
      bytes += raw.length;
      const s = raw.toString();
      if (s.startsWith('{"t":"dead"')) { deaths++; setTimeout(join, 1000); }
      else if (s.startsWith('{"t":"full"')) full++;
    });
    ws.on('close', () => { open--; closedEarly++; });
    const t = setInterval(() => {
      if (ws.readyState !== 1) return;
      if (Math.random() < 0.1) { u = Math.random() * 2 - 1; v = Math.random() * 1.2 - 0.6; }
      ws.send(JSON.stringify({ t: 'in', u: +u.toFixed(2), v: +v.toFixed(2), b: Math.random() < 0.05 ? 1 : 0 }));
    }, 50);
    socks.push([ws, t]);
  }, i * 40);   // ramp up
}

const t0 = Date.now(); let lastBytes = 0;
const rep = setInterval(async () => {
  const kbps = (bytes - lastBytes) / 1024 / 5; lastBytes = bytes;
  let h = {}; try { h = await (await fetch(HTTP + '/health')).json(); } catch {}
  const rooms = (h.rooms || []).map(r => `${r.id}:${r.seated}/${r.planes}`).join(' ');
  console.log(`t=${Math.round((Date.now() - t0) / 1000)}s open=${open} ${(kbps / Math.max(1, open)).toFixed(1)} KB/s/client` +
    ` tick avg=${h.tick?.avgMs}ms max=${h.tick?.maxMs}ms rooms[id:seated/planes]=${rooms} full=${full} deaths=${deaths}`);
  if (Date.now() - t0 > SECS * 1000) {
    clearInterval(rep);
    for (const [ws, t] of socks) { clearInterval(t); ws.close(); }
    setTimeout(() => process.exit(0), 300);
  }
}, 5000);
