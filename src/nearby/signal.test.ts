import { describe, expect, it } from "vitest";
import { decodeSignal, encodeAnswer, encodeOffer, minifySdp, pairingLink } from "./signal";

// A real Chrome data-channel offer, with the lines and extensions a browser adds that we drop.
const OFFER = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=candidate:3442447574 1 udp 2122260223 0d1e8a8b-5f4f-4b2f-9b8e-2f1d3a4b5c6d.local 54400 typ host generation 0 network-cost 999",
  "a=candidate:1234567890 1 tcp 1518280447 0d1e8a8b-5f4f-4b2f-9b8e-2f1d3a4b5c6d.local 9 typ host tcptype active generation 0",
  "a=candidate:842163049 1 udp 1686052607 203.0.113.7 54400 typ srflx raddr 0.0.0.0 rport 0 generation 0",
  "a=ice-ufrag:Zk1q",
  "a=ice-pwd:0eW1v2h7cbqGqv7lC3RQcF3x",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08",
  "a=setup:actpass",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
  "",
].join("\r\n");

describe("pairing codes", () => {
  it("keeps only what a data channel needs, and only local UDP candidates", () => {
    const mini = minifySdp(OFFER);
    expect(mini).toContain("a=ice-ufrag:Zk1q");
    expect(mini).toContain("a=fingerprint:sha-256");
    expect(mini).toContain("54400 typ host\r\n");
    expect(mini).not.toContain("tcptype");
    expect(mini).not.toContain("srflx");
    expect(mini).not.toContain("extmap");
    expect(mini).not.toContain("network-cost");
  });

  it("packs an offer into a short code and rebuilds everything a connection needs", async () => {
    const code = await encodeOffer("ABCDE", OFFER);
    expect(code).toMatch(/^1oABCDE\.b[A-Za-z0-9_-]+$/);
    expect(code.length).toBeLessThan(160);
    const decoded = await decodeSignal(code);
    expect(decoded).toMatchObject({ type: "offer", gameCode: "ABCDE" });
    const sdp = (decoded as { sdp: string }).sdp;
    for (const essential of [
      "a=ice-ufrag:Zk1q",
      "a=ice-pwd:0eW1v2h7cbqGqv7lC3RQcF3x",
      "a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08",
      "a=setup:actpass",
      "a=mid:0",
      "a=candidate:3442447574 1 udp 2122260223 0d1e8a8b-5f4f-4b2f-9b8e-2f1d3a4b5c6d.local 54400 typ host",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    ]) {
      expect(sdp).toContain(essential);
    }
    expect(sdp).not.toContain("srflx");
  });

  it("packs plain IP candidates and odd foundations too, and falls back for anything unusual", async () => {
    const firefoxLike = OFFER.replace(
      /a=candidate:3442447574 1 udp 2122260223 \S+ 54400 typ host[^\r]*/,
      "a=candidate:0 1 UDP 2122252543 192.168.1.23 61001 typ host",
    ).replace("a=mid:0", "a=mid:data");
    const decoded = (await decodeSignal(await encodeAnswer(firefoxLike))) as { sdp: string };
    expect(decoded.sdp).toContain("a=candidate:0 1 udp 2122252543 192.168.1.23 61001 typ host");
    expect(decoded.sdp).toContain("a=group:BUNDLE data");
    const noFingerprint = OFFER.replace(/a=fingerprint:[^\r]*\r\n/, "");
    const fallback = await encodeAnswer(noFingerprint);
    expect(fallback).toMatch(/^1a\.[zu]/);
    expect((await decodeSignal(fallback))?.type).toBe("answer");
  });

  it("reads codes from invite links and pasted messages, and rejects junk", async () => {
    const answer = await encodeAnswer(OFFER);
    expect((await decodeSignal(`  ${answer}\n`))?.type).toBe("answer");
    const link = pairingLink(await encodeOffer("FGHJK", OFFER), "https://example.com/detour/#old");
    expect(link).toMatch(/^https:\/\/example\.com\/detour\/#nearby-1oFGHJK\./);
    expect(await decodeSignal(`Join my race: ${link}`)).toMatchObject({ type: "offer", gameCode: "FGHJK" });
    expect(await decodeSignal("hello")).toBeNull();
    expect(await decodeSignal("1a.zAAAA")).toBeNull();
  });
});
