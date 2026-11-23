import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { think } from "../../ai/client";
import { sfx } from "../../audio/sfx";
import { judgeWall } from "../../engine/analysis";
import { wallKey, type Cell, type Orientation, type Wall } from "../../engine/board";
import { opponentOf, type DetourAction, type Side } from "../../engine/game";
import {
  HUMAN,
  isBotTurn,
  play,
  replay as rebuild,
  resign,
  routeLength,
  sideToMove,
  undo,
  wallsUsed,
  winnerOf,
  type Match,
} from "../../engine/match";
import { actionName } from "../../engine/notation";
import { formatClock } from "../../engine/clock";
import { clockRunning, clockTimes, flagged, pauseClock, resumeClock, timeOut } from "../../engine/match";
import { Board, type DetourSign, type WallNote } from "../board/Board";
import { viewOfMatch } from "../board/view";
import { Modal } from "../components/Modal";
import { Ticker } from "../components/Controls";
import { useToast } from "../components/Toasts";
import {
  IconBack,
  IconBarricade,
  IconCheck,
  IconClose,
  IconFirst,
  IconFlag,
  IconHelp,
  IconHint,
  IconLast,
  IconMute,
  IconNext,
  IconPause,
  IconPlay,
  IconPrev,
  IconReplay,
  IconRestart,
  IconRotate,
  IconSettings,
  IconSound,
  IconStep,
  IconUndo,
} from "../icons";
import { LEVEL_LABEL, plural, raceNames } from "../labels";
import type { Presence } from "../../online/backend";
import { REACTIONS, type Reaction } from "../../online/protocol";
import type { Settings } from "../settings";

interface GameProps {
  match: Match;
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  onChange: (match: Match) => void;
  onRematch: () => void;
  onMenu: () => void;
  onHelp: () => void;
  onOpenSettings: () => void;
  online?: OnlineControls;
}

/** What an online race adds: whose seat this is, the other player's state, and the network actions. */
export interface OnlineControls {
  code: string;
  you: Side;
  names: Record<Side, string>;
  opponent: Presence;
  /** True once the opponent has been away long enough to claim the win. */
  canClaim: boolean;
  abandoned: boolean;
  rematch: { you: boolean; them: boolean };
  reactions: Array<{ id: number; side: Side; text: string }>;
  /** Both sides' remaining time right now, or null for an untimed race. */
  clock: () => Record<Side, number> | null;
  play: (action: DetourAction) => void;
  resign: () => void;
  claim: () => void;
  requestRematch: () => void;
  react: (text: Reaction) => void;
}

interface Rewind {
  index: number;
  playing: boolean;
}

const REPLAY_STEP_MS = 760;

export function Game({
  match,
  settings,
  onSettings,
  onChange,
  onRematch,
  onMenu,
  onHelp,
  onOpenSettings,
  online,
}: GameProps) {
  const notify = useToast();
  const { setup } = match;
  const vsBot = setup.mode === "bot";
  const names = online ? online.names : raceNames(setup);
  const total = match.moves.length;
  // Online, whoever sits North sees the board turned round so their own pawn starts at the bottom.
  const onlineYou = online?.you ?? null;
  const flipped = onlineYou === "north";

  const [rewind, setRewind] = useState<Rewind | null>(null);
  const [mode, setMode] = useState<"step" | "wall">("step");
  const [orientation, setOrientation] = useState<Orientation>("h");
  const [armed, setArmed] = useState<Wall | null>(null);
  const [sign, setSign] = useState<DetourSign | null>(null);
  const [hint, setHint] = useState<{ action: DetourAction; at: number } | null>(null);
  const [hinting, setHinting] = useState(false);
  const [celebrate, setCelebrate] = useState(0);
  const [shake, setShake] = useState(0);
  const [confirmResign, setConfirmResign] = useState(false);

  // ---------- Clocks ----------
  const latest = useRef(match);
  latest.current = match;
  const timed = online ? online.clock() !== null : !!match.clockRun;
  const readClock = (side: Side) => () => {
    const times = online ? online.clock() : clockTimes(latest.current, Date.now());
    return times ? times[side] : null;
  };

  // A local race's clock runs only while it's on screen and the tab is visible.
  useEffect(() => {
    if (online || !latest.current.clockRun) return;
    const resume = () => {
      const m = latest.current;
      if (!document.hidden && m.clockRun?.turnStartedAt === null && !winnerOf(m))
        onChange(resumeClock(m, Date.now()));
    };
    const pause = () => {
      const m = latest.current;
      if (m.clockRun && m.clockRun.turnStartedAt !== null) onChange(pauseClock(m, Date.now()));
    };
    const onVisibility = () => (document.hidden ? pause() : resume());
    resume();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, timed]);

  // Flag fall for local races: wake up exactly when the mover's time would run out.
  useEffect(() => {
    if (online || !match.clockRun || match.clockRun.turnStartedAt === null || winnerOf(match)) return;
    const left = clockTimes(match, Date.now())![sideToMove(match)];
    const timer = setTimeout(
      () => {
        const m = latest.current;
        const side = flagged(m, Date.now());
        if (side) onChange(timeOut(m, side, Date.now()));
      },
      Math.max(0, left) + 25,
    );
    return () => clearTimeout(timer);
  }, [match, online, onChange]);

  // A race lost or won on time gets its sound too (moves get theirs below).
  const lastTimeout = useRef(match.timedOut ?? null);
  useEffect(() => {
    const side = match.timedOut ?? null;
    if (side && side !== lastTimeout.current) {
      const you = online?.you ?? (vsBot ? HUMAN : null);
      if (you === side) sfx.lose();
      else {
        sfx.win();
        if (!vsBot || you !== null) setCelebrate((n) => n + 1);
      }
    }
    lastTimeout.current = side;
  }, [match.timedOut, online?.you, vsBot]);

  // What the board shows: the live race, or a point in its replay.
  const shown = useMemo(
    () => (rewind ? { ...match, moves: match.moves.slice(0, rewind.index) } : match),
    [match, rewind],
  );
  const state = useMemo(() => rebuild(shown), [shown]);
  const liveWinner = winnerOf(match);
  const winner = winnerOf(shown, state);
  const mover = sideToMove(shown);
  const thinking = !rewind && isBotTurn(match);
  const waiting = !!online && !liveWinner && !rewind && mover !== online.you;
  const canAct =
    !rewind && !liveWinner && !thinking && (!vsBot || mover === HUMAN) && (!online || mover === online.you);
  const view = useMemo(() => viewOfMatch(shown, canAct), [shown, canAct]);
  const routes = useMemo(
    () => ({
      south: routeLength(state, "south"),
      north: routeLength(state, "north"),
    }),
    [state],
  );
  const wallsLeft = state.wallsLeft[mover];

  // ---------- The bot's turn ----------
  useEffect(() => {
    if (rewind || !isBotTurn(match)) return;
    let cancelled = false;
    const started = performance.now();
    // A human-feeling pause: long enough to read the board, never long enough to drag.
    const pause = 420 + Math.random() * 380;
    void think(match, setup.level).then((action) => {
      const wait = Math.max(0, pause - (performance.now() - started));
      setTimeout(() => {
        if (cancelled) return;
        const next = play(match, action);
        if (next) onChange(next);
      }, wait);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match, rewind]);

  // ---------- Feedback for each new move: sound, detour sign, shake, celebration ----------
  const previous = useRef({
    seed: setup.seed,
    count: shown.moves.length,
    routes,
  });
  useEffect(() => {
    const before = previous.current;
    previous.current = { seed: setup.seed, count: shown.moves.length, routes };
    if (before.seed !== setup.seed) return;
    if (shown.moves.length === before.count + 1) {
      const last = shown.moves[shown.moves.length - 1]!;
      if (last.action.type === "wall") {
        sfx.wall();
        const target = opponentOf(last.side);
        const amount = routes[target] - before.routes[target];
        if (amount > 0) {
          setSign({ id: shown.moves.length, side: target, amount });
          if (amount >= 2) sfx.sign();
          if (amount >= 3) setShake((n) => n + 1);
        }
      } else if (view.lastFrom) {
        const from = view.lastFrom;
        const jumped = Math.abs(from.row - last.action.row) + Math.abs(from.col - last.action.col) > 1;
        if (jumped) sfx.jump();
        else sfx.step();
      }
      if (winner && !rewind) {
        const humanWon = onlineYou ? winner === onlineYou : !vsBot || winner === HUMAN;
        setTimeout(() => (humanWon ? sfx.win() : sfx.lose()), 280);
        if (humanWon) setCelebrate((n) => n + 1);
      }
    } else if (shown.moves.length < before.count && !rewind) {
      sfx.undo();
    }
  }, [shown.moves.length, routes, setup.seed, winner, rewind, vsBot, view.lastFrom, shown.moves, onlineYou]);

  useEffect(() => {
    if (!sign) return;
    const timer = setTimeout(() => setSign(null), 2000);
    return () => clearTimeout(timer);
  }, [sign]);

  // Any new move clears the half-finished barricade and the old hint.
  useEffect(() => {
    setArmed(null);
    setHint(null);
  }, [total]);

  useEffect(() => {
    if (mode === "wall" && (wallsLeft === 0 || !canAct)) {
      setMode("step");
      setArmed(null);
    }
  }, [mode, wallsLeft, canAct]);

  // ---------- Replay playback ----------
  useEffect(() => {
    if (!rewind?.playing) return;
    if (rewind.index >= total) {
      setRewind({ ...rewind, playing: false });
      return;
    }
    const timer = setTimeout(() => setRewind({ index: rewind.index + 1, playing: true }), REPLAY_STEP_MS);
    return () => clearTimeout(timer);
  }, [rewind, total]);

  // ---------- Actions ----------
  const act = useCallback(
    (action: DetourAction) => {
      const next = play(match, action);
      if (!next) return false;
      setMode("step");
      if (online) online.play(action);
      else onChange(next);
      return true;
    },
    [match, onChange, online],
  );

  const reasonFor = useCallback(
    (wall: Wall): string => {
      const verdict = judgeWall(state, mover, wall);
      if (verdict.legal) return "";
      if (verdict.reason === "none-left")
        return vsBot ? "You're out of barricades." : `${names[mover]} is out of barricades.`;
      if (verdict.reason === "overlap") return "That spot overlaps another barricade.";
      const who = verdict.trapped === mover && vsBot ? "you" : names[verdict.trapped!];
      return `That would wall ${who} in completely. Everyone needs a way through.`;
    },
    [state, mover, names, vsBot],
  );

  const placeWall = (wall: Wall) => {
    if (act({ type: "wall", ...wall })) setArmed(null);
    else rejectWall(wall);
  };

  const rejectWall = (wall: Wall) => {
    sfx.invalid();
    notify(reasonFor(wall) || "That barricade can't go there.", "warn");
  };

  const describeWall = useCallback(
    (wall: Wall): WallNote | null => {
      const verdict = judgeWall(state, mover, wall);
      if (!verdict.legal) {
        const text =
          verdict.reason === "overlap"
            ? "Overlaps"
            : verdict.reason === "none-left"
              ? "None left"
              : "Traps a racer";
        return { legal: false, text };
      }
      const other = opponentOf(mover);
      const fmt = (n: number) => (n > 0 ? `+${n}` : "±0");
      return {
        legal: true,
        text: `${vsBot ? "Bot" : names[other]} ${fmt(verdict.delta[other])} · ${vsBot ? "You" : names[mover]} ${fmt(
          verdict.delta[mover],
        )}`,
      };
    },
    [state, mover, names, vsBot],
  );

  const doUndo = () => {
    if (!canUndo) return;
    onChange(undo(match));
  };

  const askHint = async () => {
    if (!canAct || hinting) return;
    setHinting(true);
    const action = await think(match, "hard", 7);
    setHinting(false);
    setHint({ action, at: total });
    sfx.hint();
    onChange({ ...match, hints: (match.hints ?? 0) + 1 });
  };

  const canUndo =
    !online &&
    !match.clockRun &&
    !rewind &&
    !liveWinner &&
    !thinking &&
    match.moves.some((m) => !vsBot || m.side === HUMAN);

  // ---------- Keyboard ----------
  // One window listener for the screen's lifetime, always calling the latest handler, so keys
  // pressed in quick succession never reach a handler from before the previous key's update.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useLayoutEffect(() => {
    keyHandler.current = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector(".modal")) return;
      const key = event.key.toLowerCase();
      // A focused control keeps its own keys: Enter/Space press it, arrows move a slider or radio.
      const el = event.target instanceof Element ? event.target : null;
      const control = el?.closest(
        "button, input, select, textarea, summary, a, [role='button'], [role='radio']",
      );
      if (control && (key === "enter" || key === " ")) return;
      if (el instanceof HTMLInputElement && key.startsWith("arrow")) return;

      if (rewind) {
        if (key === "arrowleft") setRewind({ index: Math.max(0, rewind.index - 1), playing: false });
        else if (key === "arrowright")
          setRewind({
            index: Math.min(total, rewind.index + 1),
            playing: false,
          });
        else if (key === " ") setRewind({ ...rewind, playing: !rewind.playing });
        else if (key === "escape") setRewind(null);
        else return;
        event.preventDefault();
        return;
      }
      if (!canAct) return;

      if (key === "w" && wallsLeft > 0) {
        setMode((m) => (m === "step" ? "wall" : "step"));
        setArmed(null);
        return;
      }
      if (key === "u") return doUndo();
      if (key === "h" && vsBot) return void askHint();
      if (key === "r") {
        setOrientation((o) => (o === "h" ? "v" : "h"));
        setArmed((a) => (a ? { ...a, orientation: a.orientation === "h" ? "v" : "h" } : a));
        return;
      }

      const delta: Record<string, Cell> = {
        arrowup: { row: -1, col: 0 },
        arrowdown: { row: 1, col: 0 },
        arrowleft: { row: 0, col: -1 },
        arrowright: { row: 0, col: 1 },
      };
      const raw = delta[key];
      // On a flipped board, "up" on screen is the other way round on the grid.
      const d = raw && flipped ? { row: -raw.row, col: -raw.col } : raw;

      if (mode === "wall") {
        if (key === "escape") {
          setArmed(null);
          setMode("step");
        } else if ((key === "enter" || key === " ") && armed) {
          event.preventDefault();
          if (view.legalWalls.has(wallKey(armed))) placeWall(armed);
          else rejectWall(armed);
        } else if (d) {
          event.preventDefault();
          const max = state.size - 2;
          const base = armed ?? {
            orientation,
            row: Math.floor(max / 2),
            col: Math.floor(max / 2),
          };
          setArmed({
            orientation: base.orientation,
            row: Math.max(0, Math.min(max, base.row + (armed ? d.row : 0))),
            col: Math.max(0, Math.min(max, base.col + (armed ? d.col : 0))),
          });
        }
        return;
      }

      if (!d) return;
      const from = state.pawns[mover];
      const near = { row: from.row + d.row, col: from.col + d.col };
      const far = { row: near.row + d.row, col: near.col + d.col };
      const same = (a: Cell, b: Cell) => a.row === b.row && a.col === b.col;
      const target = view.targets.find((s) => same(s, near)) ?? view.targets.find((s) => same(s, far));
      if (target) {
        event.preventDefault();
        act({ type: "step", ...target });
      }
    };
  });

  // ---------- Words ----------
  const status = (): string => {
    if (rewind) return `Replay · move ${rewind.index} of ${total}`;
    if (liveWinner) return "";
    if (thinking) return "The bot is thinking…";
    if (online && online.opponent.here === false) {
      return online.canClaim
        ? `${names[opponentOf(online.you)]} left. You can claim the win, or keep waiting.`
        : `${names[opponentOf(online.you)]} lost connection. Waiting for them to come back…`;
    }
    if (waiting) return `${names[mover]} is thinking…`;
    if (hint && hint.at === total) {
      return hint.action.type === "step"
        ? `Hint: step to ${actionName(hint.action, state.size)}.`
        : `Hint: barricade at ${actionName(hint.action, state.size)}.`;
    }
    if (mode === "wall") {
      if (armed) {
        const note = describeWall(armed);
        return note?.legal ? `This barricade: ${note.text}.` : reasonFor(armed);
      }
      return "Aim at a groove between squares to place a barricade.";
    }
    const other = opponentOf(mover);
    const lead = routes[other] - routes[mover];
    const yours = vsBot || !!online;
    const whose = yours ? "Your move." : `${names[mover]} to move.`;
    if (lead > 0) return `${whose} ${yours ? "You're" : `${names[mover]} is`} ${plural(lead, "step")} ahead.`;
    if (lead === 0) return `${whose} Dead level, and moving first breaks the tie.`;
    return `${whose} ${vsBot ? "The bot" : names[other]} leads by ${plural(-lead, "step")}. A barricade could swing it.`;
  };

  const modeLabel = online
    ? `Online · ${online.code}`
    : vsBot
      ? `vs Bot · ${LEVEL_LABEL[setup.level]}`
      : "Two players";

  return (
    <main className="game">
      <header className="bar">
        <button type="button" className="btn btn--quiet" onClick={onMenu}>
          <IconBack /> Menu
        </button>
        <div className="bar__title">
          <span className="mini-sign" aria-hidden="true">
            DETOUR
          </span>
          <span className="bar__meta">
            {modeLabel} · {setup.size}×{setup.size}
            {setup.clock && setup.clock !== "off" ? ` · ${setup.clock}` : ""}
          </span>
        </div>
        <div className="bar__actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => onSettings({ sound: !settings.sound })}
            aria-label={settings.sound ? "Mute sound" : "Turn sound on"}
            aria-pressed={!settings.sound}
          >
            {settings.sound ? <IconSound /> : <IconMute />}
          </button>
          <button type="button" className="icon-btn" onClick={onHelp} aria-label="How to play">
            <IconHelp />
          </button>
          <button type="button" className="icon-btn" onClick={onOpenSettings} aria-label="Settings">
            <IconSettings />
          </button>
        </div>
      </header>

      <div className="game__grid">
        <LayoutGroup>
          <div className="area-racers racers">
            {(["south", "north"] as Side[]).map((side) => (
              <RacerCard
                key={side}
                side={side}
                name={names[side]}
                steps={routes[side]}
                walls={state.wallsLeft[side]}
                wallsEach={setup.wallsEach}
                active={!winner && mover === side}
                thinking={(thinking || waiting) && mover === side}
                winner={winner === side}
                tag={vsBot && side === "north" ? LEVEL_LABEL[setup.level] : null}
                away={!!online && side !== online.you && online.opponent.here === false}
                reaction={online?.reactions.filter((r) => r.side === side).at(-1) ?? null}
                clock={
                  timed ? (
                    <RacerClock
                      read={readClock(side)}
                      running={!winner && !rewind && mover === side && (online ? true : clockRunning(match))}
                      audible={side === (online?.you ?? (vsBot ? HUMAN : mover))}
                      stamp={match.moves.length + (match.timedOut ? 1000 : 0)}
                    />
                  ) : null
                }
              />
            ))}
          </div>
        </LayoutGroup>

        <p className="area-status status" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={status()}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16 }}
            >
              {status() || " "}
            </motion.span>
          </AnimatePresence>
        </p>

        <div className="area-board">
          <Board
            view={view}
            interactive={canAct}
            mode={mode}
            orientation={orientation}
            armed={armed}
            onArm={(wall) => {
              setArmed(wall);
              if (wall) setOrientation(wall.orientation);
            }}
            onStep={(cell) => act({ type: "step", ...cell })}
            onWall={placeWall}
            onRejectWall={rejectWall}
            describeWall={describeWall}
            showRoutes={settings.routes && !winner}
            showCoords={settings.coords}
            flipped={flipped}
            hint={hint && hint.at === total && canAct ? hint.action : null}
            sign={sign}
            thinking={thinking}
            celebrate={celebrate}
            shake={shake}
            sideName={names}
          />
        </div>

        <div className="area-controls">
          <AnimatePresence mode="wait" initial={false}>
            {rewind ? (
              <Panel key="replay">
                <ReplayBar
                  rewind={rewind}
                  total={total}
                  onChange={setRewind}
                  onExit={() => setRewind(null)}
                />
              </Panel>
            ) : liveWinner ? (
              <Panel key="result">
                <ResultPanel
                  match={match}
                  winner={liveWinner}
                  routes={routes}
                  onRematch={online ? online.requestRematch : onRematch}
                  online={online}
                  onReplay={() => setRewind({ index: 0, playing: true })}
                  onMenu={onMenu}
                />
              </Panel>
            ) : armed && mode === "wall" ? (
              <Panel key="confirm">
                <div className="confirm-bar">
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      setArmed({
                        ...armed,
                        orientation: armed.orientation === "h" ? "v" : "h",
                      })
                    }
                  >
                    <IconRotate /> Rotate
                  </button>
                  <button type="button" className="btn btn--quiet" onClick={() => setArmed(null)}>
                    <IconClose /> Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn--go"
                    disabled={!view.legalWalls.has(wallKey(armed))}
                    onClick={() => placeWall(armed)}
                  >
                    <IconCheck /> Place
                  </button>
                </div>
              </Panel>
            ) : (
              <Panel key="tools">
                <div className="toolbar">
                  <div className="toolbar__primary">
                    <div className="segmented segmented--tools" role="radiogroup" aria-label="Action">
                      {(["step", "wall"] as const).map((value) => {
                        const checked = mode === value;
                        const disabled = !canAct || (value === "wall" && wallsLeft === 0);
                        return (
                          <label key={value} className={checked ? "is-checked" : undefined}>
                            <input
                              type="radio"
                              name="action"
                              id={`action-${value}`}
                              checked={checked}
                              disabled={disabled}
                              onChange={() => {
                                setMode(value);
                                setArmed(null);
                                sfx.click();
                              }}
                            />
                            {checked ? (
                              <motion.span
                                layoutId="tool-thumb"
                                className="segmented__thumb"
                                transition={{
                                  type: "spring",
                                  stiffness: 520,
                                  damping: 38,
                                }}
                              />
                            ) : null}
                            <span className="segmented__label">
                              {value === "step" ? <IconStep /> : <IconBarricade />}
                              {value === "step" ? "Step" : "Barricade"}
                              {value === "wall" ? <span className="count-badge num">{wallsLeft}</span> : null}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    {mode === "wall" ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setOrientation((o) => (o === "h" ? "v" : "h"))}
                        aria-label={`Barricade direction: ${orientation === "h" ? "across" : "up and down"}. Rotate.`}
                      >
                        <IconRotate
                          style={{
                            transform: orientation === "v" ? "rotate(90deg)" : undefined,
                            transition: "transform 200ms",
                          }}
                        />
                        {orientation === "h" ? "Across" : "Upright"}
                      </button>
                    ) : null}
                  </div>
                  <div className="toolbar__secondary">
                    {online ? null : (
                      <button type="button" className="btn" onClick={doUndo} disabled={!canUndo}>
                        <IconUndo /> Undo
                      </button>
                    )}
                    {vsBot ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void askHint()}
                        disabled={!canAct || hinting}
                      >
                        <IconHint /> {hinting ? "Thinking…" : "Hint"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--quiet"
                      onClick={() => setConfirmResign(true)}
                      disabled={thinking}
                    >
                      <IconFlag /> Resign
                    </button>
                  </div>
                </div>
                {online ? (
                  <div className="reactions" role="group" aria-label="Send a reaction">
                    {REACTIONS.map((text) => (
                      <button key={text} type="button" className="chip" onClick={() => online.react(text)}>
                        {text}
                      </button>
                    ))}
                  </div>
                ) : null}
                {online?.canClaim ? (
                  <div className="claim">
                    <span>{names[opponentOf(online.you)]} has been gone over a minute.</span>
                    <button type="button" className="btn btn--go" onClick={online.claim}>
                      Claim the win
                    </button>
                  </div>
                ) : null}
                <p className="hint-line">
                  <span className="only-fine">
                    Click a highlighted square to move, or a groove to place a barricade.
                  </span>
                  <span className="only-coarse">
                    {mode === "wall"
                      ? "Tap or drag to aim, then Place."
                      : "Tap a highlighted square to move."}
                  </span>
                </p>
              </Panel>
            )}
          </AnimatePresence>
        </div>

        <div className="area-log">
          <MoveLog
            match={match}
            current={rewind ? rewind.index : total}
            onPick={liveWinner ? (index) => setRewind({ index, playing: false }) : undefined}
          />
        </div>
      </div>

      <Modal
        open={confirmResign}
        title={vsBot ? "Resign this race?" : `Resign for ${names[mover]}?`}
        onClose={() => setConfirmResign(false)}
        size="sm"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirmResign(false)} data-autofocus>
              Keep racing
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                setConfirmResign(false);
                if (online) online.resign();
                else onChange(resign(match, vsBot ? HUMAN : mover));
                sfx.lose();
              }}
            >
              <IconFlag /> Resign
            </button>
          </>
        }
      >
        <p>
          {vsBot
            ? "The bot takes the win and the race ends here."
            : `${names[opponentOf(mover)]} takes the win.`}
        </p>
      </Modal>
    </main>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <motion.div
      className="control-panel"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
    >
      {children}
    </motion.div>
  );
}

/**
 * A racer's clock. It ticks on its own (so the board doesn't re-render ten times a second),
 * turns red in the last 20 seconds, and ticks audibly in the last 10 for the player's own clock.
 */
function RacerClock({
  read,
  running,
  audible,
  stamp,
}: {
  read: () => number | null;
  running: boolean;
  audible: boolean;
  /** Changes with every move, so a stopped clock shows its new value straight away. */
  stamp: number;
}) {
  const reader = useRef(read);
  reader.current = read;
  const [ms, setMs] = useState(() => read() ?? 0);
  const lastSecond = useRef<number | null>(null);

  useEffect(() => {
    setMs(reader.current() ?? 0);
    if (!running) return;
    const timer = setInterval(() => {
      const left = reader.current() ?? 0;
      setMs(left);
      const second = Math.ceil(left / 1000);
      if (audible && left > 0 && left <= 10_000 && second !== lastSecond.current) sfx.tick();
      lastSecond.current = second;
    }, 100);
    return () => clearInterval(timer);
  }, [running, audible, stamp]);

  const low = ms <= 20_000;
  const critical = ms <= 10_000;
  return (
    <span
      className={`clock${running ? " clock--running" : ""}${low ? " clock--low" : ""}${
        critical && running ? " clock--critical" : ""
      }`}
      role="timer"
      aria-label={`${formatClock(ms)} left`}
    >
      <span className="num">{formatClock(ms)}</span>
    </span>
  );
}

function RacerCard({
  side,
  name,
  steps,
  walls,
  wallsEach,
  active,
  thinking,
  winner,
  tag,
  away = false,
  reaction = null,
  clock = null,
}: {
  side: Side;
  name: string;
  steps: number;
  walls: number;
  wallsEach: number;
  active: boolean;
  thinking: boolean;
  winner: boolean;
  tag: string | null;
  away?: boolean;
  reaction?: { id: number; text: string } | null;
  clock?: ReactNode;
}) {
  return (
    <div
      className={`racer${active ? " racer--active" : ""}${winner ? " racer--winner" : ""}`}
      style={{ ["--racer" as string]: `var(--${side})` }}
      aria-label={`${name}: ${plural(steps, "step")} to go, ${plural(walls, "barricade")} left`}
    >
      {active ? (
        <motion.span
          layoutId="turn-marker"
          className="racer__marker"
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
        />
      ) : null}
      <div className="racer__head">
        <span className="racer__dot" />
        <span className="racer__name">{name}</span>
        {tag ? <span className="racer__tag">{tag}</span> : null}
        {winner ? <span className="racer__tag racer__tag--win">Winner</span> : null}
        {away ? <span className="racer__tag racer__tag--away">Away</span> : null}
        {thinking && !away ? (
          <span className="thinking" aria-label="thinking">
            <i />
            <i />
            <i />
          </span>
        ) : null}
      </div>
      <AnimatePresence>
        {reaction ? (
          <motion.span
            key={reaction.id}
            className="bubble"
            initial={{ opacity: 0, y: 8, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ type: "spring", stiffness: 520, damping: 26 }}
          >
            {reaction.text}
          </motion.span>
        ) : null}
      </AnimatePresence>
      {clock}
      <div className="racer__steps">
        <Ticker value={steps} className="racer__count num" />
        <span>{steps === 1 ? "step to go" : "steps to go"}</span>
      </div>
      <div className="racer__walls" aria-hidden="true">
        {Array.from({ length: wallsEach }, (_, i) => (
          <motion.span
            key={i}
            className={`pip${i < walls ? " pip--full" : ""}`}
            animate={{
              scaleY: i < walls ? 1 : 0.5,
              opacity: i < walls ? 1 : 0.6,
            }}
            transition={{ type: "spring", stiffness: 500, damping: 26 }}
          />
        ))}
      </div>
    </div>
  );
}

function useCountUp(target: number, duration = 700) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      setValue(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

function formatTime(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function ResultPanel({
  match,
  winner,
  routes,
  onRematch,
  onReplay,
  onMenu,
  online,
}: {
  match: Match;
  winner: Side;
  routes: Record<Side, number>;
  onRematch: () => void;
  onReplay: () => void;
  onMenu: () => void;
  online?: OnlineControls;
}) {
  const vsBot = match.setup.mode === "bot";
  const names = online ? online.names : raceNames(match.setup);
  const loser = opponentOf(winner);
  const humanWon = online ? winner === online.you : !vsBot || winner === HUMAN;
  const margin = match.resigned || match.timedOut ? null : routes[loser];
  const turns = useCountUp(Math.ceil(match.moves.length / 2));
  const marginShown = useCountUp(margin ?? 0);
  const elapsed = match.finishedAt && match.startedAt ? match.finishedAt - match.startedAt : null;

  const opponentName = online ? names[opponentOf(online.you)] : "";
  const onlineTitle = !online
    ? ""
    : online.abandoned
      ? `${opponentName} left the race`
      : match.resigned
        ? match.resigned === online.you
          ? "You resigned"
          : `${opponentName} resigned`
        : winner === online.you
          ? "You crossed first!"
          : `${opponentName} crossed first`;
  const out = match.timedOut ?? null;
  const you = online?.you ?? (vsBot ? HUMAN : null);
  const timeTitle = !out
    ? ""
    : out === you
      ? "Out of time"
      : online
        ? `${opponentName} ran out of time`
        : vsBot
          ? "The bot ran out of time"
          : `${names[out]} ran out of time`;
  const timeLine = !out
    ? ""
    : out === you
      ? "Your clock hit zero. A longer time control gives you more room to think."
      : you
        ? "You win on time."
        : `${names[winner]} wins on time.`;
  const title = out
    ? timeTitle
    : online
      ? onlineTitle
      : match.resigned
        ? vsBot
          ? "You resigned"
          : `${names[match.resigned]} resigned`
        : vsBot
          ? winner === HUMAN
            ? "You crossed first!"
            : "The bot crossed first"
          : `${names[winner]} wins!`;
  const line = out
    ? timeLine
    : online
      ? online.abandoned
        ? "You win by forfeit."
        : match.resigned
          ? match.resigned === online.you
            ? "Every racer has an off day. Run it back?"
            : "You win by resignation."
          : winner === online.you
            ? `You won by ${plural(margin ?? 0, "step")}.`
            : `${opponentName} won by ${plural(margin ?? 0, "step")}. One well-placed barricade could flip it.`
      : match.resigned
        ? "Every racer has an off day. Run it back?"
        : vsBot
          ? winner === HUMAN
            ? `You beat ${LEVEL_LABEL[match.setup.level]} with ${plural(margin ?? 0, "step")} to spare.`
            : `You were ${plural(routes[HUMAN], "step")} short. One well-placed barricade could flip it.`
          : `${names[winner]} won by ${plural(margin ?? 0, "step")}.`;

  const stats: Array<{ label: string; value: string }> = [
    { label: "Turns", value: String(turns) },
    {
      label: online
        ? online.you === "south"
          ? "Your barricades"
          : `${opponentName}'s barricades`
        : vsBot
          ? "Your barricades"
          : "Orange barricades",
      value: `${wallsUsed(match, "south")}/${match.setup.wallsEach}`,
    },
    {
      label: online
        ? online.you === "north"
          ? "Your barricades"
          : `${opponentName}'s barricades`
        : vsBot
          ? "Bot barricades"
          : "Teal barricades",
      value: `${wallsUsed(match, "north")}/${match.setup.wallsEach}`,
    },
  ];
  if (margin !== null) stats.push({ label: "Margin", value: plural(marginShown, "step") });
  if (elapsed) stats.push({ label: "Time", value: formatTime(elapsed) });
  if (vsBot && match.hints) stats.push({ label: "Hints", value: String(match.hints) });

  return (
    <section
      className={`result${humanWon ? " result--win" : ""}`}
      style={{ ["--result" as string]: `var(--${winner})` }}
    >
      <motion.h2
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 380, damping: 18, delay: 0.1 }}
      >
        {title}
      </motion.h2>
      <p className="result__line">{line}</p>
      <div className="result__stats">
        {stats.map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              delay: 0.2 + i * 0.06,
              type: "spring",
              stiffness: 420,
              damping: 30,
            }}
          >
            <b className="num">{s.value}</b>
            <span>{s.label}</span>
          </motion.div>
        ))}
      </div>
      <div className="result__actions">
        {online ? (
          <button
            type="button"
            className="btn btn--go"
            onClick={onRematch}
            disabled={online.rematch.you}
            data-autofocus
          >
            <IconRestart />{" "}
            {online.rematch.you
              ? `Waiting for ${names[opponentOf(online.you)]}…`
              : online.rematch.them
                ? "Accept rematch"
                : "Rematch"}
          </button>
        ) : (
          <button type="button" className="btn btn--go" onClick={onRematch} data-autofocus>
            <IconRestart /> Race again
          </button>
        )}
        <button type="button" className="btn" onClick={onReplay}>
          <IconReplay /> Watch replay
        </button>
        <button type="button" className="btn btn--quiet" onClick={onMenu}>
          {online ? "Leave" : "Change settings"}
        </button>
      </div>
    </section>
  );
}

function ReplayBar({
  rewind,
  total,
  onChange,
  onExit,
}: {
  rewind: Rewind;
  total: number;
  onChange: (r: Rewind) => void;
  onExit: () => void;
}) {
  const go = (index: number) => onChange({ index: Math.max(0, Math.min(total, index)), playing: false });
  return (
    <div className="replay">
      <div className="replay__buttons">
        <button type="button" className="icon-btn" onClick={() => go(0)} aria-label="First move">
          <IconFirst />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => go(rewind.index - 1)}
          aria-label="Previous move"
        >
          <IconPrev />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--primary"
          onClick={() =>
            onChange({
              index: rewind.index >= total ? 0 : rewind.index,
              playing: !rewind.playing,
            })
          }
          aria-label={rewind.playing ? "Pause" : "Play"}
        >
          {rewind.playing ? <IconPause /> : <IconPlay />}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => go(rewind.index + 1)}
          aria-label="Next move"
        >
          <IconNext />
        </button>
        <button type="button" className="icon-btn" onClick={() => go(total)} aria-label="Last move">
          <IconLast />
        </button>
      </div>
      <input
        id="replay-scrub"
        type="range"
        className="replay__scrub"
        min={0}
        max={total}
        value={rewind.index}
        onChange={(event) => go(Number(event.target.value))}
        aria-label="Replay position"
        style={{
          ["--fill" as string]: `${total ? (rewind.index / total) * 100 : 0}%`,
        }}
      />
      <div className="replay__foot">
        <span className="num">
          {rewind.index}/{total}
        </span>
        <button type="button" className="btn btn--quiet" onClick={onExit}>
          Done
        </button>
      </div>
    </div>
  );
}

function MoveLog({
  match,
  current,
  onPick,
}: {
  match: Match;
  current: number;
  onPick?: (index: number) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const size = match.setup.size;
  const rows: Array<Array<{ index: number; text: string; side: Side; wall: boolean }>> = [];
  match.moves.forEach((m, i) => {
    const entry = {
      index: i + 1,
      text: actionName(m.action, size),
      side: m.side,
      wall: m.action.type === "wall",
    };
    if (i % 2 === 0) rows.push([entry]);
    else rows[rows.length - 1]!.push(entry);
  });

  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(".log__move--current");
    el?.scrollIntoView({ block: "nearest" });
  }, [current, match.moves.length]);

  return (
    <details className="log" open>
      <summary>
        Moves <span className="num">{match.moves.length}</span>
      </summary>
      {rows.length === 0 ? (
        <p className="log__empty">No moves yet. {match.setup.mode === "bot" ? "You" : "Orange"} go first.</p>
      ) : (
        <ol className="log__list" ref={list}>
          {rows.map((pair, turn) => (
            <li key={turn}>
              <span className="log__turn num">{turn + 1}</span>
              {pair.map((entry) => (
                <button
                  key={entry.index}
                  type="button"
                  className={`log__move log__move--${entry.side}${entry.index === current ? " log__move--current" : ""}`}
                  onClick={onPick ? () => onPick(entry.index) : undefined}
                  disabled={!onPick}
                  aria-label={`Move ${entry.index}: ${entry.wall ? "barricade" : "step"} ${entry.text}`}
                >
                  {entry.wall ? <IconBarricade className="log__icon" /> : null}
                  <span className="num">{entry.text}</span>
                </button>
              ))}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
