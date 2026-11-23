import { sameCell, wallKey, type Cell, type Wall } from "../../engine/board";
import {
  goalRow,
  legalWalls,
  opponentOf,
  type DetourState,
  type Side,
  type WallOwner,
} from "../../engine/game";
import { replay, sideToMove, winnerOf, type Match } from "../../engine/match";

export type PlacedWall = Wall & { owner: WallOwner };

/** Everything the board draws, derived from a match. Plain data, so it's cheap to memoise. */
export interface BoardView {
  size: number;
  walls: PlacedWall[];
  pawns: Record<Side, Cell>;
  routes: Record<Side, Cell[]>;
  /** Squares the side to move may step to (empty when nobody may act right now). */
  targets: Cell[];
  legalWalls: Set<string>;
  mover: Side;
  winner: Side | null;
  /** The last move, for the fading "came from here" marker and the newest barricade's landing. */
  moveCount: number;
  lastFrom: Cell | null;
  lastSide: Side | null;
  newestWall: string | null;
}

export function viewOfState(state: DetourState, mover: Side, canAct: boolean): BoardView {
  return {
    size: state.size,
    walls: state.grid.walls.map((w) => ({
      ...w,
      owner: state.owners.get(wallKey(w)) ?? "stone",
    })),
    pawns: { south: { ...state.pawns.south }, north: { ...state.pawns.north } },
    routes: {
      south: state.grid.shortestPath(state.pawns.south, goalRow(state.size, "south")),
      north: state.grid.shortestPath(state.pawns.north, goalRow(state.size, "north")),
    },
    targets: canAct ? state.grid.pawnMoves(state.pawns[mover], state.pawns[opponentOf(mover)]) : [],
    legalWalls: canAct ? new Set(legalWalls(state, mover).map(wallKey)) : new Set<string>(),
    mover,
    winner: state.winner,
    moveCount: 0,
    lastFrom: null,
    lastSide: null,
    newestWall: null,
  };
}

/** The view for `match`; `canAct` decides whether move targets are offered. */
export function viewOfMatch(match: Match, canAct: boolean): BoardView {
  const state = replay(match);
  const mover = sideToMove(match);
  const winner = winnerOf(match, state);
  const view = viewOfState(state, mover, canAct && !winner);
  view.winner = winner;
  view.moveCount = match.moves.length;
  const last = match.moves[match.moves.length - 1];
  if (last) {
    view.lastSide = last.side;
    if (last.action.type === "wall") view.newestWall = wallKey(last.action);
    else {
      // Where the pawn stood before its last step: replay one move fewer.
      const before = replay({ ...match, moves: match.moves.slice(0, -1) });
      const from = before.pawns[last.side];
      if (!sameCell(from, state.pawns[last.side])) view.lastFrom = from;
    }
  }
  return view;
}
