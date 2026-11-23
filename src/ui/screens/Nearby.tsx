import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { MatchOptions } from "../../engine/match";
import type { OnlineSession } from "../../online/backend";
import { cleanName } from "../../online/game";
import {
  NEARBY_DESCRIPTION,
  handOffAnswer,
  nearbyGuest,
  nearbyHost,
  nearbySupported,
  type Invite,
  type Reply,
} from "../../nearby/link";
import { decodeSignal } from "../../nearby/signal";
import { QrCode } from "../components/QrCode";
import { QrScanner } from "../components/QrScanner";
import { ShareButton } from "../components/ShareButton";
import { IconBack, IconCamera, IconCheck, IconWifi } from "../icons";
import { load, save } from "../storage";
import { NAME_KEY } from "./OnlinePanel";

const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work. Try again.");

function ErrorNote({ error }: { error: string | null }) {
  return (
    <AnimatePresence>
      {error ? (
        <motion.p
          className="online__error"
          role="alert"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
        >
          {error}
        </motion.p>
      ) : null}
    </AnimatePresence>
  );
}

function NameField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field-input" htmlFor={id}>
      <span className="eyebrow">Your name</span>
      <input
        id={id}
        type="text"
        maxLength={20}
        autoComplete="nickname"
        placeholder="What should the other player call you?"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

// ---------------------------------------------------------------- menu

interface NearbyPanelProps {
  options: MatchOptions;
  onOnline: (session: OnlineSession) => void;
  /** A pasted invite: open the join screen with it. */
  onJoin: (code: string) => void;
}

/** The Nearby part of the setup form: host on this device, or join one that's hosting. */
export function NearbyPanel({ options, onOnline, onJoin }: NearbyPanelProps) {
  const [name, setName] = useState(() => load<string>(NAME_KEY, ""));
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!nearbySupported()) {
    return (
      <div className="online online--off" role="status">
        <b>Nearby play isn't available here</b>
        <p>
          {(window as unknown as { claude?: unknown }).claude
            ? "Open Detour in its own browser tab to link two devices directly."
            : "This browser can't link two devices directly. Try a recent Chrome, Safari, Edge or Firefox."}
        </p>
      </div>
    );
  }

  const host = async () => {
    if (busy) return;
    const who = cleanName(name) || "Player";
    save(NAME_KEY, who);
    setBusy(true);
    setError(null);
    try {
      const board = { size: options.size, roadworks: options.roadworks, clock: options.clock ?? "off" };
      onOnline(await nearbyHost().backend.create({ ...board, isPublic: false }, who));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    const signal = await decodeSignal(pasted);
    if (!signal) return setError("That isn't a Detour invite. Copy the whole link from the host's screen.");
    if (signal.type !== "offer")
      return setError("That's a reply code. It goes on the host's device, in their invite screen.");
    save(NAME_KEY, cleanName(name) || "Player");
    onJoin(pasted.trim());
  };

  return (
    <div className="online">
      <NameField id="nearby-name" value={name} onChange={setName} />
      <div className="online__buttons">
        <button type="button" className="btn btn--go btn--big" onClick={() => void host()} disabled={busy}>
          <IconWifi /> {busy ? "Setting up…" : "Host on this device"}
        </button>
      </div>
      <div className="online__join">
        <span className="eyebrow">Joining someone?</span>
        <p className="hint">
          Point your phone's camera at the code on their screen. Or paste the invite link they sent:
        </p>
        <div className="online__join-row">
          <input
            id="nearby-invite"
            type="text"
            className="paste-input"
            aria-label="Invite link"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste invite link"
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && pasted.trim()) {
                event.preventDefault();
                void join();
              }
            }}
          />
          <button type="button" className="btn" disabled={!pasted.trim()} onClick={() => void join()}>
            Join
          </button>
        </div>
      </div>
      <ErrorNote error={error} />
      <p className="hint">The host's board settings above are used. {NEARBY_DESCRIPTION}</p>
    </div>
  );
}

// ---------------------------------------------------------------- host

/**
 * The host's pairing card: a QR code the other device opens, then the other device's reply,
 * read with this device's camera or pasted. Used in the lobby and to pair again mid-race.
 */
export function NearbyInvite({ gameCode }: { gameCode: string }) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [pasted, setPasted] = useState("");
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let made: Invite | null = null;
    setInvite(null);
    nearbyHost()
      .invite(gameCode)
      .then((next) => {
        made = next;
        if (live) setInvite(next);
        else next.cancel();
      })
      .catch((e: unknown) => live && setError(message(e)));
    return () => {
      live = false;
      made?.cancel();
    };
  }, [gameCode, attempt]);

  const accept = useCallback(
    async (text: string): Promise<boolean> => {
      if (!invite) return false;
      const signal = await decodeSignal(text);
      if (signal?.type !== "answer") {
        if (!scanning)
          setError("That isn't a reply code. Use the one the other device shows after scanning.");
        return false;
      }
      setScanning(false);
      setLinking(true);
      setError(null);
      try {
        await invite.accept(text);
      } catch (e) {
        setError(message(e));
        setLinking(false);
        // A link that failed can't be retried with the same invite: make a fresh one.
        if (!invite.usable()) setAttempt((n) => n + 1);
      }
      return true;
    },
    [invite, scanning],
  );

  return (
    <div className="pair">
      <div className="pair__step">
        <span className="pair__num">1</span>
        <div>
          <b>Scan this with the other device</b>
          <p className="hint">Its camera app opens the game, ready to join.</p>
        </div>
      </div>
      <div className="pair__qr-wrap">
        <AnimatePresence mode="wait" initial={false}>
          {invite ? (
            <motion.div
              key={invite.code}
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
            >
              <QrCode text={invite.link} label="Invite QR code" className="pair__qr" />
            </motion.div>
          ) : (
            <motion.div
              key="making"
              className="pair__qr pair__qr--loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <span className="spinner" aria-hidden="true" /> Making a code…
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {invite ? (
        <ShareButton
          url={invite.link}
          title="Join my Detour race"
          label="invite link"
          className="btn btn--quiet"
        />
      ) : null}

      <div className="pair__step">
        <span className="pair__num">2</span>
        <div>
          <b>Then scan their reply</b>
          <p className="hint">The other device shows a reply code. Read it here and you're racing.</p>
        </div>
      </div>

      {linking ? (
        <p className="pair__linking" role="status">
          <span className="spinner" aria-hidden="true" /> Linking the two devices…
        </p>
      ) : scanning ? (
        <QrScanner onCode={accept} onClose={() => setScanning(false)} />
      ) : (
        <div className="pair__reply">
          <button
            type="button"
            className="btn btn--go"
            disabled={!invite}
            onClick={() => {
              setError(null);
              setScanning(true);
            }}
          >
            <IconCamera /> Scan their reply
          </button>
          <div className="online__join-row">
            <input
              type="text"
              className="paste-input"
              aria-label="Reply code"
              autoComplete="off"
              spellCheck={false}
              placeholder="…or paste their reply"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && pasted.trim()) {
                  event.preventDefault();
                  void accept(pasted);
                }
              }}
            />
            <button
              type="button"
              className="btn"
              disabled={!invite || !pasted.trim()}
              onClick={() => void accept(pasted)}
            >
              Connect
            </button>
          </div>
        </div>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

// ---------------------------------------------------------------- guest

type JoinState =
  | { phase: "reading" }
  | { phase: "reply"; reply: Reply }
  | { phase: "handoff"; taken: boolean }
  | { phase: "broken"; text: string };

interface NearbyJoinProps {
  /** The code from the link that opened this page (an invite, or a reply sent to the host). */
  code: string;
  onSeated: (session: OnlineSession) => void;
  onCancel: () => void;
}

/** Opened from the host's QR code: shows this device's reply and waits for the host to read it. */
export function NearbyJoin({ code, onSeated, onCancel }: NearbyJoinProps) {
  const [state, setState] = useState<JoinState>({ phase: "reading" });
  const [name, setName] = useState(() => load<string>(NAME_KEY, ""));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const nameRef = useRef(name);
  nameRef.current = name;
  const seatedRef = useRef(onSeated);
  seatedRef.current = onSeated;

  useEffect(() => {
    let live = true;
    let made: Reply | null = null;
    void (async () => {
      const signal = await decodeSignal(code);
      if (!live) return;
      if (!signal) {
        return setState({
          phase: "broken",
          text: "This invite link is damaged or cut short. Ask the host for a fresh code and scan it again.",
        });
      }
      if (signal.type === "answer") {
        const taken = await handOffAnswer(code);
        if (live) setState({ phase: "handoff", taken });
        return;
      }
      if (!nearbySupported()) {
        return setState({
          phase: "broken",
          text: "This browser can't link two devices directly. Open the link in Chrome, Safari, Edge or Firefox.",
        });
      }
      try {
        const reply = await nearbyGuest().answer(signal, () => cleanName(nameRef.current) || "Player");
        made = reply;
        if (!live) return reply.cancel();
        setState({ phase: "reply", reply });
        const session = await reply.seated;
        save(NAME_KEY, cleanName(nameRef.current) || "Player");
        if (live) seatedRef.current(session);
      } catch (e) {
        if (live) setError(message(e));
      }
    })();
    return () => {
      live = false;
      made?.cancel();
    };
  }, [code, attempt]);

  return (
    <main className="lobby">
      <header className="bar">
        <button type="button" className="btn btn--quiet" onClick={onCancel}>
          <IconBack /> {state.phase === "reply" ? "Cancel" : "Menu"}
        </button>
        <span />
        <span />
      </header>
      <motion.section
        className="card lobby__card"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
      >
        {state.phase === "reading" ? (
          <div className="lobby__status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <h1>Reading the invite…</h1>
          </div>
        ) : state.phase === "broken" ? (
          <div className="lobby__status" role="alert">
            <h1>Can't join with this link</h1>
            <p className="lede">{state.text}</p>
          </div>
        ) : state.phase === "handoff" ? (
          <div className="lobby__status" role="status">
            {state.taken ? <IconCheck className="pair__done" /> : null}
            <h1>{state.taken ? "Reply received" : "This is a reply code"}</h1>
            <p className="lede">
              {state.taken
                ? "Your game tab has it and is linking now. Switch back to it; you can close this one."
                : "It belongs on the host's device: open it there, or scan it from the host's invite screen."}
            </p>
          </div>
        ) : (
          <>
            <div className="lobby__status">
              <span className="radar" aria-hidden="true" />
              <h1>Show this to the host</h1>
              <p className="lede">
                They tap <b>Scan their reply</b> and point their camera here. The race starts as soon as they
                do.
              </p>
            </div>
            <QrCode text={state.reply.link} label="Reply QR code" className="pair__qr" />
            <ShareButton
              url={state.reply.link}
              title="My Detour reply"
              label="reply"
              className="btn btn--quiet"
            />
            <div className="pair__name">
              <NameField id="nearby-join-name" value={name} onChange={setName} />
            </div>
            <p className="hint">{NEARBY_DESCRIPTION}</p>
          </>
        )}
        <ErrorNote error={error} />
        {error && state.phase === "reply" ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Make a new reply
          </button>
        ) : null}
      </motion.section>
    </main>
  );
}
