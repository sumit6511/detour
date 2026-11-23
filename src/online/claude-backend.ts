import type { DetourAction, Side } from "../engine/game";
import { opponentOf } from "../engine/game";
import type { BoardSize } from "../engine/match";
import { Emitter, type OnlineBackend, type OnlineSession, type Presence, type Readiness } from "./backend";
import {
  applyMove,
  makeCode,
  newGame,
  parseGame,
  rematchGame,
  resignGame,
  sideOf,
  type CreateOptions,
  type OnlineGame,
} from "./game";
import { ABANDON_AFTER_MS, isReaction, type Reaction } from "./protocol";

/*
 * The small slice of the Claude artifact runtime this game uses (`db`, `room`, `user`), typed
 * by hand from the platform's contract so the rest of the code stays independent of it.
 */
type Json = Record<string, unknown>;
export interface DocSnap {
  exists: boolean;
  data(): Json | undefined;
}
export interface DocRef {
  get(): Promise<DocSnap>;
  set(data: Json): Promise<void>;
  update(data: Json): Promise<void>;
  delete(): Promise<void>;
  acquire(options: { holder: string; ttlMs?: number }): Promise<{ acquired: boolean }>;
  onSnapshot(next: (snap: DocSnap) => void, error?: (e: { code: string }) => void): () => void;
}
export interface QueryRef {
  where(field: string, op: string, value: unknown): QueryRef;
  limit(n: number): QueryRef;
  get(): Promise<{ docs: DocSnap[] }>;
}
export interface Db {
  doc(path: string): DocRef;
  collection(path: string): QueryRef;
}
export interface RoomMessage {
  by: string | null;
  isMe: boolean;
  sameTab: boolean;
  data?: unknown;
}
export interface RoomPeer {
  by: string | null;
  isMe: boolean;
  presence: Readonly<Record<string, unknown>>;
}
export interface NamedRoom {
  emit(topic: string, data?: unknown): Promise<void>;
  on(topic: string, handler: (m: RoomMessage) => void): () => void;
  presence(patch: Record<string, unknown>): Promise<void>;
  onPeers(handler: (change: { peers: readonly RoomPeer[] }) => void): () => void;
  leave(): Promise<void>;
}
export interface Room {
  join(name: string): Promise<NamedRoom>;
}
export interface UserCap {
  id(): Promise<string | null>;
  can(name: string): Promise<boolean | null>;
  profiles(ids: readonly string[]): Promise<Record<string, { name: string }>>;
}
export interface ClaudeRuntime {
  use(name: string): Promise<unknown>;
}

const GAMES = "games";

/**
 * Online races hosted by the Claude page itself: each race is one shared `db` document that
 * both players subscribe to, and a named `room` per race carries presence and reactions. Anyone
 * this page is shared with at Contributor level or above can play.
 *
 * There is no server to referee, so each client checks every move with the engine before
 * writing it and replays the whole history it reads (parseGame cuts at the first illegal move).
 * Only the player whose turn it is ever writes a move, which keeps writes from colliding.
 */
export class ClaudeBackend implements OnlineBackend {
  kind = "claude" as const;
  needsName = false;
  description = "Games are stored with this page. Anyone it's shared with as a Contributor can play.";

  private constructor(
    private db: Db,
    private user: UserCap,
    private room: Room | null,
    private me: string | null,
    private writable: boolean | null,
    private now: () => number = Date.now,
  ) {}

  /** Null when this page isn't running inside a Claude viewer that offers shared data. */
  static async connect(runtime: ClaudeRuntime, now: () => number = Date.now): Promise<ClaudeBackend | null> {
    const [db, user, room] = (await Promise.all([
      runtime.use("db"),
      runtime.use("user"),
      runtime.use("room"),
    ])) as [Db | null, UserCap | null, Room | null];
    if (!db || !user) return null;
    const [me, writable] = await Promise.all([user.id(), user.can("data.write")]);
    return new ClaudeBackend(db, user, room, me, writable, now);
  }

  async readiness(): Promise<Readiness> {
    if (!this.me) return { ok: false, reason: "Sign in to claude.ai to play online on this page." };
    if (this.writable === false) {
      return {
        ok: false,
        reason: "To play online here, ask the page's owner to share it with you as a Contributor.",
      };
    }
    return { ok: true };
  }

  async create(options: CreateOptions) {
    const me = this.requireMe();
    const code = makeCode();
    const game = newGame(code, options, { id: me, name: "" }, this.now());
    await this.ref(code).set(toDoc(game));
    return this.session(game, me);
  }

  async join(code: string) {
    const me = this.requireMe();
    const ref = this.ref(code);
    const game = parseGame((await ref.get()).data());
    if (!game) throw new Error("No race with that code. Check it and try again.");
    if (sideOf(game, me)) return this.session(game, me);
    if (game.status !== "open") throw new Error("That race is already full.");
    // Claiming the empty seat: take a short lease so two people can't sit down at once.
    const lease = await ref.acquire({ holder: me, ttlMs: 4000 });
    if (!lease.acquired) throw new Error("Someone else is joining that race right now.");
    const fresh = parseGame((await ref.get()).data());
    const seat: Side | null = !fresh
      ? null
      : !fresh.players.south
        ? "south"
        : !fresh.players.north
          ? "north"
          : null;
    if (!fresh || !seat || fresh.status !== "open") throw new Error("That race is already full.");
    const joined: OnlineGame = {
      ...fresh,
      players: { ...fresh.players, [seat]: { id: me, name: "" } },
      status: "playing",
      updatedAt: this.now(),
    };
    await ref.update({ players: joined.players, status: "playing", updatedAt: joined.updatedAt });
    return this.session(joined, me);
  }

  async quick(options: { size: BoardSize; roadworks: boolean }) {
    const me = this.requireMe();
    const found = await this.db
      .collection(GAMES)
      .where("status", "==", "open")
      .where("isPublic", "==", true)
      .where("size", "==", options.size)
      .limit(25)
      .get();
    const fresh = found.docs
      .map((d) => parseGame(d.data()))
      .filter((g): g is OnlineGame => !!g && g.setup.roadworks === options.roadworks && !sideOf(g, me))
      .filter((g) => this.now() - g.createdAt < 10 * 60_000)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const candidate of fresh) {
      try {
        return await this.join(candidate.code);
      } catch {
        // Taken a moment ago; try the next one.
      }
    }
    return this.create({ ...options, isPublic: true });
  }

  async resume(code: string) {
    const me = this.me;
    if (!me) return null;
    const game = parseGame((await this.ref(code).get()).data());
    return game && sideOf(game, me) ? this.session(game, me) : null;
  }

  inviteLink() {
    return null; // The page can't know its own claude.ai address; players share the code.
  }

  // ---------------------------------------------------------------- internals

  ref(code: string) {
    return this.db.doc(`${GAMES}/${code}`);
  }

  async createRematch(previous: OnlineGame): Promise<string> {
    const code = makeCode();
    await this.ref(code).set(toDoc(rematchGame(previous, code, this.now())));
    return code;
  }

  async names(game: OnlineGame): Promise<Record<Side, string>> {
    const ids = [game.players.south?.id, game.players.north?.id].filter((x): x is string => !!x);
    const profiles = ids.length ? await this.user.profiles(ids) : {};
    const nameOf = (id?: string) => (id && profiles[id]?.name) || "Player";
    return { south: nameOf(game.players.south?.id), north: nameOf(game.players.north?.id) };
  }

  get clock() {
    return this.now;
  }

  private session(game: OnlineGame, me: string): OnlineSession {
    return new ClaudeSession(this, game, sideOf(game, me)!, me, this.room);
  }

  private requireMe(): string {
    if (!this.me) throw new Error("Sign in to claude.ai to play online on this page.");
    return this.me;
  }
}

/** The stored document: the game plus two top-level copies quick match can filter on. */
function toDoc(game: OnlineGame): Json {
  return { ...game, size: game.setup.size, roadworks: game.setup.roadworks } as unknown as Json;
}

class ClaudeSession implements OnlineSession {
  readonly code: string;
  private latest: OnlineGame;
  private games = new Emitter<OnlineGame>();
  private presences = new Emitter<Presence>();
  private reactions = new Emitter<{ side: Side; text: Reaction }>();
  private switches = new Emitter<OnlineSession>();
  private opponent: Presence = { here: null, since: null };
  private stopSnapshot: () => void;
  private named: NamedRoom | null = null;
  private roomStops: Array<() => void> = [];
  private writing: Promise<unknown> = Promise.resolve();
  private creating = false;
  private followed = false;
  private closed = false;

  constructor(
    readonly backend: ClaudeBackend,
    game: OnlineGame,
    readonly you: Side,
    private me: string,
    room: Room | null,
  ) {
    this.code = game.code;
    this.latest = game;
    this.stopSnapshot = backend.ref(this.code).onSnapshot(
      (snap) => {
        const next = parseGame(snap.data());
        if (!next) return;
        this.latest = next;
        this.games.emit(next);
        void this.followRematch(next);
      },
      () => this.presences.emit({ here: null, since: null }),
    );
    if (room) void this.joinRoom(room);
  }

  game() {
    return this.latest;
  }
  onGame(listener: (game: OnlineGame) => void) {
    return this.games.on(listener);
  }
  onPresence(listener: (p: Presence) => void) {
    listener(this.opponent);
    return this.presences.on(listener);
  }
  onReaction(listener: (r: { side: Side; text: Reaction }) => void) {
    return this.reactions.on(listener);
  }
  onSwitch(listener: (next: OnlineSession) => void) {
    return this.switches.on(listener);
  }
  names() {
    return this.backend.names(this.latest);
  }

  async play(action: DetourAction) {
    const next = applyMove(this.latest, this.you, action, this.backend.clock());
    if (typeof next === "string") throw new Error(next);
    this.latest = next;
    this.games.emit(next);
    await this.write({ moves: next.moves, status: next.status, updatedAt: next.updatedAt });
  }

  async resign() {
    const next = resignGame(this.latest, this.you, this.backend.clock());
    if (typeof next === "string") throw new Error(next);
    await this.write({ resigned: this.you, abandoned: false, status: "finished", updatedAt: next.updatedAt });
  }

  async claim() {
    const { here, since } = this.opponent;
    if (here !== false || since === null || this.backend.clock() - since < ABANDON_AFTER_MS) {
      throw new Error("Your opponent is still connected.");
    }
    const other = opponentOf(this.you);
    const next = resignGame(this.latest, other, this.backend.clock(), true);
    if (typeof next === "string") throw new Error(next);
    await this.write({ resigned: other, abandoned: true, status: "finished", updatedAt: next.updatedAt });
  }

  async rematch() {
    if (this.latest.status !== "finished") throw new Error("Finish this race first.");
    await this.write({ rematch: { [this.you]: true }, updatedAt: this.backend.clock() });
  }

  async react(text: Reaction) {
    if (!this.named) throw new Error("Reactions aren't available here.");
    await this.named.emit("react", { text, side: this.you });
  }

  async cancel() {
    const g = this.latest;
    if (g.status === "open" && sideOf(g, this.me))
      await this.backend
        .ref(this.code)
        .delete()
        .catch(() => {});
    this.leave();
  }

  leave() {
    if (this.closed) return;
    this.closed = true;
    this.stopSnapshot();
    for (const stop of this.roomStops) stop();
    void this.named?.leave().catch(() => {});
  }

  // One write at a time to the race document, in order.
  private write(patch: Record<string, unknown>) {
    const run = this.writing.then(() => this.backend.ref(this.code).update(patch));
    this.writing = run.catch(() => {});
    return run;
  }

  private async followRematch(game: OnlineGame) {
    if (game.status !== "finished") return;
    if (game.next) {
      if (this.followed) return;
      this.followed = true;
      const next = await this.backend.resume(game.next);
      if (next) this.switches.emit(next);
      else this.followed = false;
      return;
    }
    // Both want a rematch: the player who was South sets up the new race, once.
    if (game.rematch.south && game.rematch.north && this.you === "south" && !this.creating) {
      this.creating = true;
      try {
        const code = await this.backend.createRematch(game);
        await this.write({ next: code, updatedAt: this.backend.clock() });
      } catch {
        this.creating = false;
      }
    }
  }

  private async joinRoom(room: Room) {
    try {
      const named = await room.join(`detour-${this.code.toLowerCase()}`);
      if (this.closed) return void named.leave();
      this.named = named;
      await named.presence({ side: this.you });
      const other = opponentOf(this.you);
      this.roomStops.push(
        named.onPeers(({ peers }) => {
          const otherId = this.latest.players[other]?.id;
          const here = peers.some(
            (p) => !p.isMe && ((otherId && p.by === otherId) || p.presence?.side === other),
          );
          if (here === this.opponent.here) return;
          this.opponent = { here, since: here ? null : this.backend.clock() };
          this.presences.emit(this.opponent);
        }),
        named.on("react", (message) => {
          const data = message.data as { text?: unknown; side?: unknown } | undefined;
          if (!data || !isReaction(data.text)) return;
          // Trust the platform-stamped sender over anything inside the message.
          const side = message.isMe ? this.you : opponentOf(this.you);
          this.reactions.emit({ side, text: data.text });
        }),
      );
    } catch {
      this.named = null; // Presence and reactions simply stay off.
    }
  }
}
