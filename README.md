# Detour

A wall-placing race game for the browser. Get your pawn to the far side of the board before your
opponent does. Each turn you either take a step or drop a barricade to send them the long way
round, but you can never wall anyone in completely.

Play against a bot (Easy, Medium or Hard), against a friend on the same screen, or online
against anyone.

## Rules

- You start in the middle of the bottom row and race to any square on the top row. Your opponent
  does the reverse. The bottom player moves first.
- On your turn, do exactly one thing: step one square (no diagonals), or place a barricade.
- Barricades are two squares long and block both racers. They can't overlap or cross each
  other, and a barricade that would leave either racer with no route at all is not allowed.
- When the two pawns are face to face, you can jump straight over. If a barricade or the edge of
  the board is right behind the other pawn, hop diagonally to either side of it instead.
- Each side gets 6 barricades on the quick 7×7 board and 10 on the classic 9×9 board.
- **Roadworks** (optional): a few fixed concrete blocks are scattered before the race, always in
  mirror-image pairs, so both racers face the same journey and no layout is lopsided.

## Features

- **Opponents:** three bot levels (Easy, Medium, Hard), or a friend on the same screen.
- **Motion:** pawns move on springs and jumps arc through the air with a moving shadow.
  Barricades drop in with a puff of grit, and the barricade preview glides between grooves and
  rotates smoothly. The turn marker slides between the racer cards, numbers roll, and a
  "DETOUR +N" sign pops over whoever just got sent the long way round. A big detour gives the
  board a jolt, and a win throws confetti. Everything respects the system's reduced-motion setting.
- **Sound:** synthesized effects (no audio files) for steps, jumps, barricades, hints, wins and
  losses, plus light haptics on phones. One tap mutes it all.
- **Controls without modes on desktop:** click a highlighted square to move, or point at a groove
  between squares and the barricade preview lines up with that groove. A live caption shows what
  it would do ("Bot +3 · You ±0"). On touch, switch to Barricade, tap or drag to aim, then Place.
  Full keyboard play too.
- **Help while you play:** dotted routes show each racer's shortest way home. Hints come from
  the Hard bot's search, and illegal barricades are explained ("That would wall Bot in
  completely").
- **After the race:** an animated results panel (margin, time, barricades used, hints), a move
  list in board notation, and a full replay you can play, pause, scrub or jump through by
  clicking any move.
- **Bot runs in a Web Worker,** so even a Hard search on the 9×9 board never stalls an animation.
  It falls back to the main thread if workers aren't available.
- **Saves itself:** close the tab mid-race and it resumes. Your record per bot level and board
  size (wins, losses, streaks) is kept in the browser.
- **Settings:** sound, route lines, board coordinates, and a light/dark/system theme.
- An illustrated How to Play and an installable web-app manifest.

## Clocks

Pick a time control in the menu: **Off**, **3 min** (+2 s a move), **5 min** (+3 s) or **10 min**
(+5 s). Each racer has that much thinking time for the whole race and gets the bonus back after
every move they make. If your clock reaches zero, you lose. Clocks turn red in the last 20
seconds, show tenths, and tick audibly in your last 10.

- **Against the bot or a friend on one screen:** the clock runs only while the race is on screen,
  and pauses when you go back to the menu or switch tabs. Timed races have no undo, since undo
  would hand time back.
- **Online, on the Detour server:** the server keeps the official time. It times each move
  itself and ends the race the moment a clock runs out. Every copy of the game it sends says
  how far into the current turn it is, so each browser counts down without relying on its own
  clock matching the server's.
- **Online, on a Claude page:** with no server, each player's thinking time is measured on their
  own computer, so two machines' clocks never need to agree. Your browser ends the race as soon
  as your own clock hits zero. If it has gone quiet, your opponent's browser calls the race once
  your clock is three seconds past zero.
- Quick match only pairs players who chose the same time control.

## Online play

Pick **Online** in the menu, then:

- **Quick match:** you're paired with the next person who picks Quick match on the same board.
- **Invite a friend:** you get a five-letter code and an invite link (`…#join-abcde`). The race
  starts the moment they join.
- **Have a code?** Type it in and join.

The side you get is random. Orange moves first, and whoever plays teal sees the board turned
round, so your own pawn always starts at the bottom. During the race you can send quick
reactions ("Nice move", "Good game"…). If your opponent's connection drops, you see it straight
away. After a full minute away you can claim the win, or keep waiting. Reload mid-race and you go
straight back to your seat. After the race, both players can agree to a rematch, which swaps
sides and deals a new layout. Undo and hints are off online.

### Two ways to host it

1. **The Detour server** (`server/`): a small Node service that serves the built game and runs
   the multiplayer socket at `/ws` on the same port. It is authoritative: every move is checked
   by the same engine the browser uses before the other player sees it, and stale or repeated
   submits are refused. Seats are kept with a secret token, so a reconnect retakes the same
   seat. Rooms live in memory; finished and idle ones are cleared automatically.
2. **A Claude artifact page:** when the single-file build runs inside a claude.ai artifact
   viewer, online play uses the page's own shared storage instead of a server. Each race is one
   shared document, and a live room per race carries presence and reactions. Anyone the page is
   shared with as a Contributor can play. With no referee, each browser replays and checks every
   move it reads, and only the player whose turn it is writes.

### Running and deploying the server

```bash
npm run dev            # game on :5173 and game server on :8787 (/ws is proxied)
```

```bash
npm run build && npm run build:server && npm start   # production, on $PORT (default 8787)
```

| Variable          | Meaning                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `PORT`            | Port for the game and the socket (default 8787)                                                  |
| `STATIC_DIR`      | Folder of the built game to serve (default `dist`)                                               |
| `ALLOWED_ORIGINS` | Comma-separated origins allowed to open a socket (default: any)                                  |
| `VITE_SERVER_URL` | Build-time: socket address when the game is hosted elsewhere, e.g. `wss://detour.example.com/ws` |

The repository includes a `Dockerfile` and a Render blueprint (`render.yaml`). Either gives you
one service with the game and online play at a single URL; `/healthz` answers for health checks.
GitHub Pages can only host the game itself, so to play online from Pages, deploy the server
somewhere and set the repository variable `DETOUR_SERVER_URL` to its socket address.

## Notation

Files are lettered from the left (a, b, c…) and ranks numbered from the bottom (1, 2, 3…), so
the first player starts on d1 (7×7) or e1 (9×9). A step is written as its square, for example
`d2`. A barricade is written as the square just below-left of its centre plus `h` (lying
across) or `v` (standing up and down). For example, `c3h` sits between ranks 3 and 4, across
files c and d.

## Getting started

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

| Command                | What it does                                                              |
| ---------------------- | ------------------------------------------------------------------------- |
| `npm run dev`          | Start the game and the game server with hot reload                        |
| `npm run dev:web`      | Start only the game (no online play)                                      |
| `npm run build:server` | Bundle the game server into `server-dist/`                                |
| `npm start`            | Run the bundled game server (serves `dist/` too)                          |
| `npm run build`        | Type-check and build a static site into `dist/`                           |
| `npm run build:single` | Build one self-contained `dist-single/detour.html` you can open from disk |
| `npm test`             | Unit tests (engine, notation, geometry, online model, server, backends)   |
| `npm run test:e2e`     | Browser tests on desktop and phone, including two-player online races     |
| `npm run lint`         | ESLint                                                                    |
| `npm run format`       | Prettier                                                                  |
| `npm run typecheck`    | Type-check everything                                                     |
| `npm run sim`          | Play the bots against scripted opponents and print win rates              |

The browser tests download their own Chromium the first time (`npx playwright install
chromium`). To use a Chromium you already have, set `PW_CHROMIUM_PATH` to its path.

## Deploying

`dist/` is a plain static site, so it can go on any static host. The repository includes two
GitHub Actions workflows:

- **CI** (`.github/workflows/ci.yml`): type-check, lint, format check, unit tests, build and
  browser tests on every push and pull request.
- **Deploy to GitHub Pages** (`.github/workflows/pages.yml`): builds and publishes `dist/` on
  every push to `main`. Turn it on under the repository's Settings → Pages → Source: GitHub
  Actions.

## Project layout

```
src/
  engine/            Pure game logic, no React. Unit-tested.
    board.ts         WallGrid: barricade placement, route lengths (BFS), pawn moves and jumps
    game.ts          Race state, legal actions, applying a move
    bot.ts           The three bot levels
    analysis.ts      What a barricade would do, or why it isn't allowed
    notation.ts      Board coordinates and move names
    generator.ts     Roadworks layouts (mirror-image pairs)
    match.ts         A whole race as data: setup + move list, play/undo/resign, save format
  ai/                Web Worker that runs the bot, plus a client with a main-thread fallback
  online/            Online races: shared game model and validation, the socket protocol, and
                     two backends (Detour server, Claude artifact storage)
  audio/sfx.ts       Synthesized sound effects
  ui/
    board/           The SVG board: geometry (pointer → square or groove), animations, confetti
    screens/         Menu (with live demo race), Game, Online (lobby + race), How to Play, Settings
    components/      Modal, toasts, segmented control, switch, rolling numbers
  styles.css         Design tokens (light and dark) and all styling
server/              The game server: rooms, matchmaking, reconnects (hub.ts) and HTTP + WebSocket
tests/e2e/           Playwright browser tests
scripts/             Bot balance simulation, single-file build
```

A race is stored as its setup plus the list of moves, and the board is always rebuilt by
replaying them. That one decision is what makes saving, resuming, undo and replays simple.

## How the bots play

Every bot compares its best step (how much closer it gets) against every legal barricade (how
much longer the opponent's route gets, minus any cost to its own route).

- **Easy** walks, sometimes wanders off its best route, and only barricades when you're about to
  win, and even then it sometimes misses the chance.
- **Medium** barricades whenever it's losing the race. It will place a barricade that only
  matches a step when it's behind, because barricades build on each other: a second one next to
  the first costs you far more than either alone.
- **Hard** tries every step and its ten most promising barricades, predicts your reply to each,
  and keeps whichever leaves it best placed. That lets it hold barricades back until they hurt.

The bots are deterministic for a given race seed, so a saved race always replays the same way.

Balance from `npm run sim` (opponent win rate on the 7×7 board with roadworks; higher means an
easier bot):

| Opponent style                              | vs Easy | vs Medium | vs Hard |
| ------------------------------------------- | ------- | --------- | ------- |
| Only ever walks forward                     | 28%     | 0%        | 7%      |
| Casual: barricades only for an obvious gain | 68%     | 23%       | 7%      |
