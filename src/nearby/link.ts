import { Hub, type Conn } from "../online/hub";
import type { OnlineSession } from "../online/backend";
import type { ServerMessage } from "../online/protocol";
import { dispatch } from "../online/referee";
import { ServerBackend, type SocketLike } from "../online/server-backend";
import { readSnapshot, registerHost, writeSnapshot } from "./registry";
import { decodeSignal, encodeAnswer, encodeOffer, pairingLink, type Signal } from "./signal";

/**
 * Nearby races: two devices on the same Wi-Fi play over a direct WebRTC data channel, with no
 * game server at all. The host's tab runs the same referee the server runs (Hub + dispatch), and
 * both players talk to it through the ordinary ServerBackend client, so every rule, clock and
 * rematch behaves exactly as it does online.
 *
 * Pairing is two QR codes (or links): the host's offer, then the guest's reply. Only local
 * network addresses are offered (no STUN or TURN servers), so nothing leaves the network.
 */

export type OfferSignal = Extract<Signal, { type: "offer" }>;

const RTC: RTCConfiguration = { iceServers: [] };
const LABEL = "detour";
const GATHER_MS = 2500;
/** Once a local address turns up, wait this long for others, then go with what there is. */
const SETTLE_MS = 300;
const CONNECT_MS = 20_000;
const HANDOFF = "detour-nearby";
const MAX_MESSAGE = 16 * 1024;
/**
 * The host's first message on a new link. A browser can finish the link a moment before the
 * host's own setup has, and messages that arrive in that moment can be lost, so the guest says
 * nothing until the host says this.
 */
const READY = '{"t":"ready"}';

export const NEARBY_DESCRIPTION =
  "Nearby races run straight between your two devices over your Wi-Fi. No server, and nothing leaves your network.";

/** Can this browser make a direct link? (Not inside a Claude artifact viewer, which sandboxes it.) */
export function nearbySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.RTCPeerConnection === "function" &&
    !(window as unknown as { claude?: unknown }).claude
  );
}

// ---------------------------------------------------------------- sockets

/** The parts of an RTCDataChannel the link uses (so tests can supply a fake). */
export interface ChannelLike {
  readonly readyState: RTCDataChannelState;
  send(text: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

const STATE: Record<RTCDataChannelState, number> = { connecting: 0, open: 1, closing: 2, closed: 3 };

/** A data channel dressed as the socket ServerBackend expects. */
export class ChannelSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  private closed = false;

  constructor(private channel: ChannelLike | null) {
    const end = () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    };
    if (!channel || channel.readyState === "closing" || channel.readyState === "closed") {
      // A link that's already gone: fail the way a refused connection would.
      queueMicrotask(() => {
        this.onerror?.();
        end();
      });
      return;
    }
    channel.addEventListener("open", () => this.onopen?.());
    channel.addEventListener("message", (event) => this.onmessage?.(event));
    channel.addEventListener("error", () => this.onerror?.());
    channel.addEventListener("close", end);
    if (channel.readyState === "open") queueMicrotask(() => this.onopen?.());
  }

  get readyState() {
    return this.channel ? STATE[this.channel.readyState] : 3;
  }
  send(text: string) {
    this.channel?.send(text);
  }
  close() {
    this.channel?.close();
  }
}

/** The host's own seat: a socket that talks straight to the hub in this tab. */
class LocalSocket implements SocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  private conn: Conn;

  constructor(
    private hub: Hub,
    private changed: () => void = () => {},
  ) {
    this.conn = {
      clientId: "",
      name: "Player",
      seats: new Map(),
      // Through JSON and a microtask, exactly like a message over the wire.
      send: (message: ServerMessage) => {
        const text = JSON.stringify(message);
        queueMicrotask(() => this.readyState === 1 && this.onmessage?.({ data: text }));
      },
    };
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(text: string) {
    queueMicrotask(() => {
      if (this.readyState !== 1) return;
      dispatch(this.hub, this.conn, text);
      this.changed();
    });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.hub.disconnect(this.conn);
    queueMicrotask(() => this.onclose?.());
  }
}

/**
 * Seats a remote player's channel at the hub, with the same flood guard as the server (30
 * messages at once, then 10 a second). Attach it as soon as the channel exists: the other side
 * can start talking the moment the link opens, before this side has finished its own setup.
 */
export function attachChannel(hub: Hub, channel: ChannelLike, changed: () => void = () => {}): void {
  const conn: Conn = {
    clientId: "",
    name: "Player",
    seats: new Map(),
    send: (message) => {
      if (channel.readyState === "open") channel.send(JSON.stringify(message));
    },
  };
  let budget = 30;
  let last = Date.now();
  channel.addEventListener("message", (event) => {
    if (typeof event.data !== "string" || event.data.length > MAX_MESSAGE) return;
    const now = Date.now();
    budget = Math.min(30, budget + (now - last) / 100);
    last = now;
    if (--budget < 0) return conn.send({ t: "error", id: null, message: "Slow down a little." });
    dispatch(hub, conn, event.data);
    changed();
  });
  let gone = false;
  channel.addEventListener("close", () => {
    if (gone) return;
    gone = true;
    hub.disconnect(conn);
  });
}

// ---------------------------------------------------------------- WebRTC plumbing

/** Waits for local candidates (quick: with no STUN servers there are only local ones). */
function gathered(pc: RTCPeerConnection): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const sdp = pc.localDescription?.sdp ?? "";
      if (!/a=candidate:\S+ 1 udp \d+ \S+ \d+ typ host/i.test(sdp)) {
        reject(new Error("This device doesn't seem to be on a network. Connect to Wi-Fi and try again."));
      } else resolve(sdp);
    };
    if (pc.iceGatheringState === "complete") return finish();
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") finish();
    });
    // Browsers can take a while to give up on interfaces that go nowhere; the Wi-Fi address
    // comes first, so don't keep the player waiting for the rest.
    let settle: ReturnType<typeof setTimeout> | undefined;
    pc.addEventListener("icecandidate", (event) => {
      if (/ udp /i.test(event.candidate?.candidate ?? "")) {
        clearTimeout(settle);
        settle = setTimeout(finish, SETTLE_MS);
      }
    });
    setTimeout(finish, GATHER_MS);
  });
}

/**
 * Resolves once the channel is open; rejects if the devices can't reach each other (within
 * `timeoutMs`, when there is one: the guest waits as long as the host takes to scan).
 */
function opened(
  pc: RTCPeerConnection,
  channel: Promise<RTCDataChannel>,
  timeoutMs: number | null,
): Promise<RTCDataChannel> {
  return new Promise((resolve, reject) => {
    const fail = () =>
      reject(
        new Error(
          "The devices couldn't reach each other. Check that both are on the same Wi-Fi (guest networks often keep devices apart), then try again.",
        ),
      );
    const timer = timeoutMs === null ? undefined : setTimeout(fail, timeoutMs);
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") {
        clearTimeout(timer);
        fail();
      }
    });
    void channel.then((ch) => {
      const done = () => {
        clearTimeout(timer);
        resolve(ch);
      };
      if (ch.readyState === "open") done();
      else ch.addEventListener("open", done);
    });
  });
}

/** Closes the channel when the connection fails for good, so the hub sees the player leave. */
function watch(pc: RTCPeerConnection, channel: RTCDataChannel) {
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") channel.close();
  });
  channel.addEventListener("close", () => pc.close());
}

// ---------------------------------------------------------------- host

export interface Invite {
  /** The pairing code (also inside the link). */
  code: string;
  /** Opens the join screen on the other device: what the QR code holds. */
  link: string;
  /** Takes the guest's reply (code, link, or anything containing either). Resolves once linked. */
  accept(reply: string): Promise<void>;
  /** False once a reply was taken and the link failed: make a new invite. */
  usable(): boolean;
  cancel(): void;
}

/** The host's side: the referee for every nearby race started in this tab. */
export class NearbyHost {
  readonly hub = new Hub();
  readonly backend: ServerBackend;
  private pending = new Set<Invite>();
  private handoff: BroadcastChannel | null = null;
  private saved = "";

  private persist = () => {
    const snapshot = JSON.stringify(this.hub.snapshot());
    if (snapshot !== this.saved && writeSnapshot(snapshot)) this.saved = snapshot;
  };

  constructor() {
    this.backend = new ServerBackend("nearby:host", {
      kind: "nearby",
      reconnect: false,
      description: NEARBY_DESCRIPTION,
      openSocket: () => new LocalSocket(this.hub, this.persist),
    });
    registerHost(this.backend);
    // This tab is the referee: if it reloads, the races carry on from where they were. Saved
    // after every message it handles, and every second for what the clock does by itself.
    this.hub.restore(readSnapshot());
    setInterval(this.persist, 1000);
    if (typeof window !== "undefined") window.addEventListener("pagehide", this.persist);
    setInterval(() => this.hub.tickClocks(), 200);
    setInterval(() => this.hub.sweep(), 60_000);
    // A reply link opened in another tab of this browser is passed straight to this one.
    try {
      this.handoff = new BroadcastChannel(HANDOFF);
      this.handoff.onmessage = (event: MessageEvent<{ answer?: string }>) => {
        const answer = event.data?.answer;
        const latest = [...this.pending].pop();
        if (typeof answer !== "string" || !latest) return;
        this.handoff?.postMessage({ taken: true });
        void latest.accept(answer).catch(() => {});
      };
    } catch {
      this.handoff = null;
    }
  }

  /** A fresh pairing for one race (also how a dropped guest gets back in). */
  async invite(gameCode: string): Promise<Invite> {
    const pc = new RTCPeerConnection(RTC);
    const channel = pc.createDataChannel(LABEL, { ordered: true });
    attachChannel(this.hub, channel, this.persist);
    await pc.setLocalDescription(await pc.createOffer());
    let sdp: string;
    try {
      sdp = await gathered(pc);
    } catch (error) {
      pc.close();
      throw error;
    }
    const code = await encodeOffer(gameCode, sdp);
    let accepting: Promise<void> | null = null;
    const invite: Invite = {
      code,
      link: pairingLink(code, location.href),
      accept: (reply) => {
        if (accepting) return accepting;
        const attempt = (async () => {
          const signal = await decodeSignal(reply);
          if (!signal)
            throw new Error("That isn't a reply code. Scan the code on the other device's screen.");
          if (signal.type !== "answer")
            throw new Error(
              "That's an invite code, not a reply. Scan the code the other device shows after joining.",
            );
          await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
          const open = await opened(pc, Promise.resolve(channel), CONNECT_MS);
          this.pending.delete(invite);
          watch(pc, open);
          open.send(READY);
        })();
        accepting = attempt.catch((error: unknown) => {
          // A bad paste can be retried; a failed connection needs a fresh invite.
          if (pc.signalingState === "have-local-offer") accepting = null;
          throw error;
        });
        return accepting;
      },
      usable: () => pc.signalingState === "have-local-offer" || channel.readyState === "open",
      cancel: () => {
        this.pending.delete(invite);
        if (channel.readyState !== "open") pc.close();
      },
    };
    this.pending.add(invite);
    return invite;
  }
}

let host: NearbyHost | null = null;
export function nearbyHost(): NearbyHost {
  host ??= new NearbyHost();
  return host;
}

// ---------------------------------------------------------------- guest

export interface Reply {
  /** The reply code (the host scans or pastes this). */
  code: string;
  /** The same, as a link the host can open in their own browser. */
  link: string;
  /** Resolves with the seat once the host accepts the reply. */
  seated: Promise<OnlineSession>;
  cancel(): void;
}

/** The guest's side: one backend whose connection is whichever link is current. */
export class NearbyGuest {
  readonly backend: ServerBackend;
  private channel: RTCDataChannel | null = null;

  constructor() {
    this.backend = new ServerBackend("nearby:guest", {
      kind: "nearby",
      reconnect: false,
      description: NEARBY_DESCRIPTION,
      openSocket: () => new ChannelSocket(this.channel),
      // Per page, not per browser: two tabs on one computer can still play each other.
      clientId: Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
    });
  }

  /**
   * Answers the host's invite. The reply goes back to them; the seat follows once they take it.
   * `name` is read when the seat is taken, so it can still be typed while the host scans.
   */
  async answer(offer: OfferSignal, name: () => string): Promise<Reply> {
    const pc = new RTCPeerConnection(RTC);
    // The channel counts once the host says it's ready (listening from the moment it arrives).
    const incoming = new Promise<RTCDataChannel>((resolve) =>
      pc.addEventListener("datachannel", ({ channel }) => {
        const ready = (event: MessageEvent) => {
          if (event.data !== READY) return;
          channel.removeEventListener("message", ready);
          resolve(channel);
        };
        channel.addEventListener("message", ready);
      }),
    );
    // Both sides know each other's addresses, so either can open the link. This side reaches the
    // host straight away; the host's browser keeps its first handshake message until it has the
    // reply, then finishes in a moment, however long the scan took.
    await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    let sdp: string;
    try {
      sdp = await gathered(pc);
    } catch (error) {
      pc.close();
      throw error;
    }
    const code = await encodeAnswer(sdp);
    let cancelled = false;
    const seated = (async () => {
      const channel = await opened(pc, incoming, null);
      if (cancelled) throw new Error("Cancelled.");
      watch(pc, channel);
      this.channel = channel;
      // Back in a seat this device already had (a re-pair), or a new one.
      const again = await this.backend.resume(offer.gameCode);
      return again ?? (await this.backend.join(offer.gameCode, name()));
    })();
    seated.catch(() => pc.close());
    return {
      code,
      link: pairingLink(code, location.href),
      seated,
      cancel: () => {
        cancelled = true;
        if (!this.channel || this.channel.readyState !== "open") pc.close();
      },
    };
  }
}

let guest: NearbyGuest | null = null;
export function nearbyGuest(): NearbyGuest {
  guest ??= new NearbyGuest();
  return guest;
}

/**
 * A reply link opened in the host's own browser: hand it to the tab that's waiting for it.
 * Resolves true if a waiting tab took it.
 */
export function handOffAnswer(answer: string): Promise<boolean> {
  return new Promise((resolve) => {
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(HANDOFF);
    } catch {
      return resolve(false);
    }
    const finish = (taken: boolean) => {
      clearTimeout(timer);
      channel.close();
      resolve(taken);
    };
    const timer = setTimeout(() => finish(false), 1500);
    channel.onmessage = (event: MessageEvent<{ taken?: boolean }>) => {
      if (event.data?.taken) finish(true);
    };
    channel.postMessage({ answer });
  });
}
