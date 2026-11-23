import { isClockPreset } from "../engine/clock.js";
import { cleanName } from "./game.js";
import { Hub, HubError, type Conn } from "./hub.js";
import type { ClientMessage } from "./protocol.js";

/**
 * Handles one raw message from a player: parse it, check its shape, apply it to the hub, and
 * answer "ok" or "error". Shared by the game server and by the host's browser in a nearby game,
 * so both referee identically.
 */
export function dispatch(hub: Hub, conn: Conn, raw: string) {
  let message: ClientMessage;
  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    return conn.send({ t: "error", id: null, message: "Unreadable message." });
  }
  const id = typeof message?.id === "number" ? message.id : 0;
  try {
    handle(hub, conn, message);
    // Seating requests answer with the seat itself; everything else gets a plain "ok".
    if (message.t !== "create" && message.t !== "join" && message.t !== "resume" && message.t !== "quick") {
      conn.send({ t: "ok", id });
    }
  } catch (error) {
    const text = error instanceof HubError ? error.message : "Something went wrong.";
    if (!(error instanceof HubError)) console.error(error);
    conn.send({ t: "error", id, message: text });
  }
}

const isSize = (v: unknown): v is 7 | 9 => v === 7 || v === 9;
const isCode = (v: unknown): v is string => typeof v === "string" && /^[A-Z0-9]{5}$/.test(v);

/** Validates the shape of each message before it reaches the hub. */
function handle(hub: Hub, conn: Conn, m: ClientMessage) {
  if (!m || typeof m !== "object" || typeof m.t !== "string") throw new HubError("Unknown message.");
  if (m.t === "hello") {
    conn.name = cleanName(String(m.name ?? "")) || "Player";
    conn.clientId = typeof m.clientId === "string" ? m.clientId.slice(0, 64) : "";
    return;
  }
  if (!conn.clientId) throw new HubError("Say hello first.");
  switch (m.t) {
    case "create":
      if (!isSize(m.size)) throw new HubError("Pick a board size.");
      return hub.create(
        conn,
        {
          size: m.size,
          roadworks: m.roadworks === true,
          clock: isClockPreset(m.clock) ? m.clock : "off",
          isPublic: m.isPublic === true,
        },
        m.id,
      );
    case "quick":
      if (!isSize(m.size)) throw new HubError("Pick a board size.");
      return hub.quick(
        conn,
        { size: m.size, roadworks: m.roadworks === true, clock: isClockPreset(m.clock) ? m.clock : "off" },
        m.id,
      );
    case "join":
      if (!isCode(m.code)) throw new HubError("That code doesn't look right.");
      return hub.join(conn, m.code, m.id);
    case "resume":
      if (!isCode(m.code) || typeof m.token !== "string") throw new HubError("Can't resume that race.");
      return hub.resume(conn, m.code, m.token, m.id);
    case "cancel":
      if (!isCode(m.code)) throw new HubError("Unknown race.");
      return hub.cancel(conn, m.code);
    case "move": {
      if (!isCode(m.code) || !Number.isInteger(m.ply) || !m.action || typeof m.action !== "object") {
        throw new HubError("Malformed move.");
      }
      const a = m.action;
      const action =
        a.type === "step"
          ? { type: "step" as const, row: Number(a.row), col: Number(a.col) }
          : a.type === "wall" && (a.orientation === "h" || a.orientation === "v")
            ? { type: "wall" as const, orientation: a.orientation, row: Number(a.row), col: Number(a.col) }
            : null;
      if (!action || !Number.isInteger(action.row) || !Number.isInteger(action.col))
        throw new HubError("Malformed move.");
      return hub.move(conn, m.code, m.ply, action);
    }
    case "resign":
      if (!isCode(m.code)) throw new HubError("Unknown race.");
      return hub.resign(conn, m.code);
    case "claim":
      if (!isCode(m.code)) throw new HubError("Unknown race.");
      return hub.claim(conn, m.code);
    case "rematch":
      if (!isCode(m.code)) throw new HubError("Unknown race.");
      return hub.rematch(conn, m.code);
    case "react":
      if (!isCode(m.code)) throw new HubError("Unknown race.");
      return hub.react(conn, m.code, String(m.text));
    case "leave":
      if (!isCode(m.code)) throw new HubError("Unknown race.");
      return hub.leave(conn, m.code);
    default:
      throw new HubError("Unknown message.");
  }
}
