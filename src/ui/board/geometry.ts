import type { Cell, Orientation, Wall } from "../../engine/board";

/** Board geometry in SVG user units: square cells with grooves between them for barricades. */
export const CELL = 10;
export const GAP = 2.6;
export const PITCH = CELL + GAP;
export const PAD = 2.4;
/** Extra margin on the left and bottom edges for the a–g / 1–7 coordinate labels. */
export const LABEL = 4.4;
/** How far from a groove's centre line the pointer still counts as aiming at that groove. */
const GROOVE_REACH = GAP / 2 + 2.1;

export interface Frame {
  size: number;
  span: number;
  minX: number;
  minY: number;
  width: number;
  height: number;
}

export function frameFor(size: number, coords: boolean): Frame {
  const span = size * CELL + (size - 1) * GAP;
  const extra = coords ? LABEL : 0;
  return {
    size,
    span,
    minX: -PAD - extra,
    minY: -PAD,
    width: span + PAD * 2 + extra,
    height: span + PAD * 2 + extra,
  };
}

export const cellCentre = (c: Cell) => ({
  x: c.col * PITCH + CELL / 2,
  y: c.row * PITCH + CELL / 2,
});

/** The barricade's rectangle, drawn slightly inside its groove so neighbours read as separate pieces. */
export function wallRect(wall: Wall) {
  const inset = 0.28;
  if (wall.orientation === "h") {
    return {
      x: wall.col * PITCH - 0.15,
      y: wall.row * PITCH + CELL + inset,
      width: 2 * CELL + GAP + 0.3,
      height: GAP - inset * 2,
    };
  }
  return {
    x: wall.col * PITCH + CELL + inset,
    y: wall.row * PITCH - 0.15,
    width: GAP - inset * 2,
    height: 2 * CELL + GAP + 0.3,
  };
}

export function wallCentre(wall: Wall) {
  return {
    x: wall.col * PITCH + CELL + GAP / 2,
    y: wall.row * PITCH + CELL + GAP / 2,
  };
}

/** Converts a pointer position to board units, using the SVG's on-screen box. */
export function toBoard(frame: Frame, rect: DOMRect, clientX: number, clientY: number) {
  return {
    x: ((clientX - rect.left) / rect.width) * frame.width + frame.minX,
    y: ((clientY - rect.top) / rect.height) * frame.height + frame.minY,
  };
}

/** Board units back to a percentage position inside the SVG box, for HTML overlays. */
export function toPercent(frame: Frame, x: number, y: number) {
  return {
    left: ((x - frame.minX) / frame.width) * 100,
    top: ((y - frame.minY) / frame.height) * 100,
  };
}

export type Pick = { kind: "cell"; cell: Cell } | { kind: "wall"; wall: Wall } | null;

export interface PickOptions {
  /** Squares the mover can step to. Inside one of these, the square always wins over a groove. */
  targets: Cell[];
  /** "auto": squares and grooves both count (mouse). "wall": everything maps to a barricade. */
  mode: "auto" | "step" | "wall";
  /** Breaks the tie when the pointer sits right on a crossing point. */
  orientation: Orientation;
}

/**
 * What the pointer is aiming at. Grooves map to a barricade lying along that groove, centred on
 * the nearest crossing point, so the orientation follows the pointer and no rotate step is
 * needed with a mouse.
 */
export function pick(frame: Frame, x: number, y: number, options: PickOptions): Pick {
  const { size, span } = frame;
  if (x < -GAP || y < -GAP || x > span + GAP || y > span + GAP) return null;

  const col = Math.max(0, Math.min(size - 1, Math.floor(x / PITCH)));
  const row = Math.max(0, Math.min(size - 1, Math.floor(y / PITCH)));
  const insideCell = x - col * PITCH <= CELL && y - row * PITCH <= CELL && x >= 0 && y >= 0;
  const isTarget = options.targets.some((t) => t.row === row && t.col === col);

  if (options.mode !== "wall" && insideCell && isTarget) return { kind: "cell", cell: { row, col } };
  if (options.mode === "step") return insideCell ? { kind: "cell", cell: { row, col } } : null;

  const clamp = (n: number) => Math.max(0, Math.min(size - 2, n));
  const grooveCol = clamp(Math.round((x - CELL - GAP / 2) / PITCH));
  const grooveRow = clamp(Math.round((y - CELL - GAP / 2) / PITCH));
  const toVertical = Math.abs(x - (grooveCol * PITCH + CELL + GAP / 2));
  const toHorizontal = Math.abs(y - (grooveRow * PITCH + CELL + GAP / 2));

  if (options.mode === "auto" && Math.min(toVertical, toHorizontal) > GROOVE_REACH) {
    return insideCell ? { kind: "cell", cell: { row, col } } : null;
  }

  let orientation: Orientation;
  if (Math.abs(toVertical - toHorizontal) < 1.2) orientation = options.orientation;
  else orientation = toHorizontal < toVertical ? "h" : "v";
  return {
    kind: "wall",
    wall: { orientation, row: grooveRow, col: grooveCol },
  };
}
