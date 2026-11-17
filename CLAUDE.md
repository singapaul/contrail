# Contrail.io — project context for Claude Code

3D multiplayer browser game (slither.io-style loop, but with planes). You fly a low-poly plane, it leaves a contrail tube,
anyone who flies into your contrail crashes and drops fuel orbs, and collecting fuel lengthens your contrail.

## Run
```bash
PORT=4321 npm start      # port 3000 is used by something else on this machine
open http://localhost:4321   # open two tabs to test multiplayer
```
The only dependency is `ws`. three.js r187 is included in `public/vendor/` (no CDN, no build step).

## Architecture
- `server.js`: Node `http` + `ws`. **The server runs all game logic** (clients only send inputs).
  - 30 Hz tick loop. Each `Room` holds up to `ROOM_HUMANS` (50) seated players, up to `MAX_ROOMS` (2) rooms per process.
    A seat = flying, or died less than 30 s ago (`isSeated`). New sockets spectate the busiest room without a seat; on `join`
    the player keeps their current room if it has a seat, else `pickRoom` picks the fullest room with space (or opens one),
    else sends `full`. Moving rooms sends `reset`.
  - Production guards: ping/pong heartbeat (15 s), backpressure (skip state when `bufferedAmount` > 256 KB, kill when
    > 1 MB for 5 s), `MAX_PER_IP`, `ALLOWED_ORIGINS`, 60 msgs/s input cap, name blocklist (`cleanName`), graceful
    SIGTERM (`restart` then close 4503), per-room try/catch in the tick loop, tick timing in `/health`.
  - Bots top each room up to `BOT_FILL` (30) planes and leave as humans join (`manageBots`). Bot AI is in `botThink`
    (avoids obstacles, collects orbs, hunts by cutting in front of other planes).
  - Spatial hash grid (`CELL`=100) of contrail points, used for collisions, and of orbs, used for pickups.
  - Interest management: each client only receives planes and orbs within `VIEW` (1900) of them. New planes are sent
    with their full contrail once, then just head positions each tick, and the client rebuilds the contrail itself.
  - Terrain: `ISLANDS` (fixed seed) cone mountains, sent in `welcome`. `terrainH()` is used for crashes.
- `public/index.html`: a single-file ES-module client. Low-poly world, `Tube` class (dynamic BufferGeometry contrail),
  instanced orbs, chase camera, flight-sim HUD on a 2D canvas overlay, menu and death screen (ad slot + `onDead` hook).
- `legacy-2d/`: the original 2D version, kept for reference only (it won't run where it is).

### Coordinates
Server uses (x, y, h), where h = altitude. three.js uses (x, h, y). Heading `a` is in the server's x/y plane. The plane model faces +x
with `rotation.order='YZX'`, `rotation = (roll, -a, pitch)`.

### Protocol (JSON over WebSocket)
- client→server: `{t:'join', name, c}`, `{t:'in', u: turn -1..1, v: pitch -1..1, b: boost 0/1}`
- server→client: `welcome {R, CEIL, islands, colors}`; every tick `s {me, p:[[id,x,y,h,a*100,pitch*100,roll*100,score,boost]],
  n:[[id,name,color,score,a*100,pitch*100,flatTrail]], g:[goneIds], o:[[id,x,y,h,v,c]], x:[eatenOrbIds], d:[[x,y,h,c]]}`;
  `lb` (leaderboard, twice a second), `k` (kill feed), `kill`, `dead`, `full` (every room full; client retries in 10 s),
  `reset` (moved to another room: drop planes/orbs), `restart` (server shutting down).
- WebSocket close codes 4xxx carry a reason the client shows: 4029 too many per IP, 4003 bad origin, 4503 restarting.
  The client reconnects after 10 s for 4xxx (1.5 s for 4503 and normal drops).

### IMPORTANT: shared formulas
`trailTarget`, `planeWidth` and the trail trimming logic exist in BOTH server.js and index.html. They must stay identical,
because the client rebuilds contrails from head positions.

## Next features (requested by Paul)

### 1. Plane skins
- Add `skin` to `join` → store it on the plane → include it in `n` entries → client `makePlane(color, skin)`.
- Starter set of low-poly models built from primitives like the current one: `prop` (current), `jet` (swept delta wing,
  no propeller, afterburner glow), `biplane` (two wings + struts), `seaplane` (floats), `stealth` (flat dark wedge).
- Skins also set the contrail look: colour/gradient, and later sparkles or rainbow effects.
- Menu skin picker with a rotating 3D preview. Save the choice in localStorage for now.
- Unlocks: some free, some unlocked by score milestones ("reach 500"), some by watching a rewarded ad (portal SDK),
  later paid via Stripe/Paddle with accounts. **Cosmetic only, never any gameplay advantage.**
  Keep collision size identical for every skin.

### 2. Fly-through rings ("loops") + sponsored rings
- Server-side `rings` per room: `{id, x, y, h, yaw, radius, value, sponsor?, expiresAt}`. Send them in `welcome`/state
  (there are few of them, so broadcast to everyone).
- Detection on the server: each tick, check whether the plane's movement since the previous tick crossed the ring's plane
  at a point within `radius` of its centre. Award `value` score, plus a streak combo for consecutive rings within N seconds.
- Normal rings: chains/courses of 5–8 rings around the mountains and through valleys. They respawn after use (per player
  cooldown so they can't be farmed).
- **Sponsored "Golden Ring" events**: every few minutes a big ring spawns somewhere with a big bonus (e.g. +150) and a
  60–90s timer. Announce it to everyone ("🏆 Golden Ring by <Sponsor> just appeared!"), with a marker on the radar/HUD
  and an arrow at the screen edge. Everyone rushes there, which creates natural dogfights. Sponsor name/logo shown on
  the ring (CanvasTexture banner) and in the announcement.
- `sponsors.json` config: `{name, logoUrl, colour, weight, startDate, endDate}`. Record impressions
  (players who saw the ring on screen), fly-throughs and players in the room, so you can give the sponsor a report.
- Client: torus mesh (low-poly `TorusGeometry(r, tube, 6, 24)`), pulsing glow, "+150 RING!" popup, combo counter.

## Monetisation plan (full)
Guiding rule: **cosmetic and optional only. Never sell gameplay advantages** (that kills io games). Ads pay very little per view,
so income depends on lots of players coming back. Track average session length and how many players return the next day and the next week.

1. **Distribution via game portals (first priority):** CrazyGames, Poki, GameDistribution, itch.io. They bring the players
   and share ad revenue (roughly 50–70% to the developer through their SDK). Integrate their SDK: `gameplayStart`/`gameplayStop`,
   a midgame ad in `onDead()` (rate-limited, e.g. at most once every 3 minutes), and rewarded ads. A 3D look improves the chance of being featured.
2. **Rewarded video:** usually the highest earner per user. Players choose to watch. Ideas: respawn with +50 fuel,
   try a skin for 24h, double the score from the next Golden Ring. Always optional, with a clear button on the death screen/menu.
3. **Ads between rounds on our own domain:** AdinPlay (made for .io games) or AdSense for Games. A 300×250 on the death screen
   (`#adSlot` already exists) and a pre-roll before the first spawn. Never during flight.
4. **Cosmetics shop:** plane skins, contrail colours and effects (rainbow, sparkle, fire), name badges, victory explosions.
   One-off purchases via Stripe/Paddle (needs accounts: Google sign-in + a small DB). Possible "Pilot Pass" season with free and paid tracks.
   On portals, use the portal's own in-game purchase system if it has one.
5. **Sponsored Golden Rings / events:** see feature 2 above. Sell timed sponsorships (brand name and logo on the ring and in the
   announcement, plus an optional branded skin). The server records impressions, fly-throughs and players present, which go in a sponsor report.
   This is only worth selling once there's steady traffic, so build the setup now and sell later.
6. **Later:** branded map events, YouTuber/streamer custom skins with revenue share, private room links for groups or schools.

Order to build in: portal SDK + rewarded respawn → skins (free/milestone/ad-unlock) → rings → accounts + paid cosmetics → sponsorship sales.
Keep the README's "Making money" section in step with this.

### Later
Accounts and a daily leaderboard, party links (play with friends in the same room), team mode, power-ups
(missile, shield, magnet), msgpack protocol, a region picker/matchmaker for running multiple servers, CrazyGames/Poki SDK.

## Testing
Playwright is a good way to check visuals: launch Chromium with
`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` for WebGL, click #playBtn, take screenshots.
Load test: `TRUST_PROXY=1 PORT=4321 npm start`, then `node scripts/loadtest.js 50 ws://localhost:4321 30` (it fakes
`X-Forwarded-For` per client to get past `MAX_PER_IP`, so the server needs `TRUST_PROXY=1`).
Measured 2026-11-17 on an M3 Pro (load-test clients on the same machine): ~40 KB/s per client at every size;
50 clients = 1 room, tick avg 10 ms / max 34 ms, 35% CPU; 100 = 2 rooms, avg 12 ms; 200 = 4 rooms, avg 25 ms / max 103 ms
(overloaded). Re-measure on the production VPS before raising `MAX_ROOMS`.
Deploy: Hetzner + Caddy + Cloudflare, files in `deploy/` (see README "Launch").
