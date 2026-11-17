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
| `ROOM_HUMANS` | 50 | Real players per arena before a new arena opens automatically |

## Launch (about 30 minutes)

1. **Host:** It's one Node process with no database. It works on Render, Railway, Fly.io, or any $5–10/month VPS (Hetzner, DigitalOcean). WebSockets must be allowed. All of these support them.
2. **Domain:** Buy a short `.io` domain and put Cloudflare in front of it for free HTTPS (`wss://` works automatically).
3. **Capacity:** One small VPS has been load-tested at about 45 players and about 13 KB/s per player at about 10% of one CPU core. Arenas split automatically. For thousands of players at once, run one process per region and let players pick the nearest.

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
