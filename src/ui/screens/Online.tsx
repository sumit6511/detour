import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { opponentOf, type Side } from "../../engine/game";
import type { OnlineSession, Presence } from "../../online/backend";
import { toMatch, winnerOfGame, type OnlineGame } from "../../online/game";
import { ABANDON_AFTER_MS, type Reaction } from "../../online/protocol";
import { sfx } from "../../audio/sfx";
import { Board } from "../board/Board";
import { viewOfMatch } from "../board/view";
import { useToast } from "../components/Toasts";
import { IconBack, IconCheck } from "../icons";
import type { Settings } from "../settings";
import { Game, type OnlineControls } from "./Game";

interface OnlineScreenProps {
  session: OnlineSession;
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  onHelp: () => void;
  onOpenSettings: () => void;
  onExit: () => void;
  onSwitch: (next: OnlineSession) => void;
  onFinished: (code: string, won: boolean, size: 7 | 9) => void;
}

/** Keeps one online session on screen: the waiting room while it's open, then the race itself. */
export function OnlineScreen(props: OnlineScreenProps) {
  const { session, onSwitch, onFinished } = props;
  const notify = useToast();
  const [game, setGame] = useState<OnlineGame>(() => session.game());
  const [presence, setPresence] = useState<Presence>({ here: null, since: null });
  const [names, setNames] = useState<Record<Side, string>>({ south: "Player", north: "Player" });
  const [reactions, setReactions] = useState<Array<{ id: number; side: Side; text: string }>>([]);
  const [now, setNow] = useState(() => Date.now());
  const reported = useRef<string | null>(null);

  useEffect(() => {
    setGame(session.game());
    const stops = [
      session.onGame((g) => setGame(g)),
      session.onPresence((p) => setPresence(p)),
      session.onReaction((r) => {
        const id = Date.now() + Math.random();
        setReactions((all) => [...all.slice(-6), { id, side: r.side, text: r.text }]);
        setTimeout(() => setReactions((all) => all.filter((x) => x.id !== id)), 3200);
        if (r.side !== session.you) sfx.click();
      }),
      session.onSwitch((next) => onSwitch(next)),
    ];
    return () => stops.forEach((stop) => stop());
  }, [session, onSwitch]);

  // Names change only when someone sits down.
  const seatKey = `${game.players.south?.id ?? ""}|${game.players.north?.id ?? ""}`;
  useEffect(() => {
    let live = true;
    void session.names().then((n) => live && setNames(n));
    return () => {
      live = false;
    };
  }, [session, seatKey]);

  // A clock tick only while the opponent is away, for the "claim the win" countdown.
  useEffect(() => {
    if (presence.here !== false) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [presence.here]);

  useEffect(() => {
    if (game.status !== "finished" || reported.current === game.code) return;
    reported.current = game.code;
    onFinished(game.code, winnerOfGame(game) === session.you, game.setup.size);
  }, [game, session.you, onFinished]);

  const run = (task: Promise<unknown>) =>
    task.catch((error: unknown) => {
      sfx.invalid();
      notify(error instanceof Error ? error.message : "That didn't go through. Try again.", "warn");
    });

  const match = useMemo(() => toMatch(game), [game]);
  const you = session.you;
  const other = opponentOf(you);
  const shownNames = useMemo(
    () => ({ [you]: "You", [other]: names[other] }) as Record<Side, string>,
    [you, other, names],
  );

  if (game.status === "open") {
    return <Lobby session={session} game={game} onLeave={props.onExit} />;
  }

  const online: OnlineControls = {
    code: game.code,
    you,
    names: shownNames,
    opponent: presence,
    canClaim:
      game.status === "playing" &&
      presence.here === false &&
      presence.since !== null &&
      now - presence.since >= ABANDON_AFTER_MS,
    abandoned: game.abandoned,
    rematch: { you: game.rematch[you], them: game.rematch[other] },
    reactions,
    play: (action) => void run(session.play(action)),
    resign: () => void run(session.resign()),
    claim: () => void run(session.claim()),
    requestRematch: () => void run(session.rematch()),
    react: (text: Reaction) => void run(session.react(text)),
    clock: () => session.clock(),
  };

  return (
    <Game
      match={match}
      settings={props.settings}
      onSettings={props.onSettings}
      onChange={() => {}}
      onRematch={online.requestRematch}
      onMenu={props.onExit}
      onHelp={props.onHelp}
      onOpenSettings={props.onOpenSettings}
      online={online}
    />
  );
}

function Lobby({
  session,
  game,
  onLeave,
}: {
  session: OnlineSession;
  game: OnlineGame;
  onLeave: () => void;
}) {
  const notify = useToast();
  const [copied, setCopied] = useState(false);
  const link = session.backend.inviteLink(game.code);
  const view = useMemo(() => viewOfMatch(toMatch(game), false), [game]);
  const yourSide = session.you;

  const copy = async () => {
    const text = link ?? game.code;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      notify(`Couldn't copy. The code is ${game.code}.`);
    }
  };

  return (
    <main className="lobby">
      <header className="bar">
        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => {
            void session.cancel();
            onLeave();
          }}
        >
          <IconBack /> Cancel
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
        <div className="lobby__status">
          <span className="radar" aria-hidden="true" />
          <h1>{game.isPublic ? "Finding you an opponent…" : "Waiting for your friend"}</h1>
          <p className="lede">
            {game.isPublic
              ? "Anyone who picks Quick match with the same board will be paired with you. You can also share the code."
              : "Send them this code. The race starts the moment they join."}
          </p>
        </div>

        <div className="code" aria-label={`Race code ${game.code.split("").join(" ")}`}>
          {game.code.split("").map((ch, i) => (
            <motion.span
              key={i}
              initial={{ opacity: 0, y: 10, rotateX: 70 }}
              animate={{ opacity: 1, y: 0, rotateX: 0 }}
              transition={{ delay: 0.08 * i, type: "spring", stiffness: 420, damping: 22 }}
            >
              {ch}
            </motion.span>
          ))}
        </div>
        <div className="lobby__actions">
          <button type="button" className="btn btn--go" onClick={() => void copy()}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={copied ? "done" : "copy"}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="lobby__copy"
              >
                {copied ? <IconCheck /> : null}
                {copied ? "Copied" : link ? "Copy invite link" : "Copy code"}
              </motion.span>
            </AnimatePresence>
          </button>
        </div>
        {!link ? (
          <p className="hint">They open this same Detour page, choose Online, and enter the code.</p>
        ) : (
          <p className="hint lobby__link">{link}</p>
        )}

        <div className="lobby__board">
          <Board
            view={view}
            showRoutes={false}
            flipped={yourSide === "north"}
            label="The board for this race"
          />
          <p className="hint">
            You'll play {yourSide === "south" ? "orange and move first" : "teal and move second"}.{" "}
            {game.setup.size}×{game.setup.size}, {game.setup.wallsEach} barricades each
            {game.setup.roadworks ? ", with roadworks" : ""}
            {game.setup.clock !== "off" ? `, ${game.setup.clock} clock` : ""}.
          </p>
        </div>
      </motion.section>
    </main>
  );
}
