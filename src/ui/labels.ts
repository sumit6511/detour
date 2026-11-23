import type { BotLevel } from "../engine/bot";
import type { Side } from "../engine/game";
import type { MatchOptions } from "../engine/match";

export const LEVEL_LABEL: Record<BotLevel, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

export const LEVEL_NOTE: Record<BotLevel, string> = {
  easy: "Wanders a little and only barricades in a panic. Good for learning.",
  medium: "Races hard and barricades whenever it falls behind.",
  hard: "Looks a move ahead and saves its barricades for when they hurt.",
};

export function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function raceNames(options: Pick<MatchOptions, "mode">): Record<Side, string> {
  return options.mode === "bot" ? { south: "You", north: "Bot" } : { south: "Orange", north: "Teal" };
}
