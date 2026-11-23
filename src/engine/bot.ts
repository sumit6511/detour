import { hashSeed } from "./rng.js";
import { UNREACHABLE, wallKey, type Cell, type Wall } from "./board.js";
import {
  applyAction,
  cloneState,
  goalRow,
  opponentOf,
  routesFor,
  type DetourAction,
  type DetourState,
  type Side,
} from "./game.js";

export type BotLevel = "easy" | "medium" | "hard";

export interface BotPolicy {
  /**
   * When it's losing a pure race and a wall only matches a step's gain, wall anyway. Walls
   * compound: the second wall beside a first one costs far more than either alone. A bot that
   * only walls for an immediate net profit never builds a barrier, and loses to anyone who
   * just walks.
   */
  wallOnTieWhenBehind: boolean;
  /** At or below this race margin (opponent's route minus mine), consider walling at all. */
  contestMargin: number;
  /** Opportunistic: wall whenever one beats a step by at least this much, whatever the margin. */
  bigWallEdge: number;
  /** How many of the top immediate walls get a one-wall lookahead for follow-up potential. */
  lookahead: number;
  /** Only think about walls once the opponent is this close to its goal. */
  panicDistance: number;
  /** Chance (0–1) of overlooking a wall it would otherwise place. */
  sloppiness: number;
  /** Chance (0–1) of taking a random sideways-or-forward step instead of the best one. */
  wander: number;
}

export const POLICIES: Record<"easy" | "medium", BotPolicy> = {
  easy: {
    wallOnTieWhenBehind: false,
    contestMargin: -1,
    bigWallEdge: 99,
    lookahead: 0,
    panicDistance: 2,
    sloppiness: 0.5,
    wander: 0.25,
  },
  medium: {
    wallOnTieWhenBehind: true,
    contestMargin: -1,
    bigWallEdge: 3,
    lookahead: 6,
    panicDistance: Infinity,
    sloppiness: 0,
    wander: 0,
  },
};

interface WallCandidate {
  wall: Wall;
  /** Net race swing: how much longer their route got minus how much longer mine got. */
  gain: number;
  theirIncrease: number;
  proximity: number;
  tie: number;
  value: number;
}

function tieBreak(seed: number, turn: number, key: string): number {
  return hashSeed(`${seed}:${turn}:${key}`);
}

/** A seeded number in [0, 1) for this turn, so "random" choices still replay identically. */
function roll(seed: number, turn: number, key: string): number {
  return tieBreak(seed, turn, key) / 4294967296;
}

function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

/** Distance from a wall's centre to a pawn, in half-cells. Closer walls tend to bite sooner. */
function wallProximity(wall: Wall, pawn: Cell): number {
  return Math.abs(wall.row + 0.5 - pawn.row) + Math.abs(wall.col + 0.5 - pawn.col);
}

function compareCandidates(a: WallCandidate, b: WallCandidate): number {
  return (
    b.value - a.value ||
    b.gain - a.gain ||
    b.theirIncrease - a.theirIncrease ||
    a.proximity - b.proximity ||
    a.tie - b.tie
  );
}

/** The step that most shortens `side`'s route, with deterministic tie-breaks. */
function bestStep(state: DetourState, side: Side, seed: number, turn: number) {
  const me = state.pawns[side];
  const them = state.pawns[opponentOf(side)];
  const map = state.grid.distanceMap(goalRow(state.size, side));
  const at = (cell: Cell) => map[cell.row * state.size + cell.col]!;
  const steps = state.grid.pawnMoves(me, them);
  let best = steps[0]!;
  for (const step of steps.slice(1)) {
    const diff = at(step) - at(best);
    if (diff < 0) best = step;
    else if (diff === 0) {
      // Prefer the square farther from the opponent (fewer jump-overs gifted to it), then a
      // seeded coin flip so ties don't always resolve the same way.
      const spacing = manhattan(best, them) - manhattan(step, them);
      const flip =
        tieBreak(seed, turn, `${step.row}-${step.col}`) < tieBreak(seed, turn, `${best.row}-${best.col}`);
      if (spacing > 0 || (spacing === 0 && flip)) best = step;
    }
  }
  return { step: best, gain: at(me) - at(best), myDistance: at(me) };
}

/** Every legal wall that swings the race in `side`'s favour, best first. */
function rankWalls(
  state: DetourState,
  side: Side,
  seed: number,
  turn: number,
  myDistance: number,
  theirDistance: number,
): WallCandidate[] {
  const them = state.pawns[opponentOf(side)];
  const routes = routesFor(state, opponentOf(side)); // [their route, my route]
  const candidates: WallCandidate[] = [];
  for (const wall of state.grid.allWallSlots()) {
    const lengths = state.grid.tryWall(wall, routes);
    if (!lengths) continue;
    const theirIncrease = lengths[0]! - theirDistance;
    const gain = theirIncrease - (lengths[1]! - myDistance);
    if (gain <= 0) continue;
    candidates.push({
      wall,
      gain,
      theirIncrease,
      proximity: wallProximity(wall, them),
      tie: tieBreak(seed, turn, wallKey(wall)),
      value: gain,
    });
  }
  return candidates.sort(compareCandidates);
}

/**
 * The greedy core used by Easy and Medium. Each turn it compares its best step (how much closer
 * it gets) against every legal wall (how much the wall swings the race: their detour minus its
 * own). It only spends a wall when that beats walking. When it's behind, a wall that merely
 * ties a step also counts, because that wall sets up bigger walls later, while a step that
 * leaves it still losing buys nothing.
 */
export function greedyAction(
  state: DetourState,
  side: Side,
  seed: number,
  turn: number,
  policy: BotPolicy,
): DetourAction {
  const other = opponentOf(side);
  const myGoal = goalRow(state.size, side);
  const steps = state.grid.pawnMoves(state.pawns[side], state.pawns[other]);
  const winning = steps.find((step) => step.row === myGoal);
  if (winning) return { type: "step", row: winning.row, col: winning.col };

  const { step, gain: stepGain, myDistance } = bestStep(state, side, seed, turn);
  let stepAction: DetourAction = { type: "step", row: step.row, col: step.col };
  if (policy.wander > 0 && roll(seed, turn, "wander") < policy.wander) {
    // A distracted step: any move that doesn't lose ground, picked by a seeded roll.
    const map = state.grid.distanceMap(myGoal);
    const fine = steps.filter((s) => map[s.row * state.size + s.col]! <= myDistance);
    const pick = fine[Math.floor(roll(seed, turn, "pick") * fine.length)] ?? step;
    stepAction = { type: "step", row: pick.row, col: pick.col };
  }
  if (state.wallsLeft[side] <= 0) return stepAction;

  const theirDistance = state.grid.distanceTo(state.pawns[other], goalRow(state.size, other));
  if (theirDistance >= UNREACHABLE || theirDistance > policy.panicDistance) return stepAction;
  // I'm to move, so in a pure race I arrive first when my route is no longer than theirs.
  const margin = theirDistance - myDistance;

  const candidates = rankWalls(state, side, seed, turn, myDistance, theirDistance);
  if (candidates.length === 0) return stepAction;

  // A shallow look one wall further for the most promising few: a wall that's only a tie now
  // but opens a big follow-up (the start of a barrier) beats an equal one that leads nowhere.
  if (policy.lookahead > 0 && state.wallsLeft[side] > 1) {
    const routes = routesFor(state, other);
    for (const candidate of candidates.slice(0, policy.lookahead)) {
      state.grid.place(candidate.wall);
      const baseThem = theirDistance + candidate.theirIncrease;
      const baseMe = myDistance + candidate.theirIncrease - candidate.gain;
      let followUp = 0;
      for (const next of state.grid.allWallSlots()) {
        const lengths = state.grid.tryWall(next, routes);
        if (!lengths) continue;
        const swing = lengths[0]! - baseThem - (lengths[1]! - baseMe);
        if (swing > followUp) followUp = swing;
      }
      state.grid.remove(candidate.wall);
      candidate.value = candidate.gain + followUp * 0.5;
    }
    candidates.sort(compareCandidates);
  }

  const best = candidates[0]!;
  const wallAction: DetourAction = { type: "wall", ...best.wall };
  const edge = best.gain - stepGain;
  const overlooked = roll(seed, turn, "sloppy") < policy.sloppiness;

  let wantsWall = false;
  if (edge >= policy.bigWallEdge) wantsWall = true;
  else if (margin < 0 || margin <= policy.contestMargin) {
    if (edge > 0) wantsWall = true;
    else if (edge === 0 && margin < 0 && policy.wallOnTieWhenBehind) wantsWall = true;
  }
  return wantsWall && !overlooked ? wallAction : stepAction;
}

/** How good `state` is for `side`, with `side` to move next. */
function evaluate(state: DetourState, side: Side): number {
  const other = opponentOf(side);
  if (state.winner === side) return 1000;
  if (state.winner === other) return -1000;
  const mine = state.grid.distanceTo(state.pawns[side], goalRow(state.size, side));
  const theirs = state.grid.distanceTo(state.pawns[other], goalRow(state.size, other));
  const margin = theirs - mine;
  let value = margin + 0.45 * (state.wallsLeft[side] - state.wallsLeft[other]);
  // A lead the opponent has no walls left to answer is a won race; the reverse is a lost one.
  if (margin >= 0 && state.wallsLeft[other] === 0) value += 20;
  if (margin < 0 && state.wallsLeft[side] === 0) value -= 20;
  return value;
}

const HARD_WALL_CANDIDATES = 10;

/**
 * Hard: tries every step and its ten most promising walls, predicts the opponent's reply to
 * each (assuming the opponent plays like Medium), and keeps whichever leaves it best placed
 * in the race. Seeing one reply ahead lets it hold walls back until they matter and avoid
 * walls that hand the opponent a shortcut.
 */
export function searchAction(state: DetourState, side: Side, seed: number, turn: number): DetourAction {
  const other = opponentOf(side);
  const myGoal = goalRow(state.size, side);
  const steps = state.grid.pawnMoves(state.pawns[side], state.pawns[other]);
  const winning = steps.find((step) => step.row === myGoal);
  if (winning) return { type: "step", row: winning.row, col: winning.col };

  const candidates: DetourAction[] = steps.map((s) => ({
    type: "step",
    row: s.row,
    col: s.col,
  }));
  if (state.wallsLeft[side] > 0) {
    const myDistance = state.grid.distanceTo(state.pawns[side], myGoal);
    const theirDistance = state.grid.distanceTo(state.pawns[other], goalRow(state.size, other));
    const walls = rankWalls(state, side, seed, turn, myDistance, theirDistance);
    for (const c of walls.slice(0, HARD_WALL_CANDIDATES)) candidates.push({ type: "wall", ...c.wall });
  }

  const preferred = greedyAction(state, side, seed, turn, POLICIES.medium);
  let best = candidates[0]!;
  let bestValue = -Infinity;
  for (const action of candidates) {
    const next = cloneState(state);
    applyAction(next, side, action);
    if (!next.winner) {
      applyAction(next, other, greedyAction(next, other, seed, turn + 1, POLICIES.medium));
    }
    let value = evaluate(next, side);
    // Ties go to the move Medium would have made, then to keeping walls in hand.
    if (sameAction(action, preferred)) value += 0.01;
    if (action.type === "step") value += 0.005;
    if (value > bestValue) {
      bestValue = value;
      best = action;
    }
  }
  return best;
}

function sameAction(a: DetourAction, b: DetourAction): boolean {
  if (a.type !== b.type || a.row !== b.row || a.col !== b.col) return false;
  return a.type === "step" || (b.type === "wall" && a.orientation === b.orientation);
}

/** The bot's move. Deterministic for a given (state, seed, turn), so games can be replayed. */
export function botAction(
  state: DetourState,
  side: Side,
  level: BotLevel,
  seed: number,
  turn: number,
): DetourAction {
  if (level === "hard") return searchAction(state, side, seed, turn);
  return greedyAction(state, side, seed, turn, POLICIES[level]);
}
