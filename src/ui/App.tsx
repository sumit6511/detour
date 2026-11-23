import { useEffect, useState } from "react";
import { createMatch, isMatch, winnerOf, HUMAN, type Match, type MatchOptions } from "../engine/match";
import { Game } from "./Game";
import { Menu, recordKey, type RaceRecord } from "./Menu";
import { load, remove, save } from "./storage";

const KEYS = {
  match: "detour:match",
  options: "detour:options",
  record: "detour:record",
  routes: "detour:show-routes",
};

const DEFAULT_OPTIONS: MatchOptions = { size: 7, mode: "bot", level: "medium", roadworks: true };

const isOptions = (v: unknown): boolean => {
  const o = v as Partial<MatchOptions> | null;
  return (
    !!o &&
    (o.size === 7 || o.size === 9) &&
    (o.mode === "bot" || o.mode === "friend") &&
    (o.level === "easy" || o.level === "medium" || o.level === "hard") &&
    typeof o.roadworks === "boolean"
  );
};

const newSeed = () => Math.floor(Math.random() * 2 ** 31);

/** A saved race the player can pick back up: well-formed and not finished yet. */
function resumable(match: Match | null): Match | null {
  return match && !winnerOf(match) ? match : null;
}

type StoredMatch = Match & { recorded?: boolean };

export function App() {
  const [options, setOptions] = useState<MatchOptions>(() => load(KEYS.options, DEFAULT_OPTIONS, isOptions));
  const [match, setMatch] = useState<StoredMatch | null>(() => load<StoredMatch | null>(KEYS.match, null, isMatch));
  const [record, setRecord] = useState<RaceRecord>(() => load(KEYS.record, {}));
  const [showRoutes, setShowRoutes] = useState<boolean>(() => load(KEYS.routes, true));
  const [previewSeed, setPreviewSeed] = useState(newSeed);
  // Open straight into a race that was left unfinished; otherwise start at the menu.
  const [screen, setScreen] = useState<"menu" | "game">(() => (resumable(match) ? "game" : "menu"));

  useEffect(() => save(KEYS.options, options), [options]);
  useEffect(() => save(KEYS.routes, showRoutes), [showRoutes]);
  useEffect(() => (match ? save(KEYS.match, match) : remove(KEYS.match)), [match]);

  // Count a finished race against the bot exactly once, even across reloads.
  useEffect(() => {
    if (!match || match.recorded || match.setup.mode !== "bot") return;
    const winner = winnerOf(match);
    if (!winner) return;
    const key = recordKey(match.setup.level, match.setup.size);
    setRecord((current) => {
      const entry = current[key] ?? { wins: 0, losses: 0 };
      const next = {
        ...current,
        [key]: winner === HUMAN ? { ...entry, wins: entry.wins + 1 } : { ...entry, losses: entry.losses + 1 },
      };
      save(KEYS.record, next);
      return next;
    });
    setMatch({ ...match, recorded: true });
  }, [match]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [screen]);

  const start = (opts: MatchOptions, seed: number) => {
    setMatch(createMatch(opts, seed));
    setPreviewSeed(newSeed());
    setScreen("game");
  };

  if (screen === "game" && match) {
    return (
      <Game
        match={match}
        showRoutes={showRoutes}
        onToggleRoutes={() => setShowRoutes((s) => !s)}
        onChange={(next) => setMatch({ ...next, recorded: false })}
        onRematch={() => start(match.setup, newSeed())}
        onMenu={() => setScreen("menu")}
      />
    );
  }

  return (
    <Menu
      options={options}
      onOptions={setOptions}
      previewSeed={previewSeed}
      onShuffle={() => setPreviewSeed(newSeed())}
      onStart={() => start(options, previewSeed)}
      saved={resumable(match)}
      onResume={() => setScreen("game")}
      record={record}
    />
  );
}
