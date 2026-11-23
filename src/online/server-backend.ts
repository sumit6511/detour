import type { DetourAction, Side } from "../engine/game";
import type { BoardSize } from "../engine/match";
import type { ClockPreset } from "../engine/clock";
import { Emitter, type OnlineBackend, type OnlineSession, type Presence, type Readiness } from "./backend";
import { applyMove, gameClock, parseGame, type CreateOptions, type OnlineGame } from "./game";
import type { ClientMessage, Reaction, ServerMessage } from "./protocol";

type Outgoing = ClientMessage extends infer M ? (M extends { id: number } ? Omit<M, "id"> : never) : never;
type SeatMessage = Extract<ServerMessage, { t: "seat" }>;

const SEATS_KEY = "detour:seats";
const CLIENT_KEY = "detour:client-id";

function storage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Without storage a reload just can't resume the seat.
  }
}

function clientId(): string {
  let id = storage<string | null>(CLIENT_KEY, null);
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    store(CLIENT_KEY, id);
  }
  return id;
}

/** Where the game server lives: an explicit build setting, or the page's own host. */
export function serverUrl(): string | null {
  const configured = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (configured) return configured;
  // A static build with no server behind it (GitHub Pages and the like) turns online play off.
  if (import.meta.env.VITE_ONLINE === "off") return null;
  if (typeof location === "undefined" || !location.protocol.startsWith("http")) return null;
  // The game server serves the game too, so its socket sits next to the page: /ws, or
  // /<folder>/ws when the game lives in a sub-folder.
  const url = new URL("./ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.hash = "";
  url.search = "";
  return url.toString();
}

/** The parts of a WebSocket this client uses. Nearby games supply their own over a direct link. */
export interface SocketLike {
  /** 1 while open, as with WebSocket.OPEN. */
  readonly readyState: number;
  send(text: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

export interface ServerBackendOptions {
  kind?: "server" | "nearby";
  description?: string;
  /** Opens a fresh connection. Default: a WebSocket to the backend's URL. */
  openSocket?: () => SocketLike;
  /** Reconnect by itself after a drop. True for the game server; nearby games re-pair instead. */
  reconnect?: boolean;
  /** Who this browser is to the referee. Default: one id per browser, kept in storage. */
  clientId?: string;
}

const OPEN = 1;

/**
 * Talks to a Detour referee over one connection shared by every session: the game server, or in
 * a nearby race the hub running in the host's tab. Re-takes each seat with its token whenever the
 * connection comes back (by itself, with backoff, for the server), so a dropped connection or a
 * reload puts the player straight back at the table.
 */
export class ServerBackend implements OnlineBackend {
  kind: "server" | "nearby";
  needsName = true;
  description: string;
  private socket: SocketLike | null = null;
  private opening: Promise<SocketLike> | null = null;
  private openSocket: () => SocketLike;
  readonly reconnects: boolean;
  private nextId = 1;
  private pending = new Map<number, { resolve: (m: ServerMessage) => void; reject: (e: Error) => void }>();
  private sessions = new Map<string, ServerSession>();
  /** Seat tokens, kept here as well as in storage so a seat survives blocked storage. */
  private tokens = new Map<string, string>();
  private name = "Player";
  private sentName: string | null = null;
  private retry = 0;
  private clientId: string | undefined;

  constructor(
    private url: string,
    options: ServerBackendOptions = {},
  ) {
    this.kind = options.kind ?? "server";
    this.reconnects = options.reconnect ?? true;
    this.clientId = options.clientId;
    this.openSocket = options.openSocket ?? (() => new WebSocket(this.url) as unknown as SocketLike);
    this.description =
      options.description ?? `Games are hosted on ${new URL(url.replace(/^ws/, "http")).host}.`;
  }

  async readiness(): Promise<Readiness> {
    try {
      await this.connect();
      return { ok: true };
    } catch {
      return {
        ok: false,
        reason: "Can't reach the game server right now. Check your connection and try again.",
      };
    }
  }

  async create(options: CreateOptions, name: string) {
    return this.seatFrom(await this.request({ t: "create", ...options }, name));
  }

  async join(code: string, name: string) {
    return this.seatFrom(await this.request({ t: "join", code }, name));
  }

  async quick(options: { size: BoardSize; roadworks: boolean; clock: ClockPreset }, name: string) {
    return this.seatFrom(await this.request({ t: "quick", ...options }, name));
  }

  async resume(code: string) {
    const token =
      this.tokens.get(code) ?? storage<Record<string, { token: string }>>(SEATS_KEY, {})[code]?.token;
    if (!token) return null;
    try {
      return this.seatFrom(await this.request({ t: "resume", code, token }));
    } catch {
      return null;
    }
  }

  inviteLink(code: string) {
    if (this.kind === "nearby") return null; // nearby players pair by QR code instead
    if (typeof location === "undefined" || !location.protocol.startsWith("http")) return null;
    return `${location.origin}${location.pathname}#join-${code.toLowerCase()}`;
  }

  // ---------------------------------------------------------------- plumbing

  async request(message: Outgoing, name?: string): Promise<ServerMessage> {
    if (name) this.name = name;
    const socket = await this.connect();
    // The socket may have opened before the player typed their name: introduce them again.
    if (this.sentName !== this.name) this.hello(socket);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The server didn't answer. Try again."));
      }, 8000);
      this.pending.set(id, {
        resolve: (m) => (clearTimeout(timer), resolve(m)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      socket.send(JSON.stringify({ ...message, id }));
    });
  }

  private hello(socket: SocketLike) {
    socket.send(
      JSON.stringify({ t: "hello", id: 0, name: this.name, clientId: this.clientId ?? clientId() }),
    );
    this.sentName = this.name;
  }

  private connect(): Promise<SocketLike> {
    if (this.socket?.readyState === OPEN) return Promise.resolve(this.socket);
    if (this.opening) return this.opening;
    this.opening = new Promise<SocketLike>((resolve, reject) => {
      const socket = this.openSocket();
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("timeout"));
      }, 5000);
      socket.onopen = () => {
        clearTimeout(timer);
        this.socket = socket;
        this.retry = 0;
        this.hello(socket);
        resolve(socket);
        // Back at the tables we were sitting at before the connection dropped.
        for (const session of this.sessions.values()) void session.reseat();
      };
      socket.onmessage = (event) => this.receive(JSON.parse(String(event.data)) as ServerMessage);
      socket.onerror = () => {
        clearTimeout(timer);
        reject(
          new Error(
            this.kind === "nearby"
              ? "Not linked to the other device right now."
              : "Can't reach the game server right now.",
          ),
        );
      };
      socket.onclose = () => {
        this.socket = null;
        for (const [, p] of this.pending) p.reject(new Error("Lost the connection to the server."));
        this.pending.clear();
        for (const session of this.sessions.values()) session.connection(false);
        if (this.sessions.size > 0 && this.reconnects) {
          const delay = Math.min(10_000, 500 * 2 ** this.retry++);
          setTimeout(() => void this.connect().catch(() => {}), delay);
        }
      };
    }).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private receive(message: ServerMessage) {
    if ((message.t === "ok" || message.t === "error" || message.t === "seat") && message.id) {
      const waiting = this.pending.get(message.id);
      if (waiting) {
        this.pending.delete(message.id);
        if (message.t === "error") return waiting.reject(new Error(message.message));
        // Take the seat now, so news that follows straight after (presence) finds its session.
        if (message.t === "seat") this.trySeat(message);
        waiting.resolve(message);
        return;
      }
    }
    if (message.t === "seat") {
      // Unrequested: a rematch seated us at a new table.
      const previous = [...this.sessions.values()].find(
        (s) => s.game().next === message.code || s.game().status === "finished",
      );
      const next = this.seatFrom(message);
      previous?.switchTo(next);
      return;
    }
    if (message.t === "game") {
      const game = parseGame(message.game);
      if (game) this.sessions.get(game.code)?.update(game);
    } else if (message.t === "presence") {
      this.sessions.get(message.code)?.presence({ here: message.here, since: message.since });
    } else if (message.t === "reaction") {
      this.sessions.get(message.code)?.reaction(message.side, message.text as Reaction);
    }
  }

  private seatFrom(message: ServerMessage): OnlineSession {
    if (message.t !== "seat") throw new Error("Unexpected reply from the server.");
    const game = parseGame(message.game);
    if (!game) throw new Error("The server sent a race this version can't read.");
    this.tokens.set(message.code, message.token);
    const seats = storage<Record<string, { token: string; at: number }>>(SEATS_KEY, {});
    seats[message.code] = { token: message.token, at: Date.now() };
    // Keep the ten most recent seats.
    const recent = Object.fromEntries(
      Object.entries(seats)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, 10),
    );
    store(SEATS_KEY, recent);
    const existing = this.sessions.get(message.code);
    if (existing) {
      existing.update(game);
      return existing;
    }
    const session = new ServerSession(this, message as SeatMessage, game);
    this.sessions.set(message.code, session);
    return session;
  }

  private trySeat(message: ServerMessage) {
    try {
      this.seatFrom(message);
    } catch {
      // The requester gets the same error when it reads the reply.
    }
  }

  forget(code: string) {
    this.sessions.delete(code);
  }
}

class ServerSession implements OnlineSession {
  readonly code: string;
  readonly you: Side;
  private latest: OnlineGame;
  private games = new Emitter<OnlineGame>();
  private presences = new Emitter<Presence>();
  private reactions = new Emitter<{ side: Side; text: Reaction }>();
  private switches = new Emitter<OnlineSession>();
  private opponent: Presence = { here: null, since: null };
  /** When this browser received the latest copy (the server says how far into the turn it was). */
  private receivedAt = Date.now();

  constructor(
    readonly backend: ServerBackend,
    seat: SeatMessage,
    game: OnlineGame,
  ) {
    this.code = seat.code;
    this.you = seat.side;
    this.latest = game;
  }

  game() {
    return this.latest;
  }
  onGame(listener: (game: OnlineGame) => void) {
    return this.games.on(listener);
  }
  onPresence(listener: (presence: Presence) => void) {
    listener(this.opponent);
    return this.presences.on(listener);
  }
  onReaction(listener: (r: { side: Side; text: Reaction }) => void) {
    return this.reactions.on(listener);
  }
  onSwitch(listener: (next: OnlineSession) => void) {
    return this.switches.on(listener);
  }

  async names() {
    const g = this.latest;
    return { south: g.players.south?.name || "Player", north: g.players.north?.name || "Player" };
  }

  clock() {
    const g = this.latest;
    return gameClock(g, g.turnElapsedMs + (Date.now() - this.receivedAt));
  }

  async play(action: DetourAction) {
    // Show the move at once; the server's echo confirms it, or we put the board back.
    const before = this.latest;
    const spent = before.turnElapsedMs + (Date.now() - this.receivedAt);
    const next = applyMove(before, this.you, action, Date.now(), spent);
    if (typeof next === "string") throw new Error(next);
    this.update(next);
    try {
      await this.backend.request({ t: "move", code: this.code, ply: before.moves.length, action });
    } catch (error) {
      if (this.latest === next) this.update(before);
      throw error;
    }
  }
  async resign() {
    await this.backend.request({ t: "resign", code: this.code });
  }
  async claim() {
    await this.backend.request({ t: "claim", code: this.code });
  }
  async rematch() {
    await this.backend.request({ t: "rematch", code: this.code });
  }
  async react(text: Reaction) {
    await this.backend.request({ t: "react", code: this.code, text });
  }
  async cancel() {
    await this.backend.request({ t: "cancel", code: this.code }).catch(() => {});
    this.leave();
  }
  leave() {
    void this.backend.request({ t: "leave", code: this.code }).catch(() => {});
    this.backend.forget(this.code);
  }

  // Called by the backend.
  update(game: OnlineGame) {
    this.latest = game;
    this.receivedAt = Date.now();
    this.games.emit(game);
  }
  presence(p: Presence) {
    this.opponent = p;
    this.presences.emit(p);
  }
  reaction(side: Side, text: Reaction) {
    this.reactions.emit({ side, text });
  }
  switchTo(next: OnlineSession) {
    this.switches.emit(next);
  }
  connection(up: boolean) {
    // Reconnecting by itself: "can't tell" for a moment. A nearby link that dropped: they're gone.
    if (!up) this.presences.emit({ here: this.backend.reconnects ? null : false, since: null });
  }
  async reseat() {
    await this.backend.resume(this.code);
  }
}
