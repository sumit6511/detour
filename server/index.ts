import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { cleanName } from "../src/online/game.js";
import type { ClientMessage, ServerMessage } from "../src/online/protocol.js";
import { Hub, HubError, type Conn } from "./hub.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

export interface ServerOptions {
  port?: number;
  /** The built client (`dist/`), served from the same origin as the socket when present. */
  staticDir?: string;
  /** Comma-separated origins allowed to open a socket; empty allows any. */
  allowedOrigins?: string[];
  hub?: Hub;
}

/** Starts the HTTP + WebSocket server. Resolves once it is listening. */
export function startServer(
  options: ServerOptions = {},
): Promise<{ server: Server; hub: Hub; port: number; close: () => Promise<void> }> {
  const hub = options.hub ?? new Hub();
  const staticDir = options.staticDir ? resolve(options.staticDir) : null;
  const allowed = (options.allowedOrigins ?? []).filter(Boolean);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end(`ok ${hub.size} rooms`);
      return;
    }
    if (!staticDir || !existsSync(staticDir)) {
      res
        .writeHead(404, { "content-type": "text/plain" })
        .end("Detour game server. Build the client to serve it here.");
      return;
    }
    // Static files, with a fallback to index.html; never outside the static folder.
    const wanted = normalize(join(staticDir, decodeURIComponent(url.pathname)));
    let file =
      wanted.startsWith(staticDir) && existsSync(wanted) && statSync(wanted).isFile()
        ? wanted
        : join(staticDir, "index.html");
    if (!existsSync(file)) file = join(staticDir, "index.html");
    const type = MIME[extname(file)] ?? "application/octet-stream";
    const cache = file.includes(`${join(staticDir, "assets")}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache";
    res.writeHead(200, { "content-type": type, "cache-control": cache });
    createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 16 * 1024,
    verifyClient: ({ req }: { req: IncomingMessage }) =>
      !allowed.length || allowed.includes(req.headers.origin ?? ""),
  });

  wss.on("connection", (socket: WebSocket) => {
    const conn: Conn = {
      clientId: "",
      name: "Player",
      seats: new Map(),
      send: (message: ServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
    };
    let alive = true;
    let budget = 30; // simple flood guard: about 10 messages a second sustained
    const refill = setInterval(() => (budget = Math.min(30, budget + 10)), 1000);
    socket.on("pong", () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 25_000);

    socket.on("message", (raw) => {
      if (--budget < 0) return conn.send({ t: "error", id: null, message: "Slow down a little." });
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return conn.send({ t: "error", id: null, message: "Unreadable message." });
      }
      const id = typeof message?.id === "number" ? message.id : 0;
      try {
        handle(hub, conn, message);
        if (
          message.t !== "create" &&
          message.t !== "join" &&
          message.t !== "resume" &&
          message.t !== "quick"
        ) {
          conn.send({ t: "ok", id });
        }
      } catch (error) {
        const text = error instanceof HubError ? error.message : "Something went wrong on the server.";
        if (!(error instanceof HubError)) console.error(error);
        conn.send({ t: "error", id, message: text });
      }
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      clearInterval(refill);
      hub.disconnect(conn);
    });
  });

  const sweeper = setInterval(() => hub.sweep(), 60_000);

  return new Promise((done) => {
    server.listen(options.port ?? 8787, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (options.port ?? 8787);
      done({
        server,
        hub,
        port,
        close: () =>
          new Promise<void>((closed) => {
            clearInterval(sweeper);
            for (const client of wss.clients) client.terminate();
            wss.close();
            server.close(() => closed());
          }),
      });
    });
  });
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
        { size: m.size, roadworks: m.roadworks === true, isPublic: m.isPublic === true },
        m.id,
      );
    case "quick":
      if (!isSize(m.size)) throw new HubError("Pick a board size.");
      return hub.quick(conn, { size: m.size, roadworks: m.roadworks === true }, m.id);
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

// Run directly: `node server-dist/index.mjs` (or `tsx server/index.ts` in development).
const entry = process.argv[1] ?? "";
if (entry.endsWith("index.ts") || entry.endsWith("index.mjs")) {
  const port = Number(process.env.PORT ?? 8787);
  const staticDir = process.env.STATIC_DIR ?? resolve(process.cwd(), "dist");
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim());
  void startServer({ port, staticDir, allowedOrigins }).then(({ port: listening }) => {
    console.log(`Detour server on http://localhost:${listening} (socket at /ws)`);
  });
}
