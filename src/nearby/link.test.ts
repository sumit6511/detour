import { afterEach, describe, expect, it, vi } from "vitest";
import type { OnlineSession, Presence } from "../online/backend";
import { Hub } from "../online/hub";
import { ServerBackend } from "../online/server-backend";
import { ChannelSocket, NearbyHost, attachChannel, type ChannelLike } from "./link";

type Listener = (event: { data: unknown }) => void;

/** One end of an in-memory data channel. Messages arrive asynchronously, as they would. */
class FakeChannel implements ChannelLike {
  readyState: RTCDataChannelState = "open";
  other!: FakeChannel;
  private listeners: Record<string, Listener[]> = {};
  addEventListener(type: string, listener: Listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, event: { data: unknown } = { data: undefined }) {
    for (const l of this.listeners[type] ?? []) l(event);
  }
  send(text: string) {
    if (this.readyState !== "open") throw new Error("closed");
    setTimeout(() => this.other.readyState === "open" && this.other.emit("message", { data: text }), 0);
  }
  close() {
    for (const end of [this, this.other]) {
      if (end.readyState === "closed") continue;
      end.readyState = "closed";
      setTimeout(() => end.emit("close"), 0);
    }
  }
}

function channelPair(): [FakeChannel, FakeChannel] {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.other = b;
  b.other = a;
  return [a, b];
}

const until = async (check: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** A guest whose connection is whatever channel is current, like NearbyGuest. */
function guestBackend() {
  let current: FakeChannel | null = null;
  const backend = new ServerBackend("nearby:guest", {
    kind: "nearby",
    reconnect: false,
    description: "test",
    clientId: "guest-browser",
    openSocket: () => new ChannelSocket(current),
  });
  return { backend, use: (channel: FakeChannel) => (current = channel) };
}

const OPTIONS = { size: 7 as const, roadworks: false, clock: "off" as const, isPublic: false };

function presenceOf(session: OnlineSession) {
  const seen: Presence[] = [];
  session.onPresence((p) => seen.push(p));
  return seen;
}

afterEach(() => vi.useRealTimers());

describe("nearby link", () => {
  it("plays a race between the host's own seat and a guest over a channel", async () => {
    const host = new NearbyHost();
    const hosted = await host.backend.create(OPTIONS, "Ana");
    expect(hosted.game().status).toBe("open");
    expect(host.backend.inviteLink(hosted.code)).toBeNull();

    const [hostEnd, guestEnd] = channelPair();
    attachChannel(host.hub, hostEnd);
    const guest = guestBackend();
    guest.use(guestEnd);
    const joined = await guest.backend.join(hosted.code, "Ben");

    await until(() => hosted.game().status === "playing");
    expect(joined.you).not.toBe(hosted.you);
    expect(await hosted.names()).toMatchObject({ [joined.you]: "Ben", [hosted.you]: "Ana" });

    // Whoever is south moves first; the other sees it through the referee.
    const [first, second] = hosted.you === "south" ? [hosted, joined] : [joined, hosted];
    await first.play({ type: "step", row: 5, col: 3 });
    await until(() => second.game().moves.length === 1);
    await second.play({ type: "step", row: 1, col: 3 });
    await until(() => first.game().moves.length === 2);
    // The referee refuses an illegal move.
    await expect(first.play({ type: "step", row: 0, col: 0 })).rejects.toThrow();
    expect(host.hub.game(hosted.code)?.moves.length).toBe(2);
  });

  it("sees a dropped guest leave, and lets them back into their seat over a new link", async () => {
    const host = new NearbyHost();
    const hosted = await host.backend.create(OPTIONS, "Ana");
    const seen = presenceOf(hosted);
    const guest = guestBackend();
    const [a1, b1] = channelPair();
    attachChannel(host.hub, a1);
    guest.use(b1);
    const joined = await guest.backend.join(hosted.code, "Ben");
    const guestSeen = presenceOf(joined);
    await until(() => seen.some((p) => p.here === true));

    a1.close();
    await until(() => seen.at(-1)?.here === false);
    // The guest can tell the link is gone, and nothing can reach the host until it's back.
    await until(() => guestSeen.at(-1)?.here === false);
    await expect(joined.react("Nice move")).rejects.toThrow(/Not linked/);

    // Pair again: a new channel, and the same seat comes back with its token.
    const [a2, b2] = channelPair();
    attachChannel(host.hub, a2);
    guest.use(b2);
    const back = await guest.backend.resume(hosted.code);
    expect(back).toBe(joined);
    await until(() => seen.at(-1)?.here === true);
    expect(host.hub.game(hosted.code)?.status).toBe("playing");
  });

  it("runs the clock in the host's tab and flags a racer who runs out", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    const host = new NearbyHost();
    const hosted = await host.backend.create({ ...OPTIONS, clock: "3+2" }, "Ana");
    const [a, b] = channelPair();
    attachChannel(host.hub, a);
    const guest = guestBackend();
    guest.use(b);
    await guest.backend.join(hosted.code, "Ben");
    await until(() => hosted.game().status === "playing");

    vi.advanceTimersByTime(3 * 60_000 + 1000);
    await until(() => hosted.game().status === "finished");
    expect(hosted.game().timedOut).toBe("south");
  });

  it("ignores oversized or non-text messages from a channel", async () => {
    const host = new NearbyHost();
    const [a, b] = channelPair();
    attachChannel(host.hub, a);
    const replies: unknown[] = [];
    b.addEventListener("message", (event) => replies.push(event.data));
    a.emit("message", { data: new ArrayBuffer(8) });
    a.emit("message", { data: "x".repeat(20_000) });
    a.emit("message", { data: JSON.stringify({ t: "create", id: 1, size: 7 }) });
    await until(() => replies.length > 0);
    // Only the readable one got an answer, and it was told to say hello first.
    expect(replies).toHaveLength(1);
    expect(String(replies[0])).toContain("Say hello first");
  });
});

describe("the host's referee across a reload", () => {
  it("saves its races and picks them back up, seats and moves intact", async () => {
    const before = new NearbyHost();
    const hosted = await before.backend.create(OPTIONS, "Ana");
    const [a, b] = channelPair();
    attachChannel(before.hub, a);
    const guest = guestBackend();
    guest.use(b);
    const joined = await guest.backend.join(hosted.code, "Ben");
    await until(() => hosted.game().status === "playing");
    const first = hosted.you === "south" ? hosted : joined;
    await first.play({ type: "step", row: 5, col: 3 });
    await until(() => before.hub.game(hosted.code)?.moves.length === 1);

    // What the tab keeps in session storage, read back by a fresh referee after the reload.
    const saved = JSON.parse(JSON.stringify(before.hub.snapshot()));
    const after = new Hub();
    after.restore(saved);
    expect(after.game(hosted.code)?.moves).toHaveLength(1);

    // The old link is gone; the guest comes back over a new one with their seat token and finds
    // the race as it was.
    const guestSeen = presenceOf(joined);
    a.close();
    await until(() => guestSeen.at(-1)?.here === false);
    const [a2, b2] = channelPair();
    attachChannel(after, a2);
    guest.use(b2);
    const back = await guest.backend.resume(hosted.code);
    expect(back).toBe(joined);
    expect(back?.game().moves).toHaveLength(1);

    // Junk in storage is ignored rather than trusted.
    const junk = new Hub();
    junk.restore([{ game: { v: 1, code: "ZZZZZ" } }, null, "x"]);
    expect(junk.size).toBe(0);
  });
});
