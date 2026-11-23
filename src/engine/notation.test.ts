import { describe, it, expect } from "vitest";
import { actionName, cellName, parseAction, wallName } from "./notation.js";
import { judgeWall } from "./analysis.js";
import { createState } from "./game.js";

describe("notation", () => {
  it("names squares with files from the left and ranks from the bottom", () => {
    expect(cellName({ row: 6, col: 0 }, 7)).toBe("a1");
    expect(cellName({ row: 0, col: 6 }, 7)).toBe("g7");
    expect(cellName({ row: 8, col: 4 }, 9)).toBe("e1");
  });

  it("names barricades after the square below-left of their centre", () => {
    // Between rows 5 and 6 (ranks 2 and 1), covering files c–d.
    expect(wallName({ orientation: "h", row: 5, col: 2 }, 7)).toBe("c1h");
    expect(wallName({ orientation: "v", row: 0, col: 0 }, 7)).toBe("a6v");
  });

  it("round-trips every action through text", () => {
    for (const size of [7, 9]) {
      for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
          const step = { type: "step" as const, row, col };
          expect(parseAction(actionName(step, size), size)).toEqual(step);
          if (row <= size - 2 && col <= size - 2) {
            for (const orientation of ["h", "v"] as const) {
              const wall = { type: "wall" as const, orientation, row, col };
              expect(parseAction(actionName(wall, size), size)).toEqual(wall);
            }
          }
        }
      }
    }
    expect(parseAction("z9", 7)).toBeNull();
    expect(parseAction("a7h", 7)).toBeNull(); // no groove above the top rank
    expect(parseAction("g3h", 7)).toBeNull(); // a barricade can't start on the last file
  });
});

describe("judgeWall", () => {
  it("reports how many steps a barricade adds to each route", () => {
    const state = createState({ size: 7, wallsEach: 6, stones: [] });
    // Across the middle file just above South's start: both racers' straight lines cross it.
    expect(judgeWall(state, "north", { orientation: "h", row: 5, col: 2 })).toEqual({
      legal: true,
      delta: { north: 1, south: 1 },
    });
    // Off to the side, it costs nobody anything.
    expect(judgeWall(state, "north", { orientation: "h", row: 2, col: 0 })).toEqual({
      legal: true,
      delta: { north: 0, south: 0 },
    });
  });

  it("explains why a barricade is refused", () => {
    const state = createState({
      size: 7,
      wallsEach: 6,
      stones: [{ orientation: "h", row: 5, col: 0 }],
    });
    expect(judgeWall(state, "south", { orientation: "h", row: 5, col: 1 })).toEqual({
      legal: false,
      reason: "overlap",
    });
    state.pawns.south = { row: 6, col: 0 };
    expect(judgeWall(state, "north", { orientation: "v", row: 5, col: 1 })).toEqual({
      legal: false,
      reason: "traps",
      trapped: "south",
    });
    state.wallsLeft.north = 0;
    expect(judgeWall(state, "north", { orientation: "h", row: 2, col: 2 })).toEqual({
      legal: false,
      reason: "none-left",
    });
  });
});
