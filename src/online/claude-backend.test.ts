/* eslint-disable @typescript-eslint/no-this-alias -- the fakes close over their own store */
import { describe, expect, it } from "vitest";
import {
  ClaudeBackend,
  type ClaudeRuntime,
  type Db,
  type DocRef,
  type DocSnap,
  type NamedRoom,
  type QueryRef,
  type Room,
  type RoomPeer,
} from "./claude-backend";
import type { OnlineGame } from "./game";
import type { OnlineSession } from "./backend";

/* ---------- In-memory stand-ins for the Claude runtime's db, room and user capabilities ---------- */

type Json = Record<string, unknown>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const tick = () => new Promise((r) => setTimeout(r, 0));

function merge(target: Json, patch: Json): Json {
  const out: Json = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)
        ? merge(cur as Json, v as Json)
        : v;
  }
  return out;
}

class FakeStore {
  docs = new Map<string, Json>();
  listeners = new Map<string, Set<(s: DocSnap) => void>>();
  leases = new Map<string, { holder: string; until: number }>();
  constructor(private clock: () => number) {}
  snap(path: string): DocSnap {
    const body = this.docs.get(path);
    return { exists: !!body, data: () => (body ? clone(body) : undefined) };
  }
  notify(path: string) {
    for (const l of this.listeners.get(path) ?? []) setTimeout(() => l(this.snap(path)), 0);
  }
  db(): Db {
    const store = this;
    const doc = (path: string): DocRef => ({
      get: async () => store.snap(path),
      set: async (data) => (store.docs.set(path, clone(data)), store.notify(path)),
      update: async (data) => {
        const cur = store.docs.get(path);
        if (!cur) throw { code: "invalid_argument", message: "missing" };
        store.docs.set(path, merge(cur, clone(data)));
        store.notify(path);
      },
      delete: async () => (store.docs.delete(path), store.notify(path)),
      acquire: async ({ holder, ttlMs = 30000 }) => {
        const lease = store.leases.get(path);
        if (lease && lease.until > store.clock() && lease.holder !== holder) return { acquired: false };
        store.leases.set(path, { holder, until: store.clock() + ttlMs });
        return { acquired: true };
      },
      onSnapshot: (next) => {
        const set = store.listeners.get(path) ?? new Set();
        store.listeners.set(path, set);
        set.add(next);
        setTimeout(() => next(store.snap(path)), 0);
        return () => set.delete(next);
      },
    });
    const query = (prefix: string, filters: Array<[string, unknown]>, n: number): QueryRef => ({
      where: (field, _op, value) => query(prefix, [...filters, [field, value]], n),
      limit: (m) => query(prefix, filters, m),
      get: async () => ({
        docs: [...store.docs.entries()]
          .filter(([p, body]) => p.startsWith(prefix + "/") && filters.every(([f, v]) => body[f] === v))
          .slice(0, n)
          .map(([p]) => store.snap(p)),
      }),
    });
    return { doc, collection: (path) => query(path, [], 1000) };
  }
}

class FakeRooms {
  members = new Map<
    string,
    Map<
      string,
      {
        by: string;
        presence: Json;
        peersFns: Set<(c: { peers: RoomPeer[] }) => void>;
        topicFns: Map<string, Set<(m: never) => void>>;
      }
    >
  >();
  room(viewer: string): Room {
    const rooms = this;
    return {
      join: async (name) => {
        const members = rooms.members.get(name) ?? new Map();
        rooms.members.set(name, members);
        const me = {
          by: viewer,
          presence: {} as Json,
          peersFns: new Set<(c: { peers: RoomPeer[] }) => void>(),
          topicFns: new Map(),
        };
        members.set(viewer, me);
        const peersFor = (who: string): RoomPeer[] =>
          [...members.values()].map((m) => ({ by: m.by, isMe: m.by === who, presence: m.presence }));
        const announce = () => {
          for (const m of members.values())
            for (const fn of m.peersFns) setTimeout(() => fn({ peers: peersFor(m.by) }), 0);
        };
        announce();
        const named: NamedRoom = {
          emit: async (topic, data) => {
            for (const m of members.values())
              for (const fn of m.topicFns.get(topic) ?? [])
                setTimeout(
                  () =>
                    (fn as (x: unknown) => void)({
                      by: viewer,
                      isMe: m.by === viewer,
                      sameTab: m.by === viewer,
                      data,
                    }),
                  0,
                );
          },
          on: (topic, handler) => {
            const set = me.topicFns.get(topic) ?? new Set();
            me.topicFns.set(topic, set);
            set.add(handler as never);
            return () => set.delete(handler as never);
          },
          presence: async (patch) => {
            me.presence = { ...me.presence, ...patch };
            announce();
          },
          onPeers: (handler) => {
            me.peersFns.add(handler);
            setTimeout(() => handler({ peers: peersFor(viewer) }), 0);
            return () => me.peersFns.delete(handler);
          },
          leave: async () => {
            members.delete(viewer);
            announce();
          },
        };
        return named;
      },
    };
  }
}

function runtime(
  store: FakeStore,
  rooms: FakeRooms,
  viewer: string | null,
  canWrite: boolean | null = true,
): ClaudeRuntime {
  const user = {
    id: async () => viewer,
    can: async () => canWrite,
    profiles: async (ids: readonly string[]) =>
      Object.fromEntries(ids.map((id) => [id, { name: id.replace("u_", "") }])),
  };
  return {
    use: async (name: string) =>
      name === "db"
        ? store.db()
        : name === "user"
          ? user
          : name === "room"
            ? rooms.room(viewer ?? "anon")
            : null,
  };
}

async function waitFor<T>(read: () => T | undefined | null | false, ms = 1000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function track(session: OnlineSession) {
  const state = {
    game: session.game() as OnlineGame,
    switched: null as OnlineSession | null,
    reactions: [] as string[],
    away: null as boolean | null,
  };
  session.onGame((g) => (state.game = g));
  session.onSwitch((s) => (state.switched = s));
  session.onReaction((r) => state.reactions.push(`${r.side}:${r.text}`));
  session.onPresence((p) => (state.away = p.here === null ? null : !p.here));
  return state;
}

describe("Claude-hosted online play", () => {
  it("explains when a viewer can't play", async () => {
    const store = new FakeStore(Date.now);
    const rooms = new FakeRooms();
    const signedOut = await ClaudeBackend.connect(runtime(store, rooms, null));
    expect(await signedOut!.readiness()).toMatchObject({ ok: false });
    const viewOnly = await ClaudeBackend.connect(runtime(store, rooms, "u_viewer", false));
    expect((await viewOnly!.readiness()) as { reason: string }).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Contributor"),
    });
    expect(await ClaudeBackend.connect({ use: async () => null })).toBeNull();
  });

  it("plays a private race from code to rematch, with presence, reactions and a forfeit check", async () => {
    let now = 1_000_000;
    const clock = () => now;
    const store = new FakeStore(clock);
    const rooms = new FakeRooms();
    const alice = (await ClaudeBackend.connect(runtime(store, rooms, "u_alice"), clock))!;
    const bob = (await ClaudeBackend.connect(runtime(store, rooms, "u_bob"), clock))!;

    const a = await alice.create({ size: 7, roadworks: false, isPublic: false });
    const aState = track(a);
    expect(a.game().status).toBe("open");

    await expect(bob.join("ZZZZZ")).rejects.toThrow("No race with that code");
    const b = await bob.join(a.code);
    const bState = track(b);
    expect(b.you).not.toBe(a.you);
    await waitFor(() => aState.game.status === "playing");
    expect(await a.names()).toMatchObject({ [a.you]: "alice", [b.you]: "bob" });

    const first = a.you === "south" ? a : b;
    const second = first === a ? b : a;
    await expect(second.play({ type: "step", row: 1, col: 3 })).rejects.toThrow("not your turn");
    await first.play({ type: "step", row: 5, col: 3 });
    await waitFor(() => (second === a ? aState : bState).game.moves.length === 1);
    await second.play({ type: "wall", orientation: "h", row: 4, col: 2 });
    await waitFor(() => (first === a ? aState : bState).game.moves.length === 2);

    await waitFor(() => aState.away === false);
    await b.react("Nice move");
    await waitFor(() => aState.reactions.includes(`${b.you}:Nice move`));

    // Bob closes the tab: Alice sees him go, but can only claim the win after a full minute.
    b.leave();
    await waitFor(() => aState.away === true);
    await expect(a.claim()).rejects.toThrow("still connected");
    now += 61_000;
    await a.claim();
    await waitFor(() => aState.game.status === "finished");
    expect(aState.game.abandoned).toBe(true);
    expect(aState.game.resigned).toBe(b.you);

    // Bob comes back for a rematch; both agree, and both land in the new race with sides swapped.
    const b2 = (await bob.resume(a.code))!;
    const b2State = track(b2);
    await a.rematch();
    await b2.rematch();
    const aNext = await waitFor(() => aState.switched);
    const bNext = await waitFor(() => b2State.switched);
    expect(aNext.code).toBe(bNext.code);
    expect(aNext.you).toBe(b.you);
    expect(aNext.game().status).toBe("playing");
    for (const s of [a, b2, aNext, bNext]) s.leave();
    await tick();
  });

  it("pairs two people through quick match", async () => {
    const store = new FakeStore(Date.now);
    const rooms = new FakeRooms();
    const carol = (await ClaudeBackend.connect(runtime(store, rooms, "u_carol")))!;
    const dave = (await ClaudeBackend.connect(runtime(store, rooms, "u_dave")))!;
    const waiting = await carol.quick({ size: 9, roadworks: false });
    expect(waiting.game().status).toBe("open");
    const again = await carol.quick({ size: 9, roadworks: false }); // never joins your own lobby
    expect(again.code).not.toBe(waiting.code);
    await again.cancel();
    const matched = await dave.quick({ size: 9, roadworks: false });
    expect(matched.code).toBe(waiting.code);
    expect(matched.game().status).toBe("playing");
    waiting.leave();
    matched.leave();
  });
});
