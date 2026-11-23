import type { DetourAction, Side } from "../engine/game.js";
import type { BoardSize } from "../engine/match.js";
import type { OnlineGame } from "./game.js";

/** Messages a browser sends the game server. `id` pairs a request with its reply. */
export type ClientMessage =
  | { t: "hello"; id: number; name: string; clientId: string }
  | { t: "create"; id: number; size: BoardSize; roadworks: boolean; isPublic: boolean }
  | { t: "join"; id: number; code: string }
  | { t: "resume"; id: number; code: string; token: string }
  | { t: "quick"; id: number; size: BoardSize; roadworks: boolean }
  | { t: "cancel"; id: number; code: string }
  | { t: "move"; id: number; code: string; ply: number; action: DetourAction }
  | { t: "resign"; id: number; code: string }
  | { t: "claim"; id: number; code: string }
  | { t: "rematch"; id: number; code: string }
  | { t: "react"; id: number; code: string; text: string }
  | { t: "leave"; id: number; code: string };

/** Messages the server sends. */
export type ServerMessage =
  | { t: "ok"; id: number }
  | { t: "error"; id: number | null; message: string }
  | { t: "seat"; id: number; code: string; side: Side; token: string; game: OnlineGame }
  | { t: "game"; game: OnlineGame }
  | { t: "presence"; code: string; side: Side; here: boolean; since: number | null }
  | { t: "reaction"; code: string; side: Side; text: string };

/** Quick reactions: a fixed menu, so nobody can send anything else to a stranger. */
export const REACTIONS = ["Nice move", "Good luck", "Oops", "Good game", "Rematch?"] as const;
export type Reaction = (typeof REACTIONS)[number];
export const isReaction = (text: unknown): text is Reaction =>
  typeof text === "string" && (REACTIONS as readonly string[]).includes(text);

/** How long an opponent must be gone before the other player may claim the win. */
export const ABANDON_AFTER_MS = 60_000;
