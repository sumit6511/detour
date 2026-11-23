import type { Side } from "./game.js";

/** Time controls: a bank of thinking time for the whole race, plus a few seconds back per move. */
export type ClockPreset = "off" | "3+2" | "5+3" | "10+5";

export interface ClockSetting {
  initialMs: number;
  incrementMs: number;
}

export const CLOCK_PRESETS: Record<Exclude<ClockPreset, "off">, ClockSetting> = {
  "3+2": { initialMs: 3 * 60_000, incrementMs: 2_000 },
  "5+3": { initialMs: 5 * 60_000, incrementMs: 3_000 },
  "10+5": { initialMs: 10 * 60_000, incrementMs: 5_000 },
};

export const CLOCK_IDS: ClockPreset[] = ["off", "3+2", "5+3", "10+5"];

export function isClockPreset(value: unknown): value is ClockPreset {
  return typeof value === "string" && (CLOCK_IDS as string[]).includes(value);
}

export function clockSetting(preset: ClockPreset | undefined | null): ClockSetting | null {
  return preset && preset !== "off" ? CLOCK_PRESETS[preset] : null;
}

/** "3:00", "0:42", and tenths in the last 20 seconds ("0:09.4"). Never negative. */
export function formatClock(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 20_000) {
    const tenths = Math.floor(clamped / 100);
    return `0:${String(Math.floor(tenths / 10)).padStart(2, "0")}.${tenths % 10}`;
  }
  const seconds = Math.ceil(clamped / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Each side's remaining time from the moves played so far: the starting bank, plus the
 * increment per move made, minus the time each move took, minus the time already spent on the
 * move in progress (charged to whoever is to move).
 */
export function remainingFrom(
  setting: ClockSetting,
  moves: ReadonlyArray<{ side: Side; spentMs?: number }>,
  mover: Side | null,
  currentElapsedMs: number,
): Record<Side, number> {
  const remaining: Record<Side, number> = { south: setting.initialMs, north: setting.initialMs };
  for (const move of moves) remaining[move.side] += setting.incrementMs - (move.spentMs ?? 0);
  if (mover) remaining[mover] -= currentElapsedMs;
  return remaining;
}
