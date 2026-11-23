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

- Bot opponents at three levels, all fast enough to run in the browser.
- Two-player pass-and-play mode.
- Dotted overlays show each racer's current shortest route, and a "DETOUR +N" sign pops up when a
  barricade lengthens someone's route.
- Undo, resign, and automatic save: close the tab mid-race and pick it up where you left off.
- Your record against each bot level is saved in the browser.
- Mouse, touch (tap once to preview a barricade, tap again to place it) and keyboard: arrow keys
  step, W switches to barricades, R rotates, U undoes.
- Light and dark themes that follow your system setting.

## Getting started

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

| Command                | What it does                                                           |
| ---------------------- | ---------------------------------------------------------------------- |
| `npm run dev`          | Start the dev server with hot reload                                   |
| `npm run build`        | Type-check and build a static site into `dist/`                        |
| `npm run build:single` | Build one self-contained `dist-single/detour.html` you can open from disk |
| `npm test`             | Run the engine tests                                                   |
| `npm run typecheck`    | Type-check everything                                                  |
| `npm run sim`          | Play the bots against scripted opponents and print win rates           |

`dist/` is a plain static site, so it can be hosted on any static host (GitHub Pages, Netlify,
Cloudflare Pages and so on).

## Project layout

```
src/
  engine/          Pure game logic, no React. Fully unit-tested.
    board.ts       WallGrid: wall placement, route lengths (BFS), pawn moves and jumps
    game.ts        Race state, legal actions, applying a move
    bot.ts         The three bot levels
    generator.ts   Roadworks layouts (mirror-image pairs)
    match.ts       A whole race as data: setup + move list, play/undo/resign, save format
    rng.ts         Seeded random numbers
  ui/              React components: Menu, Game, Board (SVG), icons, storage
  styles.css       Design tokens and all styling
scripts/
  simulate.ts      Bot balance simulation
  inline-build.mjs Folds the single-file build into one HTML file
```

A race is stored as its setup plus the list of moves, and the board is always rebuilt by
replaying them. That one decision is what makes saving, resuming and undo simple.

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

| Opponent style                                   | vs Easy | vs Medium | vs Hard |
| ------------------------------------------------ | ------- | --------- | ------- |
| Only ever walks forward                          | 28%     | 0%        | 7%      |
| Casual: barricades only for an obvious gain      | 68%     | 23%       | 7%      |
