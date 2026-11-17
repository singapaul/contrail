# Contrail.io ✈️ (3D)

**A low-poly 3D dogfight game in the browser.** You fly a little prop plane over an ocean with mountain islands. Your plane leaves a solid contrail tube behind it. Any pilot who flies into it goes down, and their contrail turns into fuel. Collect fuel to make your contrail longer. Boost burns length. Watch out for the sea, the mountains, the storm wall at the edge of the map and the service ceiling.

**How it differs from slither.io:** full 3D flight with altitude (you can climb over or dive under a contrail), terrain you can crash into, a chase camera, and a flight-sim style HUD (pitch ladder, speed/altitude boxes, heading tape, heading-up radar, PULL UP / CONTRAIL PROXIMITY warnings). Bots hunt by trying to cut across in front of you.

**Controls:** the mouse is a flight stick: left/right turns and up/down climbs or dives. There's an optional "flight-sim" inverted Y. WASD/arrows also work. Hold click, Space or Shift to boost. On phones you drag to steer and use the BOOST button.

The earlier 2D version is kept in `legacy-2d/`.

## Run it locally

```bash
npm install
npm start          # http://localhost:3000   (PORT=4321 npm start if 3000 is taken)
```

Open a couple of browser tabs to see the multiplayer working.

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP/WebSocket port |
| `BOT_FILL` | 30 | Bots top each arena up to this many planes |
| `MIN_BOTS` | 8 | Bots that always stay in an arena |
| `ROOM_HUMANS` | 50 | Players per arena before a new arena opens automatically (menu tabs don't count) |
| `MAX_ROOMS` | 2 | Arenas per process. When all are full, new players see "Servers are full" and retry by themselves |
| `MAX_PER_IP` | 8 | WebSocket connections allowed per IP |
| `TRUST_PROXY` | off | Set to `1` behind Cloudflare/Caddy so the real client IP is read from `CF-Connecting-IP` / `X-Forwarded-For` |
| `ALLOWED_ORIGINS` | (any) | Comma-separated origins allowed to open a WebSocket, e.g. `https://contrail.io` |

## Launch on a Hetzner VPS (about 30 minutes)

It's one long-running Node process holding WebSockets, so it needs a server, not static/serverless hosting (Netlify/Vercel won't work).

1. **Server:** create a Hetzner **CX22** (Ubuntu 24.04, ~€5/month, 20 TB traffic included) with your SSH key.
2. **Domain + Cloudflare:** buy the domain, add it to Cloudflare, create an `A` record to the server IP (proxied, orange cloud) and set SSL/TLS mode to **Full (strict)**.
3. **Set up the box (once):**
   ```bash
   ssh root@SERVER_IP 'bash -s' < deploy/setup.sh play.yourdomain.io
   ```
   This installs Node 22, Caddy (automatic HTTPS) and the `contrail` systemd service, and opens ports 22/80/443.
4. **Check:** `curl https://play.yourdomain.io/health` shows each arena's seated players and the tick time.
5. **Deploy updates:** `./deploy/deploy.sh root@SERVER_IP` (git pull + restart). Players see "Server updating" and reconnect by themselves.

**Capacity** (load test, `node scripts/loadtest.js 50`): about **40 KB/s per player** (a full 50-player arena ≈ 16 Mbps, ≈ 5 TB/month if full all day). One full arena takes ~10 ms of the 33 ms tick budget on an M3 Pro; 4 full arenas overloaded it. So `MAX_ROOMS=2` by default; re-run the load test on the real server and raise it only while `/health` `tick.maxMs` stays under ~20 ms. Beyond that, run more servers/regions.

## Making money

| Stream | How | Notes |
|---|---|---|
| **Game portals (best first step)** | Submit to **CrazyGames**, **Poki**, GameDistribution, itch.io | They bring the traffic and share ad revenue with you. Add their SDK (midgame ad on death, rewarded ads). The `onDead()` hook and `#adSlot` are already marked in `public/index.html`. |
| **Ads on your own site** | AdinPlay (made for .io games), Google AdSense/AdSense for Games | Show a 300×250 on the death screen and a pre-roll before the first spawn. |
| **Rewarded video** | "Watch an ad → start with 50 fuel" or "→ unlock this skin for 24h" | Usually the highest earner per user. Players choose to watch. |
| **Cosmetics** | Plane skins, coloured smoke, trail effects, name badges | One-off purchases via Stripe/Paddle. Never sell gameplay advantages, because that kills io games. |
| **Sponsorship** | Branded skin or map event once you have traffic | |

Realistically, io-game income comes from volume. Ads earn very little per view. Portals give you distribution, and the game has to be "one more go" fun to hold players. Get it on portals first, watch average session length, then tune.

## Roadmap ideas (by impact)

1. Portal SDK + rewarded "revive / head start"
2. Skins shop + accounts (Google sign-in) + daily leaderboard
3. Power-ups: missile (cuts a trail), shield (survive one hit), magnet
4. Team mode (red vs blue) and party links ("play with friends")
5. Binary protocol (msgpack) and multi-region servers for scale

## Files

- `server.js`: the server runs all game logic (physics, collisions, bots, spatial hashing, interest management, auto-sharded arenas)
- `public/index.html`: the three.js client (low-poly world, contrail tubes, instanced fuel orbs, chase camera, flight HUD, death screen with ad slot)
- `public/vendor/`: three.js r187, included in the project so nothing loads from a CDN
