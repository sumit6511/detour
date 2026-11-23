import { describe, it, expect } from "vitest";
import { formatClock, remainingFrom } from "./clock.js";
import {
  clockRunning,
  clockTimes,
  createMatch,
  flagged,
  pauseClock,
  play,
  resumeClock,
  timeOut,
  undo,
  winnerOf,
  type Match,
} from "./match.js";

const step = (row: number, col: number) => ({ type: "step" as const, row, col });
const timed = (): Match =>
  createMatch({ size: 7, mode: "friend", level: "easy", roadworks: false, clock: "3+2" }, 5);

describe("formatClock", () => {
  it("shows minutes and seconds, and tenths when it gets tight", () => {
    expect(formatClock(180_000)).toBe("3:00");
    expect(formatClock(61_200)).toBe("1:02");
    expect(formatClock(19_950)).toBe("0:19.9");
    expect(formatClock(-500)).toBe("0:00.0");
  });
});

describe("remainingFrom", () => {
  it("adds the increment per move and charges each move's time to its mover", () => {
    const setting = { initialMs: 60_000, incrementMs: 2_000 };
    const times = remainingFrom(
      setting,
      [
        { side: "south", spentMs: 5_000 },
        { side: "north", spentMs: 1_000 },
      ],
      "south",
      3_000,
    );
    expect(times).toEqual({ south: 54_000, north: 61_000 });
  });
});

describe("local race clocks", () => {
  it("doesn't run until the race is on screen, then charges the mover", () => {
    let match = timed();
    expect(clockRunning(match)).toBe(false);
    expect(clockTimes(match, 999_999)).toEqual({ south: 180_000, north: 180_000 });
    match = resumeClock(match, 1_000);
    expect(clockTimes(match, 11_000)).toEqual({ south: 170_000, north: 180_000 });
  });

  it("records each move's time, adds the increment, and hands the clock over", () => {
    let match = resumeClock(timed(), 0);
    match = play(match, step(5, 3), 12_000)!;
    expect(match.moves[0]!.spentMs).toBe(12_000);
    expect(clockTimes(match, 12_000)).toEqual({ south: 170_000, north: 180_000 });
    expect(clockTimes(match, 20_000)).toEqual({ south: 170_000, north: 172_000 });
  });

  it("pauses and resumes without losing or gaining time", () => {
    let match = resumeClock(timed(), 0);
    match = pauseClock(match, 30_000);
    expect(clockTimes(match, 500_000)!.south).toBe(150_000);
    match = resumeClock(match, 500_000);
    expect(clockTimes(match, 510_000)!.south).toBe(140_000);
    match = play(match, step(5, 3), 510_000)!;
    expect(match.moves[0]!.spentMs).toBe(40_000);
  });

  it("flags the mover at zero, refuses late moves, and awards the race", () => {
    let match = resumeClock(timed(), 0);
    expect(flagged(match, 179_999)).toBeNull();
    expect(flagged(match, 180_000)).toBe("south");
    expect(play(match, step(5, 3), 180_500)).toBeNull();
    match = timeOut(match, "south", 180_000);
    expect(winnerOf(match)).toBe("north");
    expect(clockTimes(match, 999_999)).toEqual({ south: 0, north: 180_000 });
    expect(clockRunning(match)).toBe(false);
  });

  it("keeps a paused clock paused when a move comes in", () => {
    const paused = pauseClock(resumeClock(timed(), 0), 5_000);
    const next = play(paused, step(5, 3), 60_000)!;
    expect(next.moves[0]!.spentMs).toBe(5_000);
    expect(clockRunning(next)).toBe(false);
  });

  it("has no undo in timed races", () => {
    const match = play(resumeClock(timed(), 0), step(5, 3), 1_000)!;
    expect(undo(match)).toBe(match);
  });

  it("leaves untimed races alone", () => {
    const match = createMatch({ size: 7, mode: "friend", level: "easy", roadworks: false }, 5);
    expect(clockTimes(match, 1)).toBeNull();
    expect(play(match, step(5, 3), 99)!.moves[0]).toEqual({ side: "south", action: step(5, 3) });
  });
});
