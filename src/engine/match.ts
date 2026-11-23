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

export type Mode = "bot" | "friend" | "online";
export type BoardSize = 7 | 9;

export const WALLS_FOR_SIZE: Record<BoardSize, number> = { 7: 6, 9: 10 };

export interface MatchOptions {
  size: BoardSize;
  mode: Mode;
  level: BotLevel;
  /** Scatter a few fixed concrete barriers (in mirror-image pairs) before the race starts. */
  roadworks: boolean;
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
  return state.winner;
}

/** Appends `action` for whoever is to move, or returns null if it isn't legal right now. */
export function play(match: Match, action: DetourAction): Match | null {
  const state = replay(match);
  if (winnerOf(match, state)) return null;
  const side = sideToMove(match);
  if (!isLegalAction(state, side, action)) return null;
  return { ...match, moves: [...match.moves, { side, action }] };
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
  if (winnerOf(match) || match.moves.length === 0) return match;
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
