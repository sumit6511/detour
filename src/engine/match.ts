import { type Wall } from "./board.js";
import { botAction, type BotLevel } from "./bot.js";
import {
  applyAction,
  createState,
  goalRow,
  isLegalAction,
  opponentOf,
  type DetourAction,
  type DetourState,
  type Side,
} from "./game.js";
import { generateStones } from "./generator.js";
import { createRng, randInt } from "./rng.js";
import { clockSetting, remainingFrom, type ClockPreset } from "./clock.js";

export type Mode = "bot" | "friend" | "online" | "nearby";
export type BoardSize = 7 | 9;

export const WALLS_FOR_SIZE: Record<BoardSize, number> = { 7: 6, 9: 10 };

export interface MatchOptions {
  size: BoardSize;
  mode: Mode;
  level: BotLevel;
  /** Scatter a few fixed concrete barriers (in mirror-image pairs) before the race starts. */
  roadworks: boolean;
  /** Time control; absent on races saved before clocks existed. */
  clock?: ClockPreset;
}

export interface MatchSetup extends MatchOptions {
  wallsEach: number;
  stones: Wall[];
  /** Feeds the bot's tie-breaks and dice, so a saved game replays exactly. */
  seed: number;
}

export interface MatchMove {
  side: Side;
  action: DetourAction;
  /** Timed races: how long the mover took over this move. */
  spentMs?: number;
}

/** The running state of a timed race's current turn. */
export interface ClockRun {
  /** When the current turn's clock last started (ms since epoch); null while paused. */
  turnStartedAt: number | null;
  /** Time already spent on the current turn before the last pause. */
  bankedMs: number;
}

/**
 * A whole race as plain data: the setup plus every move in order. The board is always rebuilt
 * by replaying the moves, which makes saving, resuming and undoing trivial and keeps the bot's
 * replies identical on replay (they're stored as moves like any other).
 */
export interface Match {
  setup: MatchSetup;
  moves: MatchMove[];
  resigned: Side | null;
  /** Wall-clock bookkeeping for the results screen (milliseconds since the epoch). */
  startedAt?: number;
  finishedAt?: number;
  /** Hints asked for during the race. */
  hints?: number;
  /** Set once a finished race against the bot has been counted in the player's record. */
  recorded?: boolean;
  /** Timed races only. */
  clockRun?: ClockRun;
  /** The side whose clock ran out. */
  timedOut?: Side | null;
}

/** South (bottom) is always the human in bot mode, and always moves first. */
export const HUMAN: Side = "south";
export const BOT: Side = "north";

export function createMatch(options: MatchOptions, seed = Math.floor(Math.random() * 2 ** 31)): Match {
  const rng = createRng(seed);
  const pairs = options.roadworks ? randInt(rng, 1, options.size === 9 ? 3 : 2) : 0;
  return {
    setup: {
      ...options,
      wallsEach: WALLS_FOR_SIZE[options.size],
      stones: generateStones(rng, options.size, pairs),
      seed,
    },
    moves: [],
    resigned: null,
    startedAt: Date.now(),
    hints: 0,
    // The clock starts when the race is first on screen (see resumeClock).
    ...(clockSetting(options.clock)
      ? { clockRun: { turnStartedAt: null, bankedMs: 0 }, timedOut: null }
      : {}),
  };
}

export function replay(match: Match): DetourState {
  const state = createState(match.setup);
  for (const move of match.moves) applyAction(state, move.side, move.action);
  return state;
}

export function sideToMove(match: Match): Side {
  return match.moves.length % 2 === 0 ? "south" : "north";
}

export function winnerOf(match: Match, state = replay(match)): Side | null {
  if (match.resigned) return opponentOf(match.resigned);
  if (match.timedOut) return opponentOf(match.timedOut);
  return state.winner;
}

// ---------------------------------------------------------------- clocks

function elapsedThisTurn(match: Match, now: number): number {
  const run = match.clockRun;
  if (!run) return 0;
  return run.bankedMs + (run.turnStartedAt !== null ? Math.max(0, now - run.turnStartedAt) : 0);
}

/** Both sides' remaining time at `now`, or null for an untimed race. */
export function clockTimes(match: Match, now: number): Record<Side, number> | null {
  const setting = clockSetting(match.setup.clock);
  if (!setting) return null;
  const running = winnerOf(match) ? null : sideToMove(match);
  const times = remainingFrom(setting, match.moves, running, elapsedThisTurn(match, now));
  // Whoever ran out of time shows exactly zero, not the time they had when the turn began.
  if (match.timedOut) times[match.timedOut] = 0;
  return times;
}

export function clockRunning(match: Match): boolean {
  return !!match.clockRun && match.clockRun.turnStartedAt !== null && !winnerOf(match);
}

/** Stop the clock (leaving the race screen, hiding the tab). Time spent so far is kept. */
export function pauseClock(match: Match, now: number): Match {
  const run = match.clockRun;
  if (!run || run.turnStartedAt === null) return match;
  return { ...match, clockRun: { turnStartedAt: null, bankedMs: elapsedThisTurn(match, now) } };
}

export function resumeClock(match: Match, now: number): Match {
  const run = match.clockRun;
  if (!run || run.turnStartedAt !== null || winnerOf(match)) return match;
  return { ...match, clockRun: { ...run, turnStartedAt: now } };
}

/** The side to move, if their time has run out at `now`. */
export function flagged(match: Match, now: number): Side | null {
  const times = clockTimes(match, now);
  if (!times || winnerOf(match)) return null;
  const mover = sideToMove(match);
  return times[mover] <= 0 ? mover : null;
}

export function timeOut(match: Match, side: Side, now: number): Match {
  if (winnerOf(match)) return match;
  return { ...pauseClock(match, now), timedOut: side };
}

/**
 * Appends `action` for whoever is to move, or returns null if it isn't legal right now
 * (including when the mover's clock has already run out).
 */
export function play(match: Match, action: DetourAction, now: number = Date.now()): Match | null {
  const state = replay(match);
  if (winnerOf(match, state)) return null;
  const side = sideToMove(match);
  if (!isLegalAction(state, side, action)) return null;
  if (!match.clockRun) return { ...match, moves: [...match.moves, { side, action }] };
  if (flagged(match, now)) return null;
  const spentMs = Math.round(elapsedThisTurn(match, now));
  return {
    ...match,
    moves: [...match.moves, { side, action, spentMs }],
    // A move made while the clock is paused (the bot replying in a hidden tab) leaves it paused.
    clockRun: { turnStartedAt: match.clockRun.turnStartedAt === null ? null : now, bankedMs: 0 },
  };
}

export function isBotTurn(match: Match): boolean {
  return match.setup.mode === "bot" && sideToMove(match) === BOT && !winnerOf(match);
}

/** Plays the bot's move when it's the bot's turn; otherwise returns the match unchanged. */
export function playBot(match: Match): Match {
  if (!isBotTurn(match)) return match;
  const state = replay(match);
  const turn = Math.floor(match.moves.length / 2);
  const action = botAction(state, BOT, match.setup.level, match.setup.seed, turn);
  return play(match, action) ?? match;
}

/**
 * Takes back the last move. Against the bot it takes back the bot's reply too, so it's the
 * human's turn again. Finished races can't be undone.
 */
export function undo(match: Match): Match {
  // Timed races have no undo: it would hand thinking time back.
  if (winnerOf(match) || match.moves.length === 0 || match.clockRun) return match;
  const last = match.moves[match.moves.length - 1]!;
  let moves = match.moves.slice(0, -1);
  // Taking back only the bot's reply would just make it play the same reply again.
  if (match.setup.mode === "bot" && last.side === BOT) moves = moves.slice(0, -1);
  return { ...match, moves };
}

export function resign(match: Match, side: Side): Match {
  if (winnerOf(match)) return match;
  return { ...match, resigned: side };
}

export function routeLength(state: DetourState, side: Side): number {
  return state.grid.distanceTo(state.pawns[side], goalRow(state.size, side));
}

export function wallsUsed(match: Match, side: Side): number {
  return match.moves.filter((m) => m.side === side && m.action.type === "wall").length;
}

/** Shape-checks a saved match before trusting it (old versions, hand-edited storage). */
export function isMatch(value: unknown): value is Match {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<Match>;
  return (
    !!m.setup &&
    (m.setup.size === 7 || m.setup.size === 9) &&
    Array.isArray(m.setup.stones) &&
    Array.isArray(m.moves) &&
    typeof m.setup.seed === "number"
  );
}
