/**
 * Pairing codes for nearby games. A WebRTC connection needs one exchange of "session
 * descriptions" (an offer from the host, an answer from the guest). They're long, so we keep
 * only the lines a data-channel connection needs, compress them, and encode the result as
 * URL-safe text: short enough for a QR code a phone scans in a moment.
 *
 *   offer code:  "1o" + gameCode + "." + payload   (the guest also learns which race to join)
 *   answer code: "1a." + payload
 *   payload:     "b" + base64url(packed fields), rebuilt into a description on arrival; or,
 *                for anything unusual, "z" + base64url(deflate(sdp)) / "u" + base64url(sdp)
 */

const VERSION = "1";
const KEEP = [
  "v=",
  "o=",
  "s=",
  "t=",
  "a=group:",
  "m=",
  "c=",
  "a=ice-ufrag:",
  "a=ice-pwd:",
  "a=fingerprint:",
  "a=setup:",
  "a=mid:",
  "a=sctp-port:",
  "a=max-message-size:",
  "a=candidate:",
];

/** Just the lines a data channel needs; host candidates only, without optional extensions. */
export function minifySdp(sdp: string): string {
  const lines = sdp.split(/\r?\n/).filter((line) => KEEP.some((prefix) => line.startsWith(prefix)));
  const kept = lines
    .filter((line) => !line.startsWith("a=candidate:") || (/ udp /i.test(line) && / typ host/.test(line)))
    .map((line) => (line.startsWith("a=candidate:") ? line.replace(/( typ host).*$/, "$1") : line));
  return kept.join("\r\n") + "\r\n";
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

async function pipeThrough(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const source = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(source).arrayBuffer());
}

const canCompress = () =>
  typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

export async function packSdp(sdp: string): Promise<string> {
  const packed = packFields(sdp);
  if (packed) return "b" + toBase64Url(packed);
  const bytes = new TextEncoder().encode(minifySdp(sdp));
  if (!canCompress()) return "u" + toBase64Url(bytes);
  return "z" + toBase64Url(await pipeThrough(bytes, new CompressionStream("deflate-raw")));
}

export async function unpackSdp(payload: string): Promise<string> {
  const kind = payload[0];
  const bytes = fromBase64Url(payload.slice(1));
  if (kind === "b") return unpackFields(bytes);
  if (kind === "u") return new TextDecoder().decode(bytes);
  if (kind === "z")
    return new TextDecoder().decode(await pipeThrough(bytes, new DecompressionStream("deflate-raw")));
  throw new Error("That pairing code isn't one Detour can read.");
}

// ---------------------------------------------------------------- binary packing
//
// A data-channel description is mostly boilerplate. What actually differs between devices is
// the ICE username and password, the DTLS certificate fingerprint, the setup role, the media id,
// and a few local candidates. Packing just those as bytes takes ~90 bytes instead of ~500.

const SETUPS = ["actpass", "active", "passive"] as const;
const MAX_CANDIDATES = 4;

interface Candidate {
  foundation: string;
  priority: number;
  address: string;
  port: number;
}

interface Fields {
  ufrag: string;
  pwd: string;
  fingerprint: Uint8Array;
  setup: (typeof SETUPS)[number];
  mid: string;
  candidates: Candidate[];
}

function readFields(sdp: string): Fields | null {
  const line = (prefix: string) =>
    sdp
      .split(/\r?\n/)
      .find((l) => l.startsWith(prefix))
      ?.slice(prefix.length)
      .trim();
  const ufrag = line("a=ice-ufrag:");
  const pwd = line("a=ice-pwd:");
  const fp = line("a=fingerprint:");
  const setup = line("a=setup:") as Fields["setup"] | undefined;
  const mid = line("a=mid:");
  if (!ufrag || !pwd || !fp || !setup || mid === undefined || !SETUPS.includes(setup)) return null;
  const [algorithm, hex] = fp.split(/\s+/);
  if (algorithm?.toLowerCase() !== "sha-256" || !hex) return null;
  const bytes = hex.split(":").map((h) => parseInt(h, 16));
  if (bytes.length !== 32 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
  const candidates: Candidate[] = [];
  for (const raw of sdp.split(/\r?\n/)) {
    const m = /^a=candidate:(\S+) 1 udp (\d+) (\S+) (\d+) typ host/i.exec(raw);
    if (m && candidates.length < MAX_CANDIDATES) {
      candidates.push({ foundation: m[1]!, priority: Number(m[2]), address: m[3]!, port: Number(m[4]) });
    }
  }
  return { ufrag, pwd, fingerprint: Uint8Array.from(bytes), setup, mid, candidates };
}

class Writer {
  bytes: number[] = [];
  u8(n: number) {
    this.bytes.push(n & 255);
  }
  u16(n: number) {
    this.u8(n >> 8);
    this.u8(n);
  }
  u32(n: number) {
    this.u16(Math.floor(n / 65536));
    this.u16(n % 65536);
  }
  text(t: string) {
    const b = new TextEncoder().encode(t);
    if (b.length > 255) throw new Error("too long");
    this.u8(b.length);
    this.bytes.push(...b);
  }
  raw(b: Uint8Array) {
    this.bytes.push(...b);
  }
}

class Reader {
  private i = 0;
  constructor(private b: Uint8Array) {}
  u8() {
    if (this.i >= this.b.length) throw new Error("short");
    return this.b[this.i++]!;
  }
  u16() {
    return (this.u8() << 8) | this.u8();
  }
  u32() {
    return this.u16() * 65536 + this.u16();
  }
  take(n: number) {
    if (this.i + n > this.b.length) throw new Error("short");
    const out = this.b.slice(this.i, this.i + n);
    this.i += n;
    return out;
  }
  text() {
    return new TextDecoder().decode(this.take(this.u8()));
  }
}

const hex2 = (b: number) => b.toString(16).padStart(2, "0");

function writeAddress(w: Writer, address: string) {
  const uuid = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i.exec(
    address,
  );
  if (uuid) {
    w.u8(1);
    const h = uuid.slice(1).join("");
    for (let i = 0; i < 32; i += 2) w.u8(parseInt(h.slice(i, i + 2), 16));
    return;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (v4 && v4.slice(1).every((x) => Number(x) <= 255)) {
    w.u8(2);
    for (const x of v4.slice(1)) w.u8(Number(x));
    return;
  }
  w.u8(3);
  w.text(address);
}

function readAddress(r: Reader): string {
  const kind = r.u8();
  if (kind === 1) {
    const h = Array.from(r.take(16), hex2).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
  }
  if (kind === 2) return Array.from(r.take(4)).join(".");
  if (kind === 3) return r.text();
  throw new Error("bad address");
}

export function packFields(sdp: string): Uint8Array | null {
  const f = readFields(sdp);
  if (!f) return null;
  try {
    const w = new Writer();
    w.text(f.ufrag);
    w.text(f.pwd);
    w.raw(f.fingerprint);
    w.u8(SETUPS.indexOf(f.setup));
    w.text(f.mid);
    w.u8(f.candidates.length);
    for (const c of f.candidates) {
      const numeric = /^\d{1,10}$/.test(c.foundation) && Number(c.foundation) < 2 ** 32;
      if (numeric) {
        w.u8(0);
        w.u32(Number(c.foundation));
      } else {
        w.u8(1);
        w.text(c.foundation);
      }
      w.u32(c.priority);
      writeAddress(w, c.address);
      w.u16(c.port);
    }
    return Uint8Array.from(w.bytes);
  } catch {
    return null;
  }
}

/** Rebuilds a complete data-channel description around the packed fields. */
export function unpackFields(bytes: Uint8Array): string {
  const r = new Reader(bytes);
  const ufrag = r.text();
  const pwd = r.text();
  const fingerprint = Array.from(r.take(32), (b) => hex2(b).toUpperCase()).join(":");
  const setup = SETUPS[r.u8()];
  if (!setup) throw new Error("bad setup");
  const mid = r.text();
  const count = r.u8();
  const candidates: string[] = [];
  for (let i = 0; i < count && i < MAX_CANDIDATES; i++) {
    const foundation = r.u8() === 0 ? String(r.u32()) : r.text();
    const priority = r.u32();
    const address = readAddress(r);
    const port = r.u16();
    candidates.push(`a=candidate:${foundation} 1 udp ${priority} ${address} ${port} typ host`);
  }
  return (
    [
      "v=0",
      "o=- 1 2 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      `a=group:BUNDLE ${mid}`,
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "c=IN IP4 0.0.0.0",
      ...candidates,
      `a=ice-ufrag:${ufrag}`,
      `a=ice-pwd:${pwd}`,
      `a=fingerprint:sha-256 ${fingerprint}`,
      `a=setup:${setup}`,
      `a=mid:${mid}`,
      "a=sctp-port:5000",
      "a=max-message-size:262144",
    ].join("\r\n") + "\r\n"
  );
}

export async function encodeOffer(gameCode: string, sdp: string): Promise<string> {
  return `${VERSION}o${gameCode}.${await packSdp(sdp)}`;
}

export async function encodeAnswer(sdp: string): Promise<string> {
  return `${VERSION}a.${await packSdp(sdp)}`;
}

export type Signal = { type: "offer"; gameCode: string; sdp: string } | { type: "answer"; sdp: string };

const CODE = /^1(o([A-Z0-9]{5})|a)\.([buz][A-Za-z0-9_-]+)$/;

/**
 * Reads a pairing code from whatever the player has: the code itself, a "#nearby-…" fragment,
 * or a whole invite link pasted from a message.
 */
export async function decodeSignal(text: string): Promise<Signal | null> {
  const trimmed = text.trim();
  const fromLink = /#nearby-([^\s#]+)/.exec(trimmed)?.[1];
  const code = (fromLink ?? trimmed).replace(/\s+/g, "");
  const m = CODE.exec(code);
  if (!m) return null;
  try {
    const sdp = await unpackSdp(m[3]!);
    if (!sdp.startsWith("v=0")) return null;
    return m[2] ? { type: "offer", gameCode: m[2], sdp } : { type: "answer", sdp };
  } catch {
    return null;
  }
}

/** A page link that carries a pairing code (an invite or a reply) in its fragment. */
export function pairingLink(code: string, pageHref: string): string {
  const url = new URL(pageHref);
  url.hash = `nearby-${code}`;
  return url.toString();
}
