import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useAnimate, useIsPresent, useReducedMotion } from "motion/react";
import { sameCell, wallKey, type Cell, type Orientation, type Wall } from "../../engine/board";
import type { DetourAction, Side, WallOwner } from "../../engine/game";
import { fileName, rankName } from "../../engine/notation";
import { Confetti } from "./Confetti";
import {
  CELL,
  LABEL,
  PAD,
  PITCH,
  cellCentre,
  frameFor,
  pick,
  toBoard,
  toPercent,
  wallCentre,
  wallRect,
  type Pick,
} from "./geometry";
import type { BoardView } from "./view";

export interface DetourSign {
  id: number;
  side: Side;
  amount: number;
}

export interface WallNote {
  legal: boolean;
  text: string;
}

interface BoardProps {
  view: BoardView;
  interactive?: boolean;
  /** "step": squares only on touch (a mouse can still aim at grooves). "wall": everything aims a barricade. */
  mode?: "step" | "wall";
  orientation?: Orientation;
  /** A barricade chosen but not yet placed (touch and keyboard place in two stages). */
  armed?: Wall | null;
  onArm?: (wall: Wall | null) => void;
  onStep?: (cell: Cell) => void;
  onWall?: (wall: Wall) => void;
  onRejectWall?: (wall: Wall) => void;
  /** The live caption over a previewed barricade, e.g. "Bot +2 · You +0". */
  describeWall?: (wall: Wall) => WallNote | null;
  showRoutes?: boolean;
  showCoords?: boolean;
  hint?: DetourAction | null;
  sign?: DetourSign | null;
  thinking?: boolean;
  /** Bump to fire confetti over the winner. */
  celebrate?: number;
  /** Bump to give the board a small jolt (a big detour). */
  shake?: number;
  sideName?: Record<Side, string>;
  label?: string;
  /** Draw the move targets as a non-interactive illustration (rules diagrams). */
  illustrateTargets?: boolean;
  /** Turn the board 180° so North's player sees their own pawn at the bottom (online play). */
  flipped?: boolean;
  children?: ReactNode;
}

const SIDE_COLOR: Record<Side, string> = {
  south: "var(--south)",
  north: "var(--north)",
};
const SPRING = { type: "spring", stiffness: 520, damping: 34 } as const;
const SNAP = {
  type: "spring",
  stiffness: 900,
  damping: 52,
  mass: 0.6,
} as const;

export function Board({
  view,
  interactive = false,
  mode = "step",
  orientation = "h",
  armed = null,
  onArm,
  onStep,
  onWall,
  onRejectWall,
  describeWall,
  showRoutes = true,
  showCoords = false,
  hint = null,
  sign = null,
  thinking = false,
  celebrate = 0,
  shake = 0,
  sideName = { south: "South", north: "North" },
  label,
  illustrateTargets = false,
  flipped = false,
  children,
}: BoardProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const reduce = useReducedMotion() ?? false;
  const [hover, setHover] = useState<Pick>(null);
  const press = useRef<{ armedKey: string | null; moved: boolean } | null>(null);
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const frame = frameFor(view.size, showCoords);
  const { size, span } = frame;

  useEffect(() => setHover(null), [view.moveCount, mode, interactive]);

  useEffect(() => {
    if (!shake || reduce || !scope.current) return;
    void animate(scope.current, { x: [0, -6, 6, -4, 3, 0] }, { duration: 0.42, ease: "easeOut" });
  }, [shake, reduce, animate, scope]);

  const pickAt = (event: PointerEvent<SVGSVGElement>, forTouch: boolean): Pick => {
    const svg = svgRef.current;
    if (!svg) return null;
    const raw = toBoard(frame, svg.getBoundingClientRect(), event.clientX, event.clientY);
    const { x, y } = flipped ? { x: span - raw.x, y: span - raw.y } : raw;
    const pickMode = mode === "wall" ? "wall" : forTouch ? "step" : "auto";
    return pick(frame, x, y, {
      targets: view.targets,
      mode: pickMode,
      orientation,
    });
  };

  const isTouch = (event: PointerEvent) => event.pointerType === "touch" || event.pointerType === "pen";

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (!interactive || !isTouch(event) || mode !== "wall") return;
    svgRef.current?.setPointerCapture(event.pointerId);
    press.current = { armedKey: armed ? wallKey(armed) : null, moved: false };
    const target = pickAt(event, true);
    if (target?.kind === "wall" && (!armed || wallKey(target.wall) !== wallKey(armed))) {
      press.current.moved = press.current.armedKey !== null;
      onArm?.(target.wall);
    }
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!interactive) return;
    if (isTouch(event)) {
      // Dragging a finger slides the barricade preview along the grooves.
      if (mode !== "wall" || !press.current) return;
      const target = pickAt(event, true);
      if (target?.kind === "wall" && (!armed || wallKey(target.wall) !== wallKey(armed))) {
        press.current.moved = true;
        onArm?.(target.wall);
      }
      return;
    }
    setHover(pickAt(event, false));
  };

  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    if (!interactive) return;
    const target = pickAt(event, isTouch(event));
    if (isTouch(event)) {
      const pressed = press.current;
      press.current = null;
      if (mode !== "wall" || target?.kind !== "wall") return;
      const key = wallKey(target.wall);
      // A still second tap on the barricade already showing places it.
      if (pressed && !pressed.moved && pressed.armedKey === key) {
        if (view.legalWalls.has(key)) onWall?.(target.wall);
        else onRejectWall?.(target.wall);
      } else onArm?.(target.wall);
      return;
    }
    if (target?.kind !== "wall") return; // squares handle their own clicks
    if (view.legalWalls.has(wallKey(target.wall))) onWall?.(target.wall);
    else onRejectWall?.(target.wall);
  };

  const hoverWall = !armed && interactive && hover?.kind === "wall" ? hover.wall : null;
  const preview = armed ?? hoverWall;
  const previewLegal = preview ? view.legalWalls.has(wallKey(preview)) : false;
  const note = preview && describeWall ? describeWall(preview) : null;
  const ghostCell =
    interactive &&
    mode === "step" &&
    hover?.kind === "cell" &&
    view.targets.some((t) => sameCell(t, hover.cell))
      ? hover.cell
      : null;

  const cells: Cell[] = [];
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) cells.push({ row, col });
  const points = (route: Cell[]) =>
    route
      .map((c) => {
        const p = cellCentre(c);
        return `${p.x},${p.y}`;
      })
      .join(" ");

  const fillFor = (owner: WallOwner) =>
    owner === "stone" ? `url(#${uid}-concrete)` : `url(#${uid}-stripes-${owner})`;
  // Board units to a % position over the SVG, honouring the flip.
  const place = (x: number, y: number) =>
    flipped ? toPercent(frame, span - x, span - y) : toPercent(frame, x, y);
  const notePos = preview ? place(wallCentre(preview).x, wallCentre(preview).y) : null;
  const signPos = sign
    ? place(cellCentre(view.pawns[sign.side]).x, cellCentre(view.pawns[sign.side]).y)
    : null;
  const winnerPos = view.winner
    ? place(cellCentre(view.pawns[view.winner]).x, cellCentre(view.pawns[view.winner]).y)
    : null;

  return (
    <div className="board-wrap" ref={scope}>
      <svg
        ref={svgRef}
        className={`board${interactive && mode === "wall" ? " board--aiming" : ""}`}
        viewBox={`${frame.minX} ${frame.minY} ${frame.width} ${frame.height}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (press.current = null)}
        role="group"
        aria-label={
          label ??
          `Board ${size} by ${size}. ${sideName.south} on ${fileName(view.pawns.south.col)}${rankName(
            view.pawns.south.row,
            size,
          )}, ${sideName.north} on ${fileName(view.pawns.north.col)}${rankName(view.pawns.north.row, size)}.`
        }
      >
        <defs>
          {(["south", "north"] as Side[]).map((side) => (
            <pattern
              key={side}
              id={`${uid}-stripes-${side}`}
              patternUnits="userSpaceOnUse"
              width="2.8"
              height="2.8"
              patternTransform="rotate(45)"
            >
              <rect width="2.8" height="2.8" style={{ fill: SIDE_COLOR[side] }} />
              <rect width="1.15" height="2.8" style={{ fill: "var(--lane)" }} />
            </pattern>
          ))}
          {(["south", "north"] as Side[]).map((side) => (
            <pattern
              key={`goal-${side}`}
              id={`${uid}-goal-${side}`}
              patternUnits="userSpaceOnUse"
              width="3.2"
              height="3.2"
              patternTransform="rotate(-45)"
            >
              <rect width="1.25" height="3.2" style={{ fill: SIDE_COLOR[side], opacity: 0.34 }} />
            </pattern>
          ))}
          <linearGradient id={`${uid}-concrete`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: "var(--concrete-hi)" }} />
            <stop offset="1" style={{ stopColor: "var(--concrete)" }} />
          </linearGradient>
          <linearGradient id={`${uid}-sheen`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "#fff", stopOpacity: 0.07 }} />
            <stop offset="0.5" style={{ stopColor: "#fff", stopOpacity: 0 }} />
          </linearGradient>
          <radialGradient id={`${uid}-shadow`}>
            <stop offset="0" style={{ stopColor: "#000", stopOpacity: 0.55 }} />
            <stop offset="1" style={{ stopColor: "#000", stopOpacity: 0 }} />
          </radialGradient>
        </defs>

        {/* Asphalt slab with a faint top sheen. */}
        <rect
          x={-PAD}
          y={-PAD}
          width={span + PAD * 2}
          height={span + PAD * 2}
          rx={3.2}
          className="board__slab"
        />
        <rect
          x={-PAD}
          y={-PAD}
          width={span + PAD * 2}
          height={span + PAD * 2}
          rx={3.2}
          fill={`url(#${uid}-sheen)`}
        />

        {showCoords ? (
          <g className="board__coords" aria-hidden="true">
            {Array.from({ length: size }, (_, i) => (
              <text key={`f${i}`} x={i * PITCH + CELL / 2} y={span + PAD + LABEL * 0.62} textAnchor="middle">
                {fileName(flipped ? size - 1 - i : i)}
              </text>
            ))}
            {Array.from({ length: size }, (_, i) => (
              <text key={`r${i}`} x={-PAD - LABEL * 0.48} y={i * PITCH + CELL / 2 + 1.1} textAnchor="middle">
                {rankName(flipped ? size - 1 - i : i, size)}
              </text>
            ))}
          </g>
        ) : null}

        <g transform={flipped ? `rotate(180 ${span / 2} ${span / 2})` : undefined}>
          {cells.map((cell) => {
            const goalOf: Side | null = cell.row === 0 ? "south" : cell.row === size - 1 ? "north" : null;
            return (
              <g key={`c${cell.row}-${cell.col}`}>
                <rect
                  x={cell.col * PITCH}
                  y={cell.row * PITCH}
                  width={CELL}
                  height={CELL}
                  rx={1.5}
                  className="board__cell"
                />
                {goalOf ? (
                  <rect
                    x={cell.col * PITCH}
                    y={cell.row * PITCH}
                    width={CELL}
                    height={CELL}
                    rx={1.5}
                    className={`board__goal board__goal--${goalOf}${view.winner === goalOf ? " board__goal--won" : ""}`}
                    style={view.winner === goalOf ? undefined : { fill: `url(#${uid}-goal-${goalOf})` }}
                  />
                ) : null}
              </g>
            );
          })}

          {/* Lane markings along each finish edge, in the colour of whoever is heading there. */}
          <line x1={0} x2={span} y1={-PAD / 2} y2={-PAD / 2} className="board__lane board__lane--south" />
          <line
            x1={0}
            x2={span}
            y1={span + PAD / 2}
            y2={span + PAD / 2}
            className="board__lane board__lane--north"
          />

          <AnimatePresence>
            {showRoutes
              ? (["north", "south"] as Side[]).map((side) => {
                  const pts = points(view.routes[side]);
                  const nudge = side === "south" ? -0.9 : 0.9;
                  return (
                    <motion.polyline
                      key={`${side}:${pts}`}
                      points={pts}
                      transform={`translate(${nudge} ${nudge})`}
                      className={`route route--${side}`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.25 }}
                    />
                  );
                })
              : null}
          </AnimatePresence>

          <AnimatePresence>
            {view.lastFrom && view.lastSide ? (
              <motion.circle
                key={`from-${view.moveCount}`}
                cx={cellCentre(view.lastFrom).x}
                cy={cellCentre(view.lastFrom).y}
                r={2.4}
                fill="none"
                strokeWidth={0.6}
                strokeDasharray="1 1"
                style={{ stroke: SIDE_COLOR[view.lastSide] }}
                initial={{ opacity: 0.9 }}
                animate={{ opacity: 0.35 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.8 }}
                pointerEvents="none"
              />
            ) : null}
          </AnimatePresence>

          {hint?.type === "step" ? (
            <circle
              cx={cellCentre(hint).x}
              cy={cellCentre(hint).y}
              r={4.4}
              className="board__hint"
              pointerEvents="none"
            />
          ) : null}

          <AnimatePresence>
            {illustrateTargets
              ? view.targets.map((step) => (
                  <circle
                    key={`i${step.row}-${step.col}`}
                    cx={cellCentre(step).x}
                    cy={cellCentre(step).y}
                    r={1.45}
                    className="target__dot"
                    style={{ fill: SIDE_COLOR[view.mover] }}
                  />
                ))
              : null}
            {interactive && mode === "step"
              ? view.targets.map((step, i) => (
                  <Target
                    key={`t${step.row}-${step.col}-${view.moveCount}`}
                    step={step}
                    index={i}
                    size={size}
                    color={SIDE_COLOR[view.mover]}
                    reduce={reduce}
                    onStep={onStep}
                  />
                ))
              : null}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {view.walls.map((wall) => {
              const key = wallKey(wall);
              return (
                <motion.rect
                  key={key}
                  {...wallRect(wall)}
                  rx={0.75}
                  className={`barricade barricade--${wall.owner}`}
                  style={{
                    fill: fillFor(wall.owner),
                    transformBox: "fill-box",
                    transformOrigin: "center",
                  }}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{
                    opacity: 0,
                    scale: 0.7,
                    transition: { duration: 0.18 },
                  }}
                  transition={{
                    type: "spring",
                    stiffness: 640,
                    damping: 21,
                    mass: 0.9,
                  }}
                />
              );
            })}
          </AnimatePresence>

          {view.newestWall && !reduce ? (
            <Dust key={`dust-${view.newestWall}-${view.moveCount}`} wallKeyText={view.newestWall} />
          ) : null}

          {hint?.type === "wall" ? (
            <rect {...wallRect(hint)} rx={0.75} className="board__hint-wall" pointerEvents="none" />
          ) : null}

          <AnimatePresence>
            {preview ? (
              <motion.rect
                key="preview"
                rx={0.75}
                pointerEvents="none"
                className={`preview${previewLegal ? "" : " preview--bad"}${armed ? " preview--armed" : ""}`}
                style={previewLegal ? { fill: `url(#${uid}-stripes-${view.mover})` } : undefined}
                initial={{ opacity: 0, ...wallRect(preview) }}
                animate={{ opacity: 1, ...wallRect(preview) }}
                exit={{ opacity: 0, transition: { duration: 0.12 } }}
                transition={reduce ? { duration: 0 } : SNAP}
              />
            ) : null}
          </AnimatePresence>

          {ghostCell ? (
            <circle
              cx={cellCentre(ghostCell).x}
              cy={cellCentre(ghostCell).y}
              r={3.9}
              className="ghost-pawn"
              style={{ fill: SIDE_COLOR[view.mover] }}
              pointerEvents="none"
            />
          ) : null}

          <g pointerEvents="none">
            {(["north", "south"] as Side[]).map((side) => (
              <Pawn
                key={side}
                side={side}
                cell={view.pawns[side]}
                active={!view.winner && interactive && view.mover === side}
                thinking={thinking && view.mover === side}
                won={view.winner === side}
                reduce={reduce}
                shadowFill={`url(#${uid}-shadow)`}
              />
            ))}
          </g>
        </g>
      </svg>

      <AnimatePresence>
        {note && notePos ? (
          <div
            className="board-note-anchor"
            style={{ left: `${notePos.left}%`, top: `${notePos.top}%` }}
            key="note"
          >
            <motion.div
              className={`board-note${note.legal ? "" : " board-note--bad"}`}
              initial={{ opacity: 0, y: 4, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              transition={{ duration: 0.16 }}
            >
              {note.text}
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {sign && signPos ? (
          <div
            className="detour-anchor"
            style={{ left: `${signPos.left}%`, top: `${signPos.top}%` }}
            key={sign.id}
          >
            <motion.div
              className="detour-sign"
              role="status"
              style={{ background: SIDE_COLOR[sign.side] }}
              initial={{ opacity: 0, scale: 0.4, y: 14, rotate: -8 }}
              animate={{ opacity: 1, scale: 1, y: 0, rotate: -3 }}
              exit={{ opacity: 0, y: -14, transition: { duration: 0.3 } }}
              transition={{ type: "spring", stiffness: 520, damping: 18 }}
            >
              <span>DETOUR</span>
              <b className="num">+{sign.amount}</b>
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>

      {winnerPos && view.winner && !reduce ? (
        <Confetti fire={celebrate} originLeft={winnerPos.left} originTop={winnerPos.top} side={view.winner} />
      ) : null}

      {children}
    </div>
  );
}

/** A square the mover can step to. Inert while animating out, so a stale one can't be activated. */
function Target({
  step,
  index,
  size,
  color,
  reduce,
  onStep,
}: {
  step: Cell;
  index: number;
  size: number;
  color: string;
  reduce: boolean;
  onStep?: (cell: Cell) => void;
}) {
  const present = useIsPresent();
  const p = cellCentre(step);
  const activate = (target: Element) => {
    if (!present) return;
    // Let go of focus: this square is about to disappear, and keys should reach the game again.
    (target as SVGElement).blur?.();
    onStep?.(step);
  };
  return (
    <motion.g
      className="target"
      role="button"
      tabIndex={present ? 0 : -1}
      aria-hidden={present ? undefined : true}
      aria-label={`Move to ${fileName(step.col)}${rankName(step.row, size)}`}
      onClick={(event) => activate(event.currentTarget)}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate(event.currentTarget);
        }
      }}
      style={{
        transformBox: "fill-box",
        transformOrigin: "center",
        pointerEvents: present ? undefined : "none",
      }}
      initial={{ opacity: 0, scale: 0.5 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.12 } }}
      transition={{ ...SPRING, delay: reduce ? 0 : 0.12 + index * 0.03 }}
    >
      <rect
        x={step.col * PITCH}
        y={step.row * PITCH}
        width={CELL}
        height={CELL}
        rx={1.5}
        className="target__pad"
      />
      <circle cx={p.x} cy={p.y} r={1.45} className="target__dot" style={{ fill: color }} />
    </motion.g>
  );
}

function Pawn({
  side,
  cell,
  active,
  thinking,
  won,
  reduce,
  shadowFill,
}: {
  side: Side;
  cell: Cell;
  active: boolean;
  thinking: boolean;
  won: boolean;
  reduce: boolean;
  shadowFill: string;
}) {
  // Remember the last square so a jump (two squares, or diagonal) gets a proper arc.
  const [travel, setTravel] = useState({ cell, jump: false, n: 0 });
  if (!sameCell(travel.cell, cell)) {
    const distance = Math.abs(travel.cell.row - cell.row) + Math.abs(travel.cell.col - cell.col);
    setTravel({ cell, jump: distance > 1, n: travel.n + 1 });
  }
  const p = cellCentre(cell);
  const moved = travel.n > 0 && !reduce;
  const duration = travel.jump ? 0.5 : 0.28;

  return (
    <motion.g
      initial={false}
      animate={{ x: p.x, y: p.y }}
      transition={reduce ? { duration: 0 } : travel.jump ? { duration, ease: [0.35, 0, 0.2, 1] } : SPRING}
    >
      <motion.ellipse
        key={`shadow-${travel.n}`}
        cx={0}
        cy={1.3}
        rx={4.3}
        ry={2.6}
        fill={shadowFill}
        className="pawn__shadow"
        animate={
          moved
            ? {
                opacity: [0.5, travel.jump ? 0.18 : 0.35, 0.5],
                scale: [1, travel.jump ? 0.7 : 0.9, 1],
              }
            : undefined
        }
        transition={{ duration }}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
      />
      {active || thinking ? (
        <circle
          r={4.6}
          className={`pawn__halo${thinking ? " pawn__halo--thinking" : ""}`}
          style={{ stroke: SIDE_COLOR[side] }}
        />
      ) : null}
      {won ? <circle r={5.2} className="pawn__glow" style={{ fill: SIDE_COLOR[side] }} /> : null}
      <motion.g
        key={`body-${travel.n}`}
        animate={
          moved
            ? travel.jump
              ? { y: [0, -4.6, 0], scale: [1, 1.18, 0.94, 1] }
              : { y: [0, -1.2, 0], scale: [1, 1.05, 0.97, 1] }
            : undefined
        }
        transition={{ duration, ease: "easeOut" }}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
      >
        <circle r={3.9} className="pawn__body" style={{ fill: SIDE_COLOR[side] }} />
        <circle r={3.9} className="pawn__rim" />
        <circle r={2.7} className="pawn__inner" />
        <path
          d="M -1.8 0.95 L 0 -0.95 L 1.8 0.95"
          className="pawn__chevron"
          transform={side === "north" ? "rotate(180)" : undefined}
        />
      </motion.g>
    </motion.g>
  );
}

/** A puff of grit along both long edges of a barricade that just landed. */
function Dust({ wallKeyText }: { wallKeyText: string }) {
  const orientation = wallKeyText[0] === "h" ? "h" : "v";
  const [row, col] = wallKeyText.slice(1).split("-").map(Number);
  const rect = wallRect({ orientation, row: row!, col: col! });
  const specks = Array.from({ length: 12 }, (_, i) => {
    const along = (i % 6) / 5;
    const side = i < 6 ? -1 : 1;
    const cx = orientation === "h" ? rect.x + along * rect.width : rect.x + rect.width / 2;
    const cy = orientation === "h" ? rect.y + rect.height / 2 : rect.y + along * rect.height;
    const spread = 1.8 + ((i * 37) % 10) / 6;
    return {
      cx,
      cy,
      dx: orientation === "h" ? (along - 0.5) * 2.2 : side * spread,
      dy: orientation === "h" ? side * spread : (along - 0.5) * 2.2,
    };
  });
  return (
    <g pointerEvents="none">
      {specks.map((s, i) => (
        <motion.circle
          key={i}
          className="dust"
          initial={{ cx: s.cx, cy: s.cy, r: 0.65, opacity: 0.75 }}
          animate={{ cx: s.cx + s.dx, cy: s.cy + s.dy, r: 0.15, opacity: 0 }}
          transition={{ duration: 0.55, ease: "easeOut", delay: 0.06 }}
        />
      ))}
    </g>
  );
}
