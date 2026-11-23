# Detour

A wall-placing race game for the browser. Get your pawn to the far side of the board before your
opponent does. Each turn you either take a step or drop a barricade to send them the long way
round, but you can never wall anyone in completely.

Play against a bot (Easy, Medium or Hard) or against a friend on the same screen.

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
| `npm run dev`          | Start the dev server with hot reload                                      |
| `npm run build`        | Type-check and build a static site into `dist/`                           |
| `npm run build:single` | Build one self-contained `dist-single/detour.html` you can open from disk |
| `npm test`             | Unit tests (engine, notation, board geometry)                             |
| `npm run test:e2e`     | Browser tests on desktop and phone viewports (Playwright)                 |
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
  audio/sfx.ts       Synthesized sound effects
  ui/
    board/           The SVG board: geometry (pointer → square or groove), animations, confetti
    screens/         Menu (with live demo race), Game, How to Play, Settings
    components/      Modal, toasts, segmented control, switch, rolling numbers
  styles.css         Design tokens (light and dark) and all styling
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
