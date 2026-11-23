import { useEffect, useMemo, useRef, useState } from "react";
import { wallKey, type Cell, type Orientation, type Wall } from "../engine/board";
import type { BotLevel } from "../engine/bot";
import { goalRow, legalWalls, opponentOf, type DetourAction, type Side } from "../engine/game";
import {
  HUMAN,
  isBotTurn,
  play,
  playBot,
  replay,
  resign,
  routeLength,
  sideToMove,
  undo,
  wallsUsed,
  winnerOf,
  type Match,
} from "../engine/match";
import { Board, type BoardView, type DetourSign } from "./Board";
import { IconBack, IconBarricade, IconFlag, IconRestart, IconRotate, IconRoute, IconStep, IconUndo } from "./icons";

/** Long enough that the bot's reply reads as a reply, short enough to never feel like lag. */
const BOT_DELAY_MS = 520;

export const LEVEL_LABEL: Record<BotLevel, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

interface GameProps {
  match: Match;
  showRoutes: boolean;
  onToggleRoutes: () => void;
  onChange: (match: Match) => void;
  onRematch: () => void;
  onMenu: () => void;
}

export function Game({ match, showRoutes, onToggleRoutes, onChange, onRematch, onMenu }: GameProps) {
  const { setup } = match;
  const vsBot = setup.mode === "bot";
  const state = useMemo(() => replay(match), [match]);
  const winner = winnerOf(match, state);
  const mover = sideToMove(match);
  const thinking = isBotTurn(match);
  const canAct = !winner && !thinking;
  const names: Record<Side, string> = vsBot
    ? { south: "You", north: `Bot (${LEVEL_LABEL[setup.level]})` }
    : { south: "Orange", north: "Teal" };

  const [mode, setMode] = useState<"step" | "wall">("step");
  const [orientation, setOrientation] = useState<Orientation>("h");
  const [confirmResign, setConfirmResign] = useState(false);
  const [sign, setSign] = useState<DetourSign | null>(null);

  const routes = useMemo(
    () => ({ south: routeLength(state, "south"), north: routeLength(state, "north") }),
    [state],
  );

  const view: BoardView = useMemo(
    () => ({
      size: state.size,
      walls: state.grid.walls.map((w) => ({ ...w, owner: state.owners.get(wallKey(w)) ?? "stone" })),
      pawns: state.pawns,
      routes: {
        south: state.grid.shortestPath(state.pawns.south, goalRow(state.size, "south")),
        north: state.grid.shortestPath(state.pawns.north, goalRow(state.size, "north")),
      },
      legalSteps: canAct ? state.grid.pawnMoves(state.pawns[mover], state.pawns[opponentOf(mover)]) : [],
      legalWalls: canAct ? new Set(legalWalls(state, mover).map(wallKey)) : new Set<string>(),
      mover,
    }),
    [state, canAct, mover],
  );

  const lastMove = match.moves[match.moves.length - 1];
  const newestWall = lastMove?.action.type === "wall" ? wallKey(lastMove.action as Wall) : null;

  // The bot takes its turn after a short pause.
  useEffect(() => {
    if (!isBotTurn(match)) return;
    const timer = setTimeout(() => onChange(playBot(match)), BOT_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match]);

  // Pop a DETOUR sign over whoever a fresh wall just sent the long way round.
  const previous = useRef<{ moves: number; routes: Record<Side, number> } | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = { moves: match.moves.length, routes };
    if (!before || match.moves.length !== before.moves + 1 || !lastMove || lastMove.action.type !== "wall") return;
    const target = opponentOf(lastMove.side);
    const amount = routes[target] - before.routes[target];
    if (amount > 0) setSign({ id: match.moves.length, side: target, amount });
  }, [match.moves.length, routes, lastMove]);

  useEffect(() => {
    if (!sign) return;
    const timer = setTimeout(() => setSign(null), 1900);
    return () => clearTimeout(timer);
  }, [sign]);

  // Out of walls: there's nothing to do in wall mode.
  useEffect(() => {
    if (mode === "wall" && state.wallsLeft[mover] === 0) setMode("step");
  }, [mode, mover, state.wallsLeft]);

  const act = (action: DetourAction) => {
    const next = play(match, action);
    if (!next) return;
    setMode("step");
    setConfirmResign(false);
    onChange(next);
  };

  const canUndo =
    !winner && !thinking && match.moves.some((m) => !vsBot || m.side === HUMAN) && match.moves.length > 0;

  // Keyboard: arrows step (jumping when the other pawn is in the way), W walls, R rotates, U undoes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof HTMLInputElement) return;
      const key = event.key.toLowerCase();
      if (key === "r") return setOrientation((o) => (o === "h" ? "v" : "h"));
      if (key === "w" && canAct && state.wallsLeft[mover] > 0) return setMode((m) => (m === "step" ? "wall" : "step"));
      if (key === "u" && canUndo) return onChange(undo(match));
      const delta: Record<string, Cell> = {
        arrowup: { row: -1, col: 0 },
        arrowdown: { row: 1, col: 0 },
        arrowleft: { row: 0, col: -1 },
        arrowright: { row: 0, col: 1 },
      };
      const d = delta[key];
      if (!d || !canAct) return;
      const from = state.pawns[mover];
      const near = { row: from.row + d.row, col: from.col + d.col };
      const far = { row: near.row + d.row, col: near.col + d.col };
      const same = (a: Cell, b: Cell) => a.row === b.row && a.col === b.col;
      const target = view.legalSteps.find((s) => same(s, near)) ?? view.legalSteps.find((s) => same(s, far));
      if (target) {
        event.preventDefault();
        act({ type: "step", ...target });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const statusLine = () => {
    if (thinking) return <>The bot is thinking…</>;
    const other = opponentOf(mover);
    const lead = routes[other] - routes[mover];
    const who = vsBot ? "Your" : `${names[mover]}'s`;
    const turn = <b>{who} turn.</b>;
    if (lead > 0) return <>{turn} {vsBot ? "You're" : `${names[mover]} is`} {plural(lead, "step")} ahead.</>;
    if (lead === 0) return <>{turn} Dead level, and moving first breaks the tie.</>;
    return (
      <>
        {turn} {names[other]} is {plural(-lead, "step")} ahead. A barricade could swing it.
      </>
    );
  };

  // Six barricades sit in one row; ten stack as two rows of five.
  const pipColumns = setup.wallsEach > 6 ? Math.ceil(setup.wallsEach / 2) : setup.wallsEach;

  const racer = (side: Side) => {
    const active = !winner && mover === side;
    return (
      <div
        className={`racer${active ? " racer--active" : ""}`}
        style={{ ["--racer-color" as string]: `var(--${side})` }}
        aria-label={`${names[side]}: ${plural(routes[side], "step")} to go, ${plural(state.wallsLeft[side], "barricade")} left`}
      >
        <div className="racer__name">{names[side]}</div>
        <div className="racer__steps">
          <b>{routes[side]}</b>
          {routes[side] === 1 ? "step" : "steps"} to go
        </div>
        <div
          className="racer__walls"
          aria-hidden="true"
          style={{ gridTemplateColumns: `repeat(${pipColumns}, var(--pip-w))` }}
        >
          {Array.from({ length: setup.wallsEach }, (_, i) => (
            <span key={i} className={`pip${i < state.wallsLeft[side] ? " pip--full" : ""}`} />
          ))}
        </div>
      </div>
    );
  };

  const result = () => {
    if (!winner) return null;
    const loser = opponentOf(winner);
    const title = match.resigned
      ? vsBot
        ? "You resigned"
        : `${names[match.resigned]} resigned`
      : vsBot
        ? winner === HUMAN
          ? "You crossed first!"
          : "The bot crossed first"
        : `${names[winner]} wins!`;
    return (
      <section
        className="panel result"
        style={{ ["--result-color" as string]: `var(--${winner})` }}
        aria-live="polite"
      >
        <h2>{title}</h2>
        <div className="result__stats">
          <div>
            <b>{Math.ceil(match.moves.length / 2)}</b>
            <span>Turns</span>
          </div>
          <div>
            <b>
              {wallsUsed(match, "south")}/{setup.wallsEach}
            </b>
            <span>{vsBot ? "Your barricades" : "Orange barricades"}</span>
          </div>
          <div>
            <b>
              {wallsUsed(match, "north")}/{setup.wallsEach}
            </b>
            <span>{vsBot ? "Bot barricades" : "Teal barricades"}</span>
          </div>
          {!match.resigned ? (
            <div>
              <b>{plural(routes[loser], "step")}</b>
              <span>Winning margin</span>
            </div>
          ) : null}
        </div>
        <div className="row" style={{ justifyContent: "center" }}>
          <button type="button" className="btn btn--go" onClick={onRematch}>
            <IconRestart /> Race again
          </button>
          <button type="button" className="btn" onClick={onMenu}>
            Change settings
          </button>
        </div>
        <p className="hint">“Race again” keeps your settings and deals a new layout.</p>
      </section>
    );
  };

  return (
    <main className="app">
      <header className="topbar">
        <button type="button" className="btn btn--quiet" onClick={onMenu}>
          <IconBack /> Menu
        </button>
        <div className="topbar__title">
          <h1>DETOUR</h1>
          <span className="eyebrow">
            {vsBot ? `vs bot · ${LEVEL_LABEL[setup.level]}` : "2 players"} · {setup.size}×{setup.size}
          </span>
        </div>
        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => setConfirmResign(true)}
          disabled={thinking}
          style={winner ? { visibility: "hidden" } : undefined}
        >
          <IconFlag /> Resign
        </button>
      </header>

      <div className="racers">
        {racer("south")}
        {racer("north")}
      </div>

      <p className="status" aria-live="polite">
        {winner ? " " : statusLine()}
      </p>

      <Board
        view={view}
        interactive={canAct}
        mode={mode}
        orientation={orientation}
        showRoutes={showRoutes && !winner}
        newestWall={newestWall}
        sign={sign}
        sideName={names}
        onStep={(cell) => act({ type: "step", ...cell })}
        onWall={(wall) => act({ type: "wall", ...wall })}
      />

      {winner ? (
        result()
      ) : (
        <>
          <div className="toolbar">
            <div className="segmented" role="radiogroup" aria-label="Action">
              <label>
                <input
                  type="radio"
                  name="action"
                  id="action-step"
                  checked={mode === "step"}
                  onChange={() => setMode("step")}
                  disabled={!canAct}
                />
                <span>
                  <IconStep /> Step
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="action"
                  id="action-wall"
                  checked={mode === "wall"}
                  onChange={() => setMode("wall")}
                  disabled={!canAct || state.wallsLeft[mover] === 0}
                />
                <span>
                  <IconBarricade /> Barricade
                </span>
              </label>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => setOrientation((o) => (o === "h" ? "v" : "h"))}
              disabled={mode !== "wall"}
              aria-label={`Barricade direction: ${orientation === "h" ? "across" : "up and down"}. Rotate.`}
            >
              <IconRotate style={{ transform: orientation === "v" ? "rotate(90deg)" : undefined }} />
              {orientation === "h" ? "Across" : "Up–down"}
            </button>
            <button type="button" className="btn" onClick={() => onChange(undo(match))} disabled={!canUndo}>
              <IconUndo /> Undo
            </button>
            <button type="button" className="btn" aria-pressed={showRoutes} onClick={onToggleRoutes}>
              <IconRoute /> Routes
            </button>
          </div>

          {confirmResign ? (
            <div className="panel confirm" role="alertdialog" aria-label="Confirm resignation">
              <span>{vsBot ? "Give this race to the bot?" : `Concede the race for ${names[mover]}?`}</span>
              <div className="row">
                <button type="button" className="btn" onClick={() => setConfirmResign(false)}>
                  Keep racing
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ borderColor: "var(--bad)", color: "var(--bad)" }}
                  onClick={() => {
                    setConfirmResign(false);
                    onChange(resign(match, vsBot ? HUMAN : mover));
                  }}
                >
                  Resign
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}

      <details className="panel rules">
        <summary>How to play</summary>
        <ul>
          <li>
            Reach the far side first: {vsBot ? "you head for the top edge, the bot for the bottom" : "Orange heads up, Teal heads down"}.
            {vsBot ? " You move first." : " Orange moves first."}
          </li>
          <li>On your turn, either step one square or put down one of your {setup.wallsEach} barricades.</li>
          <li>
            Barricades are two squares long and block everyone. They can't overlap or cross, and they can never cut
            anyone off completely.
          </li>
          <li>Face to face with the other racer? Jump straight over, or hop diagonally if a barricade is behind them.</li>
          <li>Grey concrete blocks are roadworks: fixed for the whole race, placed in mirror-image pairs so it stays fair.</li>
          <li>The dotted lines show each racer's shortest route right now.</li>
          <li>Keyboard: arrow keys step, W switches to barricades, R rotates, U undoes.</li>
        </ul>
      </details>
    </main>
  );
}
