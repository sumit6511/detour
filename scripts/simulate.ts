/**
 * Balance check: plays each bot level against scripted opponents of different strength over
 * many random boards and prints the opponent's win rate. Run with `npm run sim -- [games] [size]`.
 */
import {
  applyAction,
  createState,
  isLegalAction,
  type DetourAction,
  type DetourState,
} from "../src/engine/game.ts";
import { botAction, greedyAction, POLICIES, type BotLevel } from "../src/engine/bot.ts";
import { generateStones } from "../src/engine/generator.ts";
import { createRng, randInt } from "../src/engine/rng.ts";

type Opponent = (state: DetourState, turn: number) => DetourAction;

const walker: Opponent = (state) => {
  const map = state.grid.distanceMap(0);
  const steps = state.grid.pawnMoves(state.pawns.south, state.pawns.north);
  steps.sort((a, b) => map[a.row * state.size + a.col]! - map[b.row * state.size + b.col]!);
  return { type: "step", ...steps[0]! };
};
// Walls only when one clearly pays off right now: a rough stand-in for a casual human.
const casual: Opponent = (state, turn) =>
  greedyAction(state, "south", 4242, turn, {
    ...POLICIES.medium,
    wallOnTieWhenBehind: false,
    bigWallEdge: 99,
    lookahead: 0,
    wander: 0,
  });
const medium: Opponent = (state, turn) => botAction(state, "south", "medium", 999, turn);
const hard: Opponent = (state, turn) => botAction(state, "south", "hard", 999, turn);

const games = Number(process.argv[2] ?? 30);
const size = Number(process.argv[3] ?? 7);
const wallsEach = size === 9 ? 10 : 6;
const opponents: Record<string, Opponent> = { walker, casual, medium, hard };
const started = Date.now();

const levels = (process.argv[4]?.split(",") ?? ["easy", "medium", "hard"]) as BotLevel[];
for (const level of levels) {
  const row: string[] = [];
  for (const [name, opponent] of Object.entries(opponents)) {
    let wins = 0;
    for (let g = 0; g < games; g++) {
      const rng = createRng(`sim-${size}-${g}`);
      const stones = generateStones(rng, size, randInt(rng, 1, size === 9 ? 3 : 2));
      const state = createState({ size, wallsEach, stones });
      const seed = randInt(rng, 0, 2 ** 31);
      for (let turn = 0; turn < 150 && !state.winner; turn++) {
        const mine = opponent(state, turn);
        if (!isLegalAction(state, "south", mine))
          throw new Error(`illegal player move ${JSON.stringify(mine)}`);
        applyAction(state, "south", mine);
        if (state.winner) break;
        const reply = botAction(state, "north", level, seed, turn);
        if (!isLegalAction(state, "north", reply))
          throw new Error(`illegal bot move ${JSON.stringify(reply)}`);
        applyAction(state, "north", reply);
      }
      if (state.winner === "south") wins++;
    }
    row.push(`${name} ${String(Math.round((100 * wins) / games)).padStart(3)}%`);
  }
  console.log(`${size}x${size} bot=${level.padEnd(6)} opponent win rate:  ${row.join("   ")}`);
}
console.log(`(${games} games per cell, ${Date.now() - started}ms)`);
