# The Hunt (Level 0)

4 survivors vs 1 Entity in a procedurally generated Backrooms Level 0.
Play offline against bots, or online with friends (empty slots fill with bots).

## Run it on your computer

You need [Node.js](https://nodejs.org) (the LTS version). In a terminal, go into this folder
(`cd the-hunt`) and run:

```bash
npm install          # once
```

Then open **two terminals** in this folder:

```bash
npm run server       # terminal 1: the game server on ws://localhost:2567
npm run dev          # terminal 2: the game at http://localhost:5173
```

Open http://localhost:5173 in two browser windows, pick **Online**, type the
same room number in both, ready up, and you're playing each other.
(Offline mode works without the server.)

## Folders

```
shared/              code the browser AND the server both run
  sim.js             the round: bots, attacks, vents, sanity, blackouts, timer, win check
  config.js          every balance number (speeds, cooldowns, round times)
  mapgen.js          the map generator + pathfinding
  physics.js         wall collision and line of sight
  anomalies.js       per-round anomalies
  rng.js             seeded random numbers (same seed = same result everywhere)
  roster.js          bot names, username rules, GAME_VERSION
server/              the online game server (Colyseus)
  GameRoom.js        one room: lobby, host controls, runs the round 30x a second
  index.js           starts the server
client/              the browser game
  src/game.js        graphics, sound, input, menus, lobby
  src/net.js         connection to the server
test/
  balance.mjs        bot-vs-bot win rates (npm run balance)
  protocol.mjs       2-player server check (npm run test:server, server must be running)
```

### How online works

The server is the referee. It runs `shared/sim.js` for each room: it decides
hits, catches, vents, the timer and who wins. Your own movement shows up on
your screen instantly, and the server checks every move (speed and walls) and
snaps you back if it's impossible. Everyone builds the same map from the room
number, so only positions and events travel over the network.

If a player disconnects mid-round, a bot takes over their character.

## Common edits

- **Balance:** edit `shared/config.js`, then `npm run balance` to see win rates.
- **Round length per map size:** `ROUND_TIME` in `shared/config.js`.
- **New anomaly:** add to `ANOMALIES` in `shared/anomalies.js`.
- **Changed anything in `shared/` or `server/`?** Bump `GAME_VERSION` in
  `shared/roster.js` so players with an old tab open get told to refresh.

## Put it online (once)

You need two hosts: one for the **game page** (static files) and one for the
**server** (a Node process that stays running). Both can deploy straight from
GitHub.

1. The code is in the `the-hunt` folder of the `Games` repo, so on **both** hosts
   set **Root directory** to `the-hunt`.
2. **Server host** (any host that runs Node and allows WebSockets, e.g. Render,
   Railway or Fly.io):
   - Root directory: `the-hunt`
   - Build command: `npm install`
   - Start command: `npm start`
   - The host gives you a URL like `https://level0-server.example.com`.
     Your server address is the same with **`wss://`** in front:
     `wss://level0-server.example.com`
3. **Game page host** (any static host, e.g. Cloudflare Pages, Netlify, Vercel):
   - Root directory: `the-hunt`
   - Build command: `npm run build`
   - Output folder: `dist`
   - Environment variable: `VITE_SERVER_URL` = your `wss://...` server address
4. Open the game page's URL, pick Online, and share room numbers with friends.

## Updating after that

1. Make the change, test it locally (`npm run server` + `npm run dev`).
2. Bump `GAME_VERSION` in `shared/roster.js` if you touched `shared/` or `server/`.
3. `git push`. Both hosts rebuild and redeploy on their own in about a minute.

Pushing restarts the server, which ends any round in progress, so push when
nobody's mid-game. Try risky changes on a separate branch first: most hosts
give each branch its own preview URL.

## Debugging

Add `?debug` to the URL (always on with `npm run dev`) to reach the game from
the browser console, e.g. `G.monster.pos`, `startGame('1234')`.
Add `?server=wss://...` to point a page at a different server.
