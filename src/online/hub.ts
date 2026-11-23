import type { DetourAction, Side } from "../engine/game.js";
import { opponentOf } from "../engine/game.js";
import type { BoardSize } from "../engine/match.js";
import type { ClockPreset } from "../engine/clock.js";
import {
  applyMove,
  gameClock,
  moverOf,
  OUT_OF_TIME,
  timeoutGame,
  makeCode,
  newGame,
  parseGame,
  rematchGame,
  resignGame,
  sideOf,
  type OnlineGame,
} from "./game.js";
import { ABANDON_AFTER_MS, isReaction, type ServerMessage } from "./protocol.js";

/** One open socket. A player with two tabs is two connections in the same seat. */
export interface Conn {
  /** Stable per browser (sent in hello), so quick match never pairs you with yourself. */
  clientId: string;
  name: string;
  send(message: ServerMessage): void;
  seats: Map<string, Side>;
}

interface Room {
  game: OnlineGame;
  tokens: Record<Side, string | null>;
  clientIds: Record<Side, string | null>;
  conns: Record<Side, Set<Conn>>;
  awaySince: Record<Side, number | null>;
}

export type HubSnapshot = Array<{
  game: OnlineGame;
  tokens: Record<Side, string | null>;
  clientIds: Record<Side, string | null>;
}>;

const OPEN_ROOM_TTL_MS = 15 * 60_000;
const ROOM_TTL_MS = 3 * 60 * 60_000;

export class HubError extends Error {}

/**
 * Every live race on this referee: the game server's, or the one running inside the host's
 * browser in a nearby (same Wi-Fi) game. Authoritative: clients only ever send intentions, and each
 * one is checked by the same engine the browser runs before anyone else hears about it.
 */
export class Hub {
  private rooms = new Map<string, Room>();

  constructor(
    private now: () => number = Date.now,
    private random: () => number = Math.random,
  ) {}

  get size() {
    return this.rooms.size;
  }

  game(code: string): OnlineGame | undefined {
    return this.rooms.get(code)?.game;
  }

  create(
    conn: Conn,
    options: { size: BoardSize; roadworks: boolean; clock: ClockPreset; isPublic: boolean },
    id: number,
  ) {
    const code = this.freshCode();
    const seatId = token(8);
    const game = newGame(code, options, { id: seatId, name: conn.name }, this.now(), this.random);
    const side: Side = game.players.south ? "south" : "north";
    const room: Room = {
      game,
      tokens: { south: null, north: null },
      clientIds: { south: null, north: null },
      conns: { south: new Set(), north: new Set() },
      awaySince: { south: null, north: null },
    };
    this.rooms.set(code, room);
    this.seat(room, side, conn, id);
  }

  join(conn: Conn, code: string, id: number) {
    const room = this.room(code);
    const mine = (["south", "north"] as Side[]).find((s) => room.clientIds[s] === conn.clientId);
    if (mine) return this.seat(room, mine, conn, id); // same browser, another tab
    const open: Side | undefined = !room.game.players.south
      ? "south"
      : !room.game.players.north
        ? "north"
        : undefined;
    if (!open || room.game.status !== "open") throw new HubError("That race is already full.");
    room.game = {
      ...room.game,
      players: { ...room.game.players, [open]: { id: token(8), name: conn.name } },
      status: "playing",
      // The clock starts when the race does, not when the lobby opened.
      turnStartedAt: this.now(),
      updatedAt: this.now(),
    };
    this.seat(room, open, conn, id);
    this.broadcast(room, { t: "game", game: room.game });
  }

  resume(conn: Conn, code: string, seatToken: string, id: number) {
    const room = this.room(code);
    const side = (["south", "north"] as Side[]).find((s) => room.tokens[s] === seatToken);
    if (!side) throw new HubError("That seat belongs to someone else.");
    this.seat(room, side, conn, id);
  }

  quick(conn: Conn, options: { size: BoardSize; roadworks: boolean; clock: ClockPreset }, id: number) {
    const now = this.now();
    for (const room of this.rooms.values()) {
      const g = room.game;
      if (
        g.status !== "open" ||
        !g.isPublic ||
        g.setup.size !== options.size ||
        g.setup.roadworks !== options.roadworks ||
        g.setup.clock !== options.clock
      )
        continue;
      const hostSide: Side = g.players.south ? "south" : "north";
      // Skip your own lobby, and lobbies whose host has already walked away.
      if (room.clientIds[hostSide] === conn.clientId || room.conns[hostSide].size === 0) continue;
      if (now - g.createdAt > OPEN_ROOM_TTL_MS) continue;
      return this.join(conn, g.code, id);
    }
    this.create(conn, { ...options, isPublic: true }, id);
  }

  cancel(conn: Conn, code: string) {
    const room = this.room(code);
    const side = conn.seats.get(code);
    if (!side) throw new HubError("You're not in that race.");
    if (room.game.status === "open") {
      for (const c of room.conns[side]) c.seats.delete(code);
      this.rooms.delete(code);
    }
  }

  move(conn: Conn, code: string, ply: number, action: DetourAction) {
    const { room, side } = this.mine(conn, code);
    // A stale or repeated submit (double click, retry after a reconnect) is refused, not replayed.
    if (ply !== room.game.moves.length) throw new HubError("The board moved on. Refreshing.");
    const now = this.now();
    // The server's own clock is the only one that counts for a move's time.
    const next = applyMove(room.game, side, action, now, now - room.game.turnStartedAt);
    if (next === OUT_OF_TIME) {
      this.flag(room, side, now);
      throw new HubError(next);
    }
    if (typeof next === "string") throw new HubError(next);
    room.game = next;
    this.broadcast(room, { t: "game", game: room.game });
  }

  /** Ends any timed race whose mover has run out of time. The server calls this a few times a second. */
  tickClocks() {
    const now = this.now();
    for (const room of this.rooms.values()) {
      const g = room.game;
      if (g.status !== "playing" || g.setup.clock === "off") continue;
      const times = gameClock(g, now - g.turnStartedAt);
      const mover = moverOf(g);
      if (times && times[mover] <= 0) this.flag(room, mover, now);
    }
  }

  private flag(room: Room, side: Side, now: number) {
    const next = timeoutGame(room.game, side, now);
    if (typeof next === "string") return;
    room.game = next;
    this.broadcast(room, { t: "game", game: room.game });
  }

  resign(conn: Conn, code: string) {
    const { room, side } = this.mine(conn, code);
    const next = resignGame(room.game, side, this.now());
    if (typeof next === "string") throw new HubError(next);
    room.game = next;
    this.broadcast(room, { t: "game", game: room.game });
  }

  /** Win by forfeit once the opponent has been gone for a full minute. */
  claim(conn: Conn, code: string) {
    const { room, side } = this.mine(conn, code);
    const other = opponentOf(side);
    const since = room.awaySince[other];
    if (room.conns[other].size > 0 || since === null || this.now() - since < ABANDON_AFTER_MS) {
      throw new HubError("Your opponent is still connected.");
    }
    const next = resignGame(room.game, other, this.now(), true);
    if (typeof next === "string") throw new HubError(next);
    room.game = next;
    this.broadcast(room, { t: "game", game: room.game });
  }

  rematch(conn: Conn, code: string) {
    const { room, side } = this.mine(conn, code);
    if (room.game.status !== "finished") throw new HubError("Finish this race first.");
    if (room.game.next) return;
    room.game = { ...room.game, rematch: { ...room.game.rematch, [side]: true }, updatedAt: this.now() };
    if (!(room.game.rematch.south && room.game.rematch.north)) {
      this.broadcast(room, { t: "game", game: room.game });
      return;
    }
    const nextCode = this.freshCode();
    const next = rematchGame(room.game, nextCode, this.now(), this.random);
    const nextRoom: Room = {
      game: next,
      tokens: { south: null, north: null },
      clientIds: { south: room.clientIds.north, north: room.clientIds.south },
      conns: { south: new Set(), north: new Set() },
      awaySince: { south: null, north: null },
    };
    this.rooms.set(nextCode, nextRoom);
    room.game = { ...room.game, next: nextCode, updatedAt: this.now() };
    this.broadcast(room, { t: "game", game: room.game });
    // Everyone at the old table sits down at the new one, sides swapped.
    for (const old of ["south", "north"] as Side[]) {
      for (const c of [...room.conns[old]]) this.seat(nextRoom, opponentOf(old), c, null);
    }
  }

  react(conn: Conn, code: string, text: string) {
    const { room, side } = this.mine(conn, code);
    if (!isReaction(text)) throw new HubError("Unknown reaction.");
    this.broadcast(room, { t: "reaction", code, side, text });
  }

  leave(conn: Conn, code: string) {
    const room = this.rooms.get(code);
    const side = conn.seats.get(code);
    conn.seats.delete(code);
    if (!room || !side) return;
    room.conns[side].delete(conn);
    this.noteAbsence(room, side);
  }

  disconnect(conn: Conn) {
    for (const code of [...conn.seats.keys()]) this.leave(conn, code);
  }

  /** Forget finished and abandoned rooms. Run periodically. */
  sweep() {
    const now = this.now();
    for (const [code, room] of this.rooms) {
      const empty = room.conns.south.size === 0 && room.conns.north.size === 0;
      const idle = now - room.game.updatedAt;
      if (
        (room.game.status === "open" && empty && idle > 60_000) ||
        idle > ROOM_TTL_MS ||
        (empty && idle > OPEN_ROOM_TTL_MS)
      ) {
        this.rooms.delete(code);
      }
    }
  }

  /** Everything needed to pick the hub back up later (a nearby host reloading its tab). */
  snapshot(): HubSnapshot {
    return [...this.rooms.values()].map((room) => ({
      game: room.game,
      tokens: room.tokens,
      clientIds: room.clientIds,
    }));
  }

  /** Puts rooms from a snapshot back. Nobody is connected yet, so everyone starts away. */
  restore(snapshot: unknown) {
    if (!Array.isArray(snapshot)) return;
    const now = this.now();
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    for (const entry of snapshot as Array<Partial<HubSnapshot[number]>>) {
      const game = parseGame(entry?.game);
      if (!game || this.rooms.has(game.code)) continue;
      this.rooms.set(game.code, {
        game,
        tokens: { south: text(entry.tokens?.south), north: text(entry.tokens?.north) },
        clientIds: { south: text(entry.clientIds?.south), north: text(entry.clientIds?.north) },
        conns: { south: new Set(), north: new Set() },
        awaySince: {
          south: game.players.south ? now : null,
          north: game.players.north ? now : null,
        },
      });
    }
  }

  // ---------------------------------------------------------------- internals

  private seat(room: Room, side: Side, conn: Conn, id: number | null) {
    const code = room.game.code;
    room.tokens[side] ??= token(16);
    room.clientIds[side] ??= conn.clientId;
    room.conns[side].add(conn);
    conn.seats.set(code, side);
    const wasAway = room.awaySince[side] !== null;
    room.awaySince[side] = null;
    conn.send({ t: "seat", id: id ?? 0, code, side, token: room.tokens[side]!, game: this.stamp(room.game) });
    // Tell the newcomer whether their opponent is here, and the opponent that they're back.
    const other = opponentOf(side);
    if (room.game.players[other]) {
      conn.send({
        t: "presence",
        code,
        side: other,
        here: room.conns[other].size > 0,
        since: room.awaySince[other],
      });
    }
    if (wasAway || room.conns[side].size === 1) {
      for (const c of room.conns[other]) c.send({ t: "presence", code, side, here: true, since: null });
    }
  }

  private noteAbsence(room: Room, side: Side) {
    if (room.conns[side].size > 0) return;
    room.awaySince[side] = this.now();
    const other = opponentOf(side);
    for (const c of room.conns[other]) {
      c.send({ t: "presence", code: room.game.code, side, here: false, since: room.awaySince[side] });
    }
  }

  private broadcast(room: Room, message: ServerMessage) {
    const stamped = message.t === "game" ? { ...message, game: this.stamp(room.game) } : message;
    for (const side of ["south", "north"] as Side[]) for (const c of room.conns[side]) c.send(stamped);
  }

  /** A copy of the game that says how far into the current turn we are right now. */
  private stamp(game: OnlineGame): OnlineGame {
    if (game.status !== "playing" || game.setup.clock === "off") return game;
    return { ...game, turnElapsedMs: Math.max(0, this.now() - game.turnStartedAt) };
  }

  private room(code: string): Room {
    const room = this.rooms.get(code);
    if (!room) throw new HubError("No race with that code. Check it and try again.");
    return room;
  }

  private mine(conn: Conn, code: string) {
    const room = this.room(code);
    const side = conn.seats.get(code);
    if (!side || sideOf(room.game, room.game.players[side]?.id ?? "") !== side) {
      throw new HubError("You're not in that race.");
    }
    return { room, side };
  }

  private freshCode(): string {
    for (;;) {
      const code = makeCode(this.random);
      if (!this.rooms.has(code)) return code;
    }
  }
}

/** Random hex from the platform's secure generator (Node and browsers alike). */
function token(bytes: number): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
