import { UNREACHABLE, type Wall } from "./board.js";
import { goalRow, opponentOf, type DetourState, type Side } from "./game.js";

export type WallVerdict =
  | { legal: true; delta: Record<Side, number> }
  | { legal: false; reason: "none-left" | "overlap" | "traps"; trapped?: Side };

/**
 * What a barricade would do if `side` placed it now: either how many steps it adds to each
 * racer's shortest route, or why it isn't allowed. Powers the live "Bot +2" preview and the
 * explanation when a player tries an illegal one.
 */
export function judgeWall(state: DetourState, side: Side, wall: Wall): WallVerdict {
  if (state.wallsLeft[side] <= 0) return { legal: false, reason: "none-left" };
  if (!state.grid.fitsGeometrically(wall)) return { legal: false, reason: "overlap" };
  const sides: Side[] = [side, opponentOf(side)];
  const before = sides.map((s) => state.grid.distanceTo(state.pawns[s], goalRow(state.size, s)));
  state.grid.place(wall);
  const after = sides.map((s) => state.grid.distanceTo(state.pawns[s], goalRow(state.size, s)));
  state.grid.remove(wall);
  const trappedIndex = after.findIndex((d) => d >= UNREACHABLE);
  if (trappedIndex >= 0) return { legal: false, reason: "traps", trapped: sides[trappedIndex]! };
  return {
    legal: true,
    delta: {
      [sides[0]!]: after[0]! - before[0]!,
      [sides[1]!]: after[1]! - before[1]!,
    } as Record<Side, number>,
  };
}
