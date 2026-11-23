import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { ServerMessage } from "../src/online/protocol.js";
import { Hub, type Conn } from "../src/online/hub.js";
import { dispatch } from "../src/online/referee.js";

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
      dispatch(hub, conn, String(raw));
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      clearInterval(refill);
      hub.disconnect(conn);
    });
  });

  const sweeper = setInterval(() => hub.sweep(), 60_000);
  const clocks = setInterval(() => hub.tickClocks(), 200);

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
            clearInterval(clocks);
            for (const client of wss.clients) client.terminate();
            wss.close();
            server.close(() => closed());
          }),
      });
    });
  });
}

/** Addresses other devices on the same network can reach this machine at. */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => !!a && a.family === "IPv4" && !a.internal)
    .map((a) => a!.address);
}

// Run directly: `node server-dist/index.mjs` (or `tsx server/index.ts` in development).
const entry = process.argv[1] ?? "";
if (entry.endsWith("index.ts") || entry.endsWith("index.mjs")) {
  const port = Number(process.env.PORT ?? 8787);
  const staticDir = process.env.STATIC_DIR ?? resolve(process.cwd(), "dist");
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim());
  void startServer({ port, staticDir, allowedOrigins }).then(({ port: listening }) => {
    console.log(`Detour server on http://localhost:${listening} (socket at /ws)`);
    const lan = lanAddresses();
    if (lan.length) {
      console.log("Other devices on this network can play at:");
      for (const address of lan) console.log(`  http://${address}:${listening}`);
    }
  });
}
