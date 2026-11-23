import type { DetourAction, Side } from "../engine/game";
import type { BoardSize } from "../engine/match";
import type { ClockPreset } from "../engine/clock";
import type { CreateOptions, OnlineGame } from "./game";
import type { Reaction } from "./protocol";

export type Unsubscribe = () => void;

export interface Presence {
  /** Is the opponent connected right now? `null` = this backend can't tell. */
  here: boolean | null;
  /** When they left (ms since epoch), if they're gone. */
  since: number | null;
}

/** One seat at one online race, as seen from this browser. */
export interface OnlineSession {
  readonly code: string;
  readonly you: Side;
  readonly backend: OnlineBackend;
  game(): OnlineGame;
  onGame(listener: (game: OnlineGame) => void): Unsubscribe;
  onPresence(listener: (presence: Presence) => void): Unsubscribe;
  onReaction(listener: (reaction: { side: Side; text: Reaction }) => void): Unsubscribe;
  /** A rematch was agreed: the table moved to a new race (and maybe a new side). */
  onSwitch(listener: (next: OnlineSession) => void): Unsubscribe;
  names(): Promise<Record<Side, string>>;
  /** Both sides' remaining time right now, or null for an untimed race. */
  clock(): Record<Side, number> | null;
  play(action: DetourAction): Promise<void>;
  resign(): Promise<void>;
  claim(): Promise<void>;
  rematch(): Promise<void>;
  react(text: Reaction): Promise<void>;
  /** Give up an open lobby nobody has joined yet. */
  cancel(): Promise<void>;
  /** Stop listening (the seat is kept and can be resumed). */
  leave(): void;
}

export type Readiness = { ok: true } | { ok: false; reason: string };

export interface OnlineBackend {
  kind: "server" | "claude";
  /** Plain words for where games are hosted, shown in the online setup. */
  description: string;
  /** Server games need a typed nickname; Claude pages already know who you are. */
  needsName: boolean;
  /** Whether online play can work for this viewer, and if not, why. */
  readiness(): Promise<Readiness>;
  create(options: CreateOptions, name: string): Promise<OnlineSession>;
  join(code: string, name: string): Promise<OnlineSession>;
  quick(
    options: { size: BoardSize; roadworks: boolean; clock: ClockPreset },
    name: string,
  ): Promise<OnlineSession>;
  /** Pick a seat back up after a reload, or null if this browser has no seat there. */
  resume(code: string): Promise<OnlineSession | null>;
  /** How someone else joins: a link where one exists, otherwise null (share the code). */
  inviteLink(code: string): string | null;
}

/** Small listener registry shared by both backends. */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();
  on(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(value: T) {
    for (const listener of [...this.listeners]) listener(value);
  }
}
