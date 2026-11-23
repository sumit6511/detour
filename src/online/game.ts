import { WallGrid, UNREACHABLE, wallKey, type Wall } from "../engine/board.js";
import { goalRow, startPosition, type DetourAction, type Side } from "../engine/game.js";
import {
  WALLS_FOR_SIZE,
  play,
  winnerOf,
  type BoardSize,
  type Match,
  type MatchMove,
} from "../engine/match.js";
import { generateStones } from "../engine/generator.js";
import { createRng, randInt } from "../engine/rng.js";
import { clockSetting, isClockPreset, remainingFrom, type ClockPreset } from "../engine/clock.js";

/** A seat at the table: an opaque player id plus the name to show (server mode only). */
export interface Seat {
  id: string;
  name: string;
}

export interface OnlineSetup {
  size: BoardSize;
  roadworks: boolean;
  clock: ClockPreset;
  wallsEach: number;
  stones: Wall[];
  seed: number;
}

/**
 * One online race, as stored and sent around. Moves are the source of truth, exactly as in a
 * local race; every client and the server replay them through the engine, so a game can't be
 * pushed into an impossible position by anyone.
 */
export interface OnlineGame {
  v: 1;
  code: string;
  setup: OnlineSetup;
  players: Record<Side, Seat | null>;
  moves: MatchMove[];
  resigned: Side | null;
  /** True when `resigned` was a forfeit claimed by the opponent after an absence. */
  abandoned: boolean;
  /** Timed races: the side whose clock ran out. */
  timedOut: Side | null;
  /** When the current turn began, on the clock of whoever recorded it (ms since epoch). */
  turnStartedAt: number;
  /**
   * Server races: how much of the current turn had passed when this copy was sent. Lets each
   * browser run the clock from the moment it received the game, so their own clocks never need
   * to agree with the server's. Zero for races stored with a Claude page.
   */
  turnElapsedMs: number;
  status: "open" | "playing" | "finished";
  rematch: Record<Side, boolean>;
  /** The rematch's code, once it exists. */
  next: string | null;
  /** Offered to strangers through quick match. */
  isPublic: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateOptions {
  size: BoardSize;
  roadworks: boolean;
  clock: ClockPreset;
  isPublic: boolean;
}

// No 0/O, 1/I/L: codes get read aloud and typed on phones.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 5;

export function makeCode(random: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return code;
}

export function normaliseCode(text: string): string | null {
  const code = text
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  return [...code].every((ch) => CODE_ALPHABET.includes(ch)) ? code : null;
}

export function newSetup(
  options: Pick<CreateOptions, "size" | "roadworks" | "clock">,
  seed: number,
): OnlineSetup {
  const rng = createRng(seed);
  const pairs = options.roadworks ? randInt(rng, 1, options.size === 9 ? 3 : 2) : 0;
  return {
    size: options.size,
    roadworks: options.roadworks,
    clock: options.clock,
    wallsEach: WALLS_FOR_SIZE[options.size],
    stones: generateStones(rng, options.size, pairs),
    seed,
  };
}

/** A fresh game with its creator on a random side (south moves first, so this keeps it fair). */
export function newGame(
  code: string,
  options: CreateOptions,
  host: Seat,
  now: number,
  random: () => number = Math.random,
): OnlineGame {
  const hostSide: Side = random() < 0.5 ? "south" : "north";
  return {
    v: 1,
    code,
    setup: newSetup(options, Math.floor(random() * 2 ** 31)),
    players: { south: hostSide === "south" ? host : null, north: hostSide === "north" ? host : null },
    moves: [],
    resigned: null,
    abandoned: false,
    timedOut: null,
    turnStartedAt: now,
    turnElapsedMs: 0,
    status: "open",
    rematch: { south: false, north: false },
    next: null,
    isPublic: options.isPublic,
    createdAt: now,
    updatedAt: now,
  };
}

/** The next game after a rematch: same settings, fresh layout, sides swapped. */
export function rematchGame(
  previous: OnlineGame,
  code: string,
  now: number,
  random: () => number = Math.random,
): OnlineGame {
  return {
    ...newGame(
      code,
      {
        size: previous.setup.size,
        roadworks: previous.setup.roadworks,
        clock: previous.setup.clock,
        isPublic: false,
      },
      previous.players.south!,
      now,
      random,
    ),
    players: { south: previous.players.north, north: previous.players.south },
    status: "playing",
  };
}

export function sideOf(game: OnlineGame, playerId: string): Side | null {
  if (game.players.south?.id === playerId) return "south";
  if (game.players.north?.id === playerId) return "north";
  return null;
}

export function toMatch(game: OnlineGame): Match {
  return {
    setup: { ...game.setup, mode: "online", level: "medium" },
    moves: game.moves,
    resigned: game.resigned,
    timedOut: game.timedOut,
    startedAt: game.createdAt,
  };
}

export function moverOf(game: OnlineGame): Side {
  return game.moves.length % 2 === 0 ? "south" : "north";
}

/** Remaining time for both sides, given how long the current turn has been running. */
export function gameClock(game: OnlineGame, currentElapsedMs: number): Record<Side, number> | null {
  const setting = clockSetting(game.setup.clock);
  if (!setting) return null;
  const mover = game.status === "playing" ? moverOf(game) : null;
  const times = remainingFrom(setting, game.moves, mover, Math.max(0, currentElapsedMs));
  if (game.timedOut) times[game.timedOut] = 0;
  return times;
}

export function timeoutGame(game: OnlineGame, side: Side, now: number): OnlineGame | string {
  if (game.status !== "playing") return "This race isn't in progress.";
  return { ...game, timedOut: side, status: "finished", updatedAt: now };
}

/**
 * Applies `action` for `side`, or explains why not. Used by the server for every incoming move
 * and by clients before they write one.
 */
export const OUT_OF_TIME = "Your time ran out.";

/**
 * Applies `action` for `side`, or explains why not. In a timed race `spentMs` is how long the
 * mover took; a move that arrives after their clock ran out is refused with OUT_OF_TIME.
 */
export function applyMove(
  game: OnlineGame,
  side: Side,
  action: DetourAction,
  now: number,
  spentMs = 0,
): OnlineGame | string {
  if (game.status !== "playing")
    return game.status === "open" ? "Waiting for an opponent." : "This race is over.";
  if (moverOf(game) !== side) return "It's not your turn.";
  const next = play(toMatch(game), action);
  if (!next) return "That move isn't allowed.";
  const timed = clockSetting(game.setup.clock) !== null;
  const spent = Math.max(0, Math.round(spentMs));
  if (timed && gameClock(game, spent)![side] <= 0) return OUT_OF_TIME;
  const moves = timed ? [...game.moves, { side, action, spentMs: spent }] : next.moves;
  const finished = winnerOf({ ...next, moves }) !== null;
  return {
    ...game,
    moves,
    status: finished ? "finished" : "playing",
    turnStartedAt: now,
    turnElapsedMs: 0,
    updatedAt: now,
  };
}

export function resignGame(
  game: OnlineGame,
  side: Side,
  now: number,
  abandoned = false,
): OnlineGame | string {
  if (game.status !== "playing") return "This race isn't in progress.";
  return { ...game, resigned: side, abandoned, status: "finished", updatedAt: now };
}

export function winnerOfGame(game: OnlineGame): Side | null {
  return winnerOf(toMatch(game));
}

// ---------------------------------------------------------------- validation of untrusted data

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isSide = (v: unknown): v is Side => v === "south" || v === "north";

function parseSeat(v: unknown): Seat | null {
  if (!isObject(v) || typeof v.id !== "string" || !v.id) return null;
  const name = typeof v.name === "string" ? v.name.slice(0, 24) : "";
  return { id: v.id.slice(0, 128), name };
}

export function cleanName(text: string): string {
  // Plain printable text only, trimmed and short: it's shown to strangers.
  return text
    .replace(/[^\p{L}\p{N}\p{Zs}'._-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);
}

function parseWall(v: unknown, size: number): Wall | null {
  if (!isObject(v) || (v.orientation !== "h" && v.orientation !== "v")) return null;
  const row = Number(v.row);
  const col = Number(v.col);
  if (
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    row < 0 ||
    col < 0 ||
    row > size - 2 ||
    col > size - 2
  )
    return null;
  return { orientation: v.orientation, row, col };
}

function parseSetup(v: unknown): OnlineSetup | null {
  if (!isObject(v)) return null;
  const size = v.size;
  if (size !== 7 && size !== 9) return null;
  if (!Array.isArray(v.stones) || v.stones.length > 12) return null;
  const grid = new WallGrid(size);
  const stones: Wall[] = [];
  for (const raw of v.stones) {
    const wall = parseWall(raw, size);
    if (!wall || !grid.fitsGeometrically(wall)) return null;
    grid.place(wall);
    stones.push(wall);
  }
  // Roadworks must never seal anyone in before the race even starts.
  for (const side of ["south", "north"] as Side[]) {
    if (grid.distanceTo(startPosition(size, side), goalRow(size, side)) >= UNREACHABLE) return null;
  }
  const seed = Number(v.seed);
  if (!Number.isFinite(seed)) return null;
  const clock = isClockPreset(v.clock) ? v.clock : "off";
  return { size, roadworks: v.roadworks === true, clock, wallsEach: WALLS_FOR_SIZE[size], stones, seed };
}

/**
 * Turns whatever arrived (a db document, a socket message) into a well-formed game, or null.
 * Moves are replayed through the engine and the list is cut at the first one that isn't legal,
 * so a tampered or garbled history can never produce an impossible board.
 */
export function parseGame(raw: unknown): OnlineGame | null {
  if (!isObject(raw) || raw.v !== 1 || typeof raw.code !== "string") return null;
  const setup = parseSetup(raw.setup);
  if (!setup) return null;
  const players = isObject(raw.players)
    ? { south: parseSeat(raw.players.south), north: parseSeat(raw.players.north) }
    : { south: null, north: null };

  let match: Match = { setup: { ...setup, mode: "online", level: "medium" }, moves: [], resigned: null };
  const rawMoves = Array.isArray(raw.moves) ? raw.moves : [];
  for (const m of rawMoves.slice(0, 400)) {
    if (!isObject(m) || !isSide(m.side) || !isObject(m.action)) break;
    const a = m.action;
    let action: DetourAction | null = null;
    if (a.type === "step" && Number.isInteger(a.row) && Number.isInteger(a.col)) {
      action = { type: "step", row: Number(a.row), col: Number(a.col) };
    } else if (a.type === "wall") {
      const wall = parseWall(a, setup.size);
      if (wall) action = { type: "wall", ...wall };
    }
    if (!action) break;
    const expected = match.moves.length % 2 === 0 ? "south" : "north";
    if (m.side !== expected) break;
    const next = play(match, action);
    if (!next) break;
    // Keep each move's time on timed races (capped at a day; anything odd counts as zero).
    const spent = Number(m.spentMs);
    const spentMs = Number.isFinite(spent) ? Math.min(Math.max(0, spent), 86_400_000) : 0;
    match =
      setup.clock !== "off" ? { ...next, moves: [...match.moves, { side: m.side, action, spentMs }] } : next;
  }

  const resigned = isSide(raw.resigned) && !winnerOf(match) ? raw.resigned : null;
  const timedOut =
    setup.clock !== "off" && resigned === null && isSide(raw.timedOut) && !winnerOf(match)
      ? raw.timedOut
      : null;
  const finished = resigned !== null || timedOut !== null || winnerOf(match) !== null;
  const status = finished
    ? "finished"
    : raw.status === "open" && !(players.south && players.north)
      ? "open"
      : "playing";
  const rematch = isObject(raw.rematch)
    ? { south: raw.rematch.south === true, north: raw.rematch.north === true }
    : { south: false, north: false };
  const next = typeof raw.next === "string" ? normaliseCode(raw.next) : null;
  const number = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

  return {
    v: 1,
    code: normaliseCode(raw.code) ?? raw.code.slice(0, 8),
    setup,
    players,
    moves: match.moves,
    resigned,
    abandoned: resigned !== null && raw.abandoned === true,
    timedOut,
    status,
    rematch,
    next,
    isPublic: raw.isPublic === true,
    createdAt: number(raw.createdAt),
    updatedAt: number(raw.updatedAt),
    turnStartedAt: number(raw.turnStartedAt) || number(raw.updatedAt),
    turnElapsedMs: Math.max(0, number(raw.turnElapsedMs)),
  };
}

export function stoneKeys(setup: OnlineSetup): string[] {
  return setup.stones.map(wallKey);
}
