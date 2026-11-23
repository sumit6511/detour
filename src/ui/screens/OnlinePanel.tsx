import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { MatchOptions } from "../../engine/match";
import type { OnlineBackend, OnlineSession, Readiness } from "../../online/backend";
import { cleanName, normaliseCode } from "../../online/game";
import { onlineBackend } from "../../online/select";
import { IconPlay } from "../icons";
import { load, save } from "../storage";

const NAME_KEY = "detour:name";

interface OnlinePanelProps {
  options: MatchOptions;
  onOnline: (session: OnlineSession) => void;
  initialCode?: string | null;
}

type Busy = null | "quick" | "invite" | "join";

/** The Online part of the setup form: quick match, invite a friend, or join with a code. */
export function OnlinePanel({ options, onOnline, initialCode }: OnlinePanelProps) {
  const [backend, setBackend] = useState<OnlineBackend | null>(null);
  const [ready, setReady] = useState<Readiness | null>(null);
  const [name, setName] = useState(() => load<string>(NAME_KEY, ""));
  const [code, setCode] = useState(initialCode ?? "");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialCode) setCode(initialCode);
  }, [initialCode]);

  useEffect(() => {
    let live = true;
    void onlineBackend().then(async (choice) => {
      if (!live) return;
      if (!choice.backend) return setReady({ ok: false, reason: choice.reason });
      setBackend(choice.backend);
      const readiness = await choice.backend.readiness();
      if (live) setReady(readiness);
    });
    return () => {
      live = false;
    };
  }, []);

  const go = async (
    kind: Exclude<Busy, null>,
    task: (b: OnlineBackend, who: string) => Promise<OnlineSession>,
  ) => {
    if (!backend || busy) return;
    const who = cleanName(name) || "Player";
    if (backend.needsName) save(NAME_KEY, who);
    setBusy(kind);
    setError(null);
    try {
      onOnline(await task(backend, who));
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const typedCode = normaliseCode(code);
  const board = { size: options.size, roadworks: options.roadworks };

  if (!ready) {
    return (
      <div className="online online--loading" aria-live="polite">
        <span className="spinner" aria-hidden="true" /> Connecting…
      </div>
    );
  }
  if (!ready.ok || !backend) {
    return (
      <div className="online online--off" role="status">
        <b>Online play isn't available here</b>
        <p>{ready.ok ? "No game server is set up for this copy." : ready.reason}</p>
      </div>
    );
  }

  return (
    <div className="online">
      {backend.needsName ? (
        <label className="field-input" htmlFor="online-name">
          <span className="eyebrow">Your name</span>
          <input
            id="online-name"
            type="text"
            maxLength={20}
            autoComplete="nickname"
            placeholder="What should opponents call you?"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      ) : null}

      <div className="online__buttons">
        <button
          type="button"
          className="btn btn--go btn--big"
          onClick={() => void go("quick", (b, who) => b.quick(board, who))}
          disabled={!!busy}
        >
          <IconPlay /> {busy === "quick" ? "Finding a race…" : "Quick match"}
        </button>
        <button
          type="button"
          className="btn btn--big"
          onClick={() => void go("invite", (b, who) => b.create({ ...board, isPublic: false }, who))}
          disabled={!!busy}
        >
          {busy === "invite" ? "Setting up…" : "Invite a friend"}
        </button>
      </div>

      <div className="online__join">
        <label htmlFor="online-code" className="eyebrow">
          Have a code?
        </label>
        <div className="online__join-row">
          <input
            id="online-code"
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={7}
            placeholder="ABCDE"
            className="code-input"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            onKeyDown={(event) => {
              if (event.key === "Enter" && typedCode) {
                event.preventDefault();
                void go("join", (b, who) => b.join(typedCode, who));
              }
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={!typedCode || !!busy}
            onClick={() => typedCode && void go("join", (b, who) => b.join(typedCode, who))}
          >
            {busy === "join" ? "Joining…" : "Join"}
          </button>
        </div>
      </div>

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
      <p className="hint">Quick match and new invites use the board settings above. {backend.description}</p>
    </div>
  );
}
