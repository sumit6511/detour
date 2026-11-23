import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { setSoundEnabled } from "../audio/sfx";
import { HUMAN, createMatch, isMatch, winnerOf, type Match, type MatchOptions } from "../engine/match";
import { ToastProvider } from "./components/Toasts";
import { Game } from "./screens/Game";
import { HowToPlay } from "./screens/HowToPlay";
import { EMPTY_ENTRY, Menu, recordKey, type RaceRecord } from "./screens/Menu";
import { SettingsDialog } from "./screens/SettingsDialog";
import { DEFAULT_SETTINGS, applyTheme, isSettings, type Settings } from "./settings";
import { load, remove, save } from "./storage";

const KEYS = {
  match: "detour:match",
  options: "detour:options",
  record: "detour:record",
  settings: "detour:settings",
  seenHelp: "detour:seen-help",
};

const DEFAULT_OPTIONS: MatchOptions = {
  size: 7,
  mode: "bot",
  level: "medium",
  roadworks: true,
};

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

/** A saved race the player can pick back up: well-formed and not finished yet. */
const resumable = (match: Match | null) => (match && !winnerOf(match) ? match : null);

export function App() {
  const [settings, setSettings] = useState<Settings>(() => load(KEYS.settings, DEFAULT_SETTINGS, isSettings));
  const [options, setOptions] = useState<MatchOptions>(() => load(KEYS.options, DEFAULT_OPTIONS, isOptions));
  const [match, setMatch] = useState<Match | null>(() => load<Match | null>(KEYS.match, null, isMatch));
  const [record, setRecord] = useState<RaceRecord>(() => load(KEYS.record, {}));
  // Open straight into a race that was left unfinished; otherwise start at the menu.
  const [screen, setScreen] = useState<"menu" | "game">(() => (resumable(match) ? "game" : "menu"));
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => save(KEYS.settings, settings), [settings]);
  useEffect(() => save(KEYS.options, options), [options]);
  useEffect(() => (match ? save(KEYS.match, match) : remove(KEYS.match)), [match]);
  useEffect(() => applyTheme(settings.theme), [settings.theme]);
  useEffect(() => setSoundEnabled(settings.sound), [settings.sound]);

  // Stamp the finish time, and count a finished race against the bot exactly once.
  useEffect(() => {
    if (!match || match.recorded) return;
    const winner = winnerOf(match);
    if (!winner) return;
    if (match.setup.mode === "bot") {
      const key = recordKey(match.setup.level, match.setup.size);
      setRecord((current) => {
        const entry = { ...EMPTY_ENTRY, ...current[key] };
        const won = winner === HUMAN;
        const streak = won ? entry.streak + 1 : 0;
        const next = {
          ...current,
          [key]: {
            wins: entry.wins + (won ? 1 : 0),
            losses: entry.losses + (won ? 0 : 1),
            streak,
            best: Math.max(entry.best, streak),
          },
        };
        save(KEYS.record, next);
        return next;
      });
    }
    setMatch({
      ...match,
      recorded: true,
      finishedAt: match.finishedAt ?? Date.now(),
    });
  }, [match]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [screen]);

  const start = (opts: MatchOptions) => {
    setMatch(
      createMatch({
        size: opts.size,
        mode: opts.mode,
        level: opts.level,
        roadworks: opts.roadworks,
      }),
    );
    setScreen("game");
    if (!load(KEYS.seenHelp, false)) {
      save(KEYS.seenHelp, true);
      setTimeout(() => setHelpOpen(true), 450);
    }
  };

  const patchSettings = useCallback(
    (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })),
    [],
  );
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={screen === "game" && match ? `game-${match.setup.seed}` : "menu"}
            className="screen"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.24, ease: [0.25, 0.8, 0.3, 1] }}
          >
            {screen === "game" && match ? (
              <Game
                match={match}
                settings={settings}
                onSettings={patchSettings}
                onChange={setMatch}
                onRematch={() => start(match.setup)}
                onMenu={() => setScreen("menu")}
                onHelp={() => setHelpOpen(true)}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            ) : (
              <Menu
                options={options}
                onOptions={setOptions}
                onStart={() => start(options)}
                saved={resumable(match)}
                onResume={() => setScreen("game")}
                record={record}
                onHelp={() => setHelpOpen(true)}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            )}
          </motion.div>
        </AnimatePresence>
        <HowToPlay open={helpOpen} onClose={closeHelp} />
        <SettingsDialog
          open={settingsOpen}
          onClose={closeSettings}
          settings={settings}
          onChange={patchSettings}
          onResetRecord={() => {
            setRecord({});
            save(KEYS.record, {});
          }}
        />
      </ToastProvider>
    </MotionConfig>
  );
}
