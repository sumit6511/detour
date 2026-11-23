import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../src/online/protocol.js";
import type { OnlineGame } from "../src/online/game.js";
import { Hub, type Conn } from "./hub.js";
import { startServer } from "./index.js";

type Outgoing = ClientMessage extends infer M ? (M extends { id: number } ? Omit<M, "id"> : never) : never;

/** A tiny test client: request/response by id, plus a log of everything pushed. */
async function client(port: number, name: string, clientId = name) {
  const socket = new WebSocket(`ws://localhost:${port}/ws`);
  await new Promise((open) => socket.once("open", open));
  const inbox: ServerMessage[] = [];
  const waiters: Array<(m: ServerMessage) => boolean> = [];
  socket.on("message", (raw) => {
    const m = JSON.parse(String(raw)) as ServerMessage;
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!(m)) waiters.splice(i, 1);
  });
  let nextId = 1;
  const until = (test: (m: ServerMessage) => boolean) =>
    new Promise<ServerMessage>((done, fail) => {
      const hit = inbox.find(test);
      if (hit) return done(hit);
      const timer = setTimeout(() => fail(new Error("timed out waiting for a message")), 3000);
      waiters.push((m) => (test(m) ? (clearTimeout(timer), done(m), true) : false));
    });
  const request = async (message: Outgoing) => {
    const id = nextId++;
    socket.send(JSON.stringify({ ...message, id }));
    return until((m) => "id" in m && m.id === id);
  };
  await request({ t: "hello", name, clientId });
  const lastGame = (code: string) =>
    [...inbox]
      .reverse()
      .find((m): m is Extract<ServerMessage, { t: "game" }> => m.t === "game" && m.game.code === code)?.game;
  return { socket, inbox, request, until, lastGame, close: () => socket.close() };
}

let port = 0;
let stop: () => Promise<void>;

beforeAll(async () => {
  const started = await startServer({ port: 0 });
  port = started.port;
  stop = started.close;
});
afterAll(async () => stop());

describe("game server", () => {
  it("runs a private race from invite code to rematch", async () => {
    const alice = await client(port, "Alice");
    const bob = await client(port, "Bob");

    const created = await alice.request({
      t: "create",
      size: 7,
      roadworks: false,
      clock: "off",
      isPublic: false,
    });
    expect(created.t).toBe("seat");
    if (created.t !== "seat") return;
    const code = created.code;
    expect(created.game.status).toBe("open");

    const joined = await bob.request({ t: "join", code });
    expect(joined.t).toBe("seat");
    if (joined.t !== "seat") return;
    expect(joined.side).not.toBe(created.side);
    await alice.until((m) => m.t === "game" && m.game.status === "playing");

    const first = created.side === "south" ? alice : bob;
    const second = first === alice ? bob : alice;
    // Out of turn, and an illegal jump, are both refused with a reason.
    expect(
      await second.request({ t: "move", code, ply: 0, action: { type: "step", row: 1, col: 3 } }),
    ).toMatchObject({
      t: "error",
      message: "It's not your turn.",
    });
    expect(
      await first.request({ t: "move", code, ply: 0, action: { type: "step", row: 4, col: 3 } }),
    ).toMatchObject({
      t: "error",
    });
    expect(
      await first.request({ t: "move", code, ply: 0, action: { type: "step", row: 5, col: 3 } }),
    ).toMatchObject({
      t: "ok",
    });
    await second.until((m) => m.t === "game" && m.game.moves.length === 1);
    // A duplicate submit of the same ply is refused instead of applied twice.
    expect(
      (await first.request({ t: "move", code, ply: 0, action: { type: "step", row: 4, col: 3 } })).t,
    ).toBe("error");

    await second.request({ t: "react", code, text: "Nice move" });
    await first.until((m) => m.t === "reaction" && m.text === "Nice move");

    await second.request({ t: "resign", code });
    const over = (await first.until((m) => m.t === "game" && m.game.status === "finished")) as {
      game: OnlineGame;
    };
    expect(over.game.resigned).toBe(first === alice ? joined.side : created.side);

    await alice.request({ t: "rematch", code });
    await bob.request({ t: "rematch", code });
    const aliceSeat = await alice.until((m) => m.t === "seat" && m.code !== code);
    const bobSeat = await bob.until((m) => m.t === "seat" && m.code !== code);
    if (aliceSeat.t !== "seat" || bobSeat.t !== "seat") return;
    expect(aliceSeat.code).toBe(bobSeat.code);
    expect(aliceSeat.side).toBe(joined.side); // sides swap
    expect(aliceSeat.game.status).toBe("playing");

    alice.close();
    bob.close();
  });

  it("pairs strangers through quick match, never with themselves", async () => {
    const carol = await client(port, "Carol");
    const carolAgain = await client(port, "Carol", "Carol"); // same browser, second tab
    const dave = await client(port, "Dave");

    const waiting = await carol.request({ t: "quick", size: 9, roadworks: true, clock: "off" });
    if (waiting.t !== "seat") throw new Error("expected a seat");
    expect(waiting.game.status).toBe("open");

    const sameBrowser = await carolAgain.request({ t: "quick", size: 9, roadworks: true, clock: "off" });
    if (sameBrowser.t !== "seat") throw new Error("expected a seat");
    expect(sameBrowser.code).not.toBe(waiting.code);
    await carolAgain.request({ t: "cancel", code: sameBrowser.code });

    const matched = await dave.request({ t: "quick", size: 9, roadworks: true, clock: "off" });
    if (matched.t !== "seat") throw new Error("expected a seat");
    expect(matched.code).toBe(waiting.code);
    expect(matched.game.status).toBe("playing");
    expect(matched.game.setup.size).toBe(9);

    carol.close();
    carolAgain.close();
    dave.close();
  });

  it("lets a player reconnect to their seat with its token, and tells the opponent", async () => {
    const erin = await client(port, "Erin");
    const frank = await client(port, "Frank");
    const seat = await erin.request({
      t: "create",
      size: 7,
      roadworks: false,
      clock: "off",
      isPublic: false,
    });
    if (seat.t !== "seat") throw new Error("expected a seat");
    await frank.request({ t: "join", code: seat.code });

    erin.close();
    await frank.until((m) => m.t === "presence" && !m.here);

    const back = await client(port, "Erin", "Erin");
    const resumed = await back.request({ t: "resume", code: seat.code, token: seat.token });
    expect(resumed).toMatchObject({ t: "seat", side: seat.side });
    await frank.until((m) => m.t === "presence" && m.here);
    expect((await frank.request({ t: "resume", code: seat.code, token: "nope" })).t).toBe("error");

    back.close();
    frank.close();
  });

  it("serves a health check", async () => {
    const res = await fetch(`http://localhost:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/^ok/);
  });
});

describe("hub forfeits", () => {
  it("allows claiming the win only after the opponent has been gone a full minute", () => {
    let now = 1_000_000;
    const hub = new Hub(() => now);
    const conn = (clientId: string): Conn & { log: ServerMessage[] } => {
      const log: ServerMessage[] = [];
      return { clientId, name: clientId, seats: new Map(), send: (m) => log.push(m), log };
    };
    const a = conn("a");
    const b = conn("b");
    hub.create(a, { size: 7, roadworks: false, clock: "off", isPublic: false }, 1);
    const code = [...a.seats.keys()][0]!;
    hub.join(b, code, 1);

    expect(() => hub.claim(a, code)).toThrow("still connected");
    hub.disconnect(b);
    now += 30_000;
    expect(() => hub.claim(a, code)).toThrow("still connected");
    now += 31_000;
    hub.claim(a, code);
    const game = hub.game(code)!;
    expect(game.status).toBe("finished");
    expect(game.abandoned).toBe(true);
    expect(game.resigned).toBe(
      b.seats.size === 0 ? (a.seats.get(code) === "south" ? "north" : "south") : null,
    );
  });
});

describe("hub clocks", () => {
  it("times moves on the server, flags a player who runs out, and refuses late moves", () => {
    let now = 5_000_000;
    const hub = new Hub(() => now);
    const conn = (clientId: string): Conn & { log: ServerMessage[] } => {
      const log: ServerMessage[] = [];
      return { clientId, name: clientId, seats: new Map(), send: (m) => log.push(m), log };
    };
    const a = conn("a");
    const b = conn("b");
    hub.create(a, { size: 7, roadworks: false, clock: "3+2", isPublic: false }, 1);
    const code = [...a.seats.keys()][0]!;
    now += 60_000; // a minute in the lobby doesn't count
    hub.join(b, code, 1);
    const south = a.seats.get(code) === "south" ? a : b;
    const north = south === a ? b : a;

    now += 10_000;
    hub.move(south, code, 0, { type: "step", row: 5, col: 3 });
    expect(hub.game(code)!.moves[0]!.spentMs).toBe(10_000);

    // Copies sent mid-turn carry how far into the turn they are.
    now += 4_000;
    hub.react(north, code, "Good luck");
    hub.tickClocks();
    expect(hub.game(code)!.status).toBe("playing");

    now += 180_000; // north thinks too long
    expect(() => hub.move(north, code, 1, { type: "step", row: 1, col: 3 })).toThrow("Your time ran out.");
    const over = hub.game(code)!;
    expect(over.status).toBe("finished");
    expect(over.timedOut).toBe("north");
  });

  it("flags on the clock tick even if the player never moves again", () => {
    let now = 0;
    const hub = new Hub(() => now);
    const log: ServerMessage[] = [];
    const mk = (id: string): Conn => ({ clientId: id, name: id, seats: new Map(), send: (m) => log.push(m) });
    const a = mk("a");
    const b = mk("b");
    hub.create(a, { size: 7, roadworks: false, clock: "3+2", isPublic: false }, 1);
    const code = [...a.seats.keys()][0]!;
    hub.join(b, code, 1);
    now += 179_999;
    hub.tickClocks();
    expect(hub.game(code)!.status).toBe("playing");
    now += 2;
    hub.tickClocks();
    expect(hub.game(code)!.timedOut).toBe("south");
    const sent = log.filter((m): m is Extract<ServerMessage, { t: "game" }> => m.t === "game").at(-1)!;
    expect(sent.game.status).toBe("finished");
  });

  it("only pairs quick-match players who chose the same clock", () => {
    const hub = new Hub();
    const mk = (id: string): Conn => ({ clientId: id, name: id, seats: new Map(), send: () => {} });
    const a = mk("a");
    const b = mk("b");
    hub.quick(a, { size: 7, roadworks: false, clock: "5+3" }, 1);
    hub.quick(b, { size: 7, roadworks: false, clock: "off" }, 1);
    expect([...a.seats.keys()][0]).not.toBe([...b.seats.keys()][0]);
  });
});
