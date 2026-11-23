import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { wallKey, type Cell, type Orientation, type Wall } from "../engine/board";
import type { Side, WallOwner } from "../engine/game";

export interface BoardView {
  size: number;
  walls: Array<Wall & { owner: WallOwner }>;
  pawns: Record<Side, Cell>;
  routes: Record<Side, Cell[]>;
  /** Squares the side to move may step to (empty when nobody may act). */
  legalSteps: Cell[];
  legalWalls: Set<string>;
  mover: Side;
}

export interface DetourSign {
  id: number;
  side: Side;
  amount: number;
}

interface BoardProps {
  view: BoardView;
  interactive?: boolean;
  mode?: "step" | "wall";
  orientation?: Orientation;
  showRoutes?: boolean;
  newestWall?: string | null;
  sign?: DetourSign | null;
  sideName?: Record<Side, string>;
  onStep?: (cell: Cell) => void;
  onWall?: (wall: Wall) => void;
}

// Board geometry in SVG user units: square cells with grooves between them for walls.
const CELL = 10;
const GAP = 2.6;
const PITCH = CELL + GAP;
const PAD = 2.2;

const centre = (c: Cell) => ({ x: c.col * PITCH + CELL / 2, y: c.row * PITCH + CELL / 2 });

function wallRect(wall: Wall) {
  if (wall.orientation === "h") {
    return { x: wall.col * PITCH - 0.2, y: wall.row * PITCH + CELL + 0.25, width: 2 * CELL + GAP + 0.4, height: GAP - 0.5 };
  }
  return { x: wall.col * PITCH + CELL + 0.25, y: wall.row * PITCH - 0.2, width: GAP - 0.5, height: 2 * CELL + GAP + 0.4 };
}

const SIDE_COLOR: Record<Side, string> = { south: "var(--south)", north: "var(--north)" };

export function Board({
  view,
  interactive = false,
  mode = "step",
  orientation = "h",
  showRoutes = true,
  newestWall = null,
  sign = null,
  sideName = { south: "South", north: "North" },
  onStep,
  onWall,
}: BoardProps) {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Cell | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const { size } = view;
  const span = size * CELL + (size - 1) * GAP;
  const total = span + PAD * 2;
  const wallMode = interactive && mode === "wall";

  useEffect(() => {
    setArmed(null);
    setHover(null);
  }, [view, mode, orientation]);

  const slotAt = (clientX: number, clientY: number): Cell | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * total - PAD;
    const y = ((clientY - rect.top) / rect.height) * total - PAD;
    const clamp = (n: number) => Math.max(0, Math.min(size - 2, n));
    return {
      row: clamp(Math.round((y - CELL - GAP / 2) / PITCH)),
      col: clamp(Math.round((x - CELL - GAP / 2) / PITCH)),
    };
  };

  const preview: Wall | null = wallMode && hover ? { orientation, ...hover } : null;
  const previewLegal = preview ? view.legalWalls.has(wallKey(preview)) : false;

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!wallMode || event.pointerType === "touch") return;
    setHover(slotAt(event.clientX, event.clientY));
  };

  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    if (!wallMode) return;
    const slot = slotAt(event.clientX, event.clientY);
    if (!slot) return;
    const wall: Wall = { orientation, ...slot };
    const key = wallKey(wall);
    // Touch has no hover, so the first tap previews and a second tap on the same slot places.
    if (event.pointerType === "touch" && armed !== key) {
      setHover(slot);
      setArmed(key);
      return;
    }
    if (view.legalWalls.has(key)) onWall?.(wall);
  };

  const cells: Cell[] = [];
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) cells.push({ row, col });
  const points = (route: Cell[]) =>
    route
      .map((c) => {
        const p = centre(c);
        return `${p.x},${p.y}`;
      })
      .join(" ");

  const fillFor = (owner: WallOwner) =>
    owner === "stone" ? "var(--concrete)" : `url(#${uid}-stripes-${owner})`;

  const signAt = sign ? centre(view.pawns[sign.side]) : null;

  return (
    <div className="board-wrap">
      <svg
        ref={svgRef}
        className={`board${wallMode ? " board--walls" : ""}`}
        viewBox={`${-PAD} ${-PAD} ${total} ${total}`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => wallMode && !armed && setHover(null)}
        onPointerUp={onPointerUp}
        role="group"
        aria-label={`Board, ${size} by ${size}. ${sideName.south} at row ${view.pawns.south.row + 1}, column ${
          view.pawns.south.col + 1
        }; ${sideName.north} at row ${view.pawns.north.row + 1}, column ${view.pawns.north.col + 1}.`}
      >
        <defs>
          {(["south", "north"] as Side[]).map((side) => (
            <pattern
              key={side}
              id={`${uid}-stripes-${side}`}
              patternUnits="userSpaceOnUse"
              width="2.6"
              height="2.6"
              patternTransform="rotate(45)"
            >
              <rect width="2.6" height="2.6" style={{ fill: SIDE_COLOR[side] }} />
              <rect width="1.1" height="2.6" style={{ fill: "var(--lane)" }} />
            </pattern>
          ))}
        </defs>

        <rect
          x={-PAD}
          y={-PAD}
          width={total}
          height={total}
          rx={3}
          style={{ fill: "var(--asphalt)" }}
        />

        {cells.map((cell) => {
          const goal =
            cell.row === 0 ? "var(--south-soft)" : cell.row === size - 1 ? "var(--north-soft)" : null;
          return (
            <g key={`c${cell.row}-${cell.col}`}>
              <rect
                x={cell.col * PITCH}
                y={cell.row * PITCH}
                width={CELL}
                height={CELL}
                rx={1.4}
                style={{ fill: "var(--asphalt-cell)" }}
              />
              {goal ? (
                <rect
                  x={cell.col * PITCH}
                  y={cell.row * PITCH}
                  width={CELL}
                  height={CELL}
                  rx={1.4}
                  style={{ fill: goal }}
                />
              ) : null}
            </g>
          );
        })}

        {/* Lane markings on the goal edges: dashed, in the colour of whoever is heading there. */}
        <line
          x1={0}
          x2={span}
          y1={-PAD / 2}
          y2={-PAD / 2}
          strokeWidth={0.6}
          strokeDasharray="2.4 1.6"
          style={{ stroke: "var(--south)" }}
        />
        <line
          x1={0}
          x2={span}
          y1={span + PAD / 2}
          y2={span + PAD / 2}
          strokeWidth={0.6}
          strokeDasharray="2.4 1.6"
          style={{ stroke: "var(--north)" }}
        />

        {showRoutes ? (
          <g fill="none" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none">
            {/* Nudged apart so a stretch both routes share reads as two lanes, not one. */}
            <polyline
              points={points(view.routes.north)}
              transform="translate(0.9 0.9)"
              strokeWidth={1.1}
              strokeDasharray="0.1 2.3"
              style={{ stroke: "var(--north)", opacity: 0.85 }}
            />
            <polyline
              points={points(view.routes.south)}
              transform="translate(-0.9 -0.9)"
              strokeWidth={1.1}
              strokeDasharray="0.1 2.3"
              style={{ stroke: "var(--south)", opacity: 0.95 }}
            />
          </g>
        ) : null}

        {interactive && mode === "step"
          ? view.legalSteps.map((step) => {
              const p = centre(step);
              const activate = () => onStep?.(step);
              return (
                <g
                  key={`s${step.row}-${step.col}`}
                  className="target"
                  role="button"
                  tabIndex={0}
                  aria-label={`Move to row ${step.row + 1}, column ${step.col + 1}`}
                  onClick={activate}
                  onKeyDown={(event: KeyboardEvent) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      activate();
                    }
                  }}
                >
                  <rect
                    x={step.col * PITCH}
                    y={step.row * PITCH}
                    width={CELL}
                    height={CELL}
                    rx={1.4}
                    style={{ fill: "rgba(255,255,255,0.07)" }}
                  />
                  <circle cx={p.x} cy={p.y} r={1.5} style={{ fill: SIDE_COLOR[view.mover] }} />
                </g>
              );
            })
          : null}

        {view.walls.map((wall) => {
          const key = wallKey(wall);
          return (
            <rect
              key={key}
              {...wallRect(wall)}
              rx={0.7}
              className={key === newestWall ? "wall--new" : undefined}
              strokeWidth={wall.owner === "stone" ? 0.35 : 0.3}
              style={{
                fill: fillFor(wall.owner),
                stroke: wall.owner === "stone" ? "var(--concrete-edge)" : "var(--sign-ink)",
              }}
            />
          );
        })}

        {preview ? (
          <rect
            {...wallRect(preview)}
            rx={0.7}
            pointerEvents="none"
            style={{ fill: previewLegal ? "var(--ok)" : "var(--bad)", opacity: previewLegal ? 0.85 : 0.6 }}
          />
        ) : null}

        <g pointerEvents="none">
          {(["north", "south"] as Side[]).map((side) => {
            const p = centre(view.pawns[side]);
            return (
              <g key={side} className="pawn" style={{ transform: `translate(${p.x}px, ${p.y}px)` }}>
                <circle r={3.9} style={{ fill: SIDE_COLOR[side], stroke: "var(--lane)" }} strokeWidth={0.7} />
                {/* A chevron pointing at the edge this racer is heading for. */}
                <path
                  d="M -1.9 1 L 0 -1 L 1.9 1"
                  fill="none"
                  strokeWidth={1}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  transform={side === "north" ? "rotate(180)" : undefined}
                  style={{ stroke: "var(--sign-ink)" }}
                />
              </g>
            );
          })}
        </g>
      </svg>

      {sign && signAt ? (
        <div
          key={sign.id}
          className="detour-pop"
          role="status"
          style={{
            left: `${((signAt.x + PAD) / total) * 100}%`,
            top: `${((signAt.y + PAD) / total) * 100}%`,
            background: SIDE_COLOR[sign.side],
          }}
        >
          DETOUR <span className="num">+{sign.amount}</span>
        </div>
      ) : null}

      {wallMode && armed ? (
        <p className="board-tip">
          {previewLegal ? "Tap the same spot again to place it" : "Can't go there: it overlaps a wall or seals off a route"}
        </p>
      ) : null}
    </div>
  );
}
