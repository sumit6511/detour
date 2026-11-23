import { describe, it, expect } from "vitest";
import { CELL, GAP, PITCH, cellCentre, frameFor, pick, toBoard, wallCentre } from "./geometry";

const frame = frameFor(7, true);
const auto = { targets: [], mode: "auto" as const, orientation: "h" as const };

describe("pick", () => {
  it("reads the middle of a square as that square", () => {
    const c = cellCentre({ row: 3, col: 2 });
    expect(pick(frame, c.x, c.y, auto)).toEqual({
      kind: "cell",
      cell: { row: 3, col: 2 },
    });
  });

  it("reads a horizontal groove as a barricade lying across, centred on the nearest crossing", () => {
    // Just right of the crossing between columns 2/3, in the groove between rows 4/5.
    const x = 2 * PITCH + CELL + GAP / 2 + 3;
    const y = 4 * PITCH + CELL + GAP / 2;
    expect(pick(frame, x, y, auto)).toEqual({
      kind: "wall",
      wall: { orientation: "h", row: 4, col: 2 },
    });
  });

  it("reads a vertical groove as a barricade standing up and down", () => {
    // In the groove between columns 1/2, near the top of row 2: nearest crossing is row 1's.
    const x = 1 * PITCH + CELL + GAP / 2;
    const y = 2 * PITCH + 2;
    expect(pick(frame, x, y, auto)).toEqual({
      kind: "wall",
      wall: { orientation: "v", row: 1, col: 1 },
    });
  });

  it("uses the orientation hint right on a crossing point", () => {
    const c = wallCentre({ orientation: "h", row: 2, col: 2 });
    expect(pick(frame, c.x, c.y, { ...auto, orientation: "v" })).toEqual({
      kind: "wall",
      wall: { orientation: "v", row: 2, col: 2 },
    });
  });

  it("gives a reachable square priority over the groove at its edge", () => {
    const edgeOfTarget = { x: 3 * PITCH + 0.5, y: 5 * PITCH + CELL / 2 };
    expect(pick(frame, edgeOfTarget.x, edgeOfTarget.y, auto)?.kind).toBe("wall");
    expect(
      pick(frame, edgeOfTarget.x, edgeOfTarget.y, {
        ...auto,
        targets: [{ row: 5, col: 3 }],
      }),
    ).toEqual({
      kind: "cell",
      cell: { row: 5, col: 3 },
    });
  });

  it("maps everything to a barricade in wall mode, and ignores grooves in step mode", () => {
    const c = cellCentre({ row: 3, col: 3 });
    expect(pick(frame, c.x, c.y, { ...auto, mode: "wall" })?.kind).toBe("wall");
    const groove = { x: 2 * PITCH + CELL + GAP / 2, y: 3 * PITCH + CELL / 2 };
    expect(pick(frame, groove.x, groove.y, { ...auto, mode: "step" })).toBeNull();
  });

  it("ignores the pointer well outside the board", () => {
    expect(pick(frame, -10, 20, auto)).toBeNull();
  });
});

describe("toBoard", () => {
  it("maps the SVG box corners onto the view box", () => {
    const rect = { left: 100, top: 50, width: 400, height: 400 } as DOMRect;
    expect(toBoard(frame, rect, 100, 50)).toEqual({
      x: frame.minX,
      y: frame.minY,
    });
    const far = toBoard(frame, rect, 500, 450);
    expect(far.x).toBeCloseTo(frame.minX + frame.width);
    expect(far.y).toBeCloseTo(frame.minY + frame.height);
  });
});
