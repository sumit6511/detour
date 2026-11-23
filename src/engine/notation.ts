import type { Cell, Wall } from "./board.js";
import type { DetourAction } from "./game.js";

/**
 * Board coordinates as players read them: files a, b, c… from left to right, ranks 1, 2, 3…
 * counted up from the bottom edge (where the first player starts).
 */
export function fileName(col: number): string {
  return String.fromCharCode(97 + col);
}

export function rankName(row: number, size: number): string {
  return String(size - row);
}

export function cellName(cell: Cell, size: number): string {
  return `${fileName(cell.col)}${rankName(cell.row, size)}`;
}

/**
 * A barricade is named after the square just below-left of its centre point, plus "h" (lying
 * across) or "v" (standing up and down): "c3h" sits between ranks 3 and 4, covering files c–d.
 */
export function wallName(wall: Wall, size: number): string {
  return `${fileName(wall.col)}${rankName(wall.row + 1, size)}${wall.orientation}`;
}

export function actionName(action: DetourAction, size: number): string {
  return action.type === "step" ? cellName(action, size) : wallName(action, size);
}

/** Inverse of actionName, for tests and debugging. Returns null for anything malformed. */
export function parseAction(text: string, size: number): DetourAction | null {
  const match = /^([a-z])(\d{1,2})([hv])?$/.exec(text.trim().toLowerCase());
  if (!match) return null;
  const col = match[1]!.charCodeAt(0) - 97;
  const rank = Number(match[2]);
  if (col < 0 || col >= size || rank < 1 || rank > size) return null;
  const row = size - rank;
  if (!match[3]) return { type: "step", row, col };
  const wallRow = row - 1;
  if (wallRow < 0 || wallRow > size - 2 || col > size - 2) return null;
  return {
    type: "wall",
    orientation: match[3] as "h" | "v",
    row: wallRow,
    col,
  };
}
