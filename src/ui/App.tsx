import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { setSoundEnabled } from "../audio/sfx";
import { isClockPreset } from "../engine/clock";
import { HUMAN, createMatch, isMatch, winnerOf, type Match, type MatchOptions } from "../engine/match";
import { ToastProvider } from "./components/Toasts";
import { Game } from "./screens/Game";
import { HowToPlay } from "./screens/HowToPlay";
import { EMPTY_ENTRY, Menu, onlineRecordKey, recordKey, type RaceRecord } from "./screens/Menu";
import { OnlineScreen } from "./screens/Online";
import { NearbyJoin } from "./screens/NearbyLazy";
import { hadNearbyHost, isNearbyHost } from "../nearby/registry";
import type { OnlineSession } from "../online/backend";
import { onlineBackend } from "../online/select";
import { SettingsDialog } from "./screens/SettingsDialog";
import { DEFAULT_SETTINGS, applyTheme, isSettings, type Settings } from "./settings";
import { load, remove, save } from "./storage";

const KEYS = {
  match: "detour:match",
  options: "detour:options",
  record: "detour:record",
  settings: "detour:settings",
  seenHelp: "detour:seen-help",
  online: "detour:online",
  counted: "detour:online-counted",
};

/** An invite link lands here as #join-abcde. */
function codeFromHash(): string | null {
  try {
    const m = /^#join-([a-z0-9]{5})$/i.exec(location.hash);
    return m ? m[1]!.toUpperCase() : null;
  } catch {
    return null;
  }
}

/** A nearby invite (or a reply meant for the host) lands here as #nearby-<pairing code>. */
function nearbyFromHash(): string | null {
  try {
    const m = /^#nearby-(\S+)$/.exec(location.hash);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

function clearHash() {
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    // Some hosts don't allow it; the hash is harmless.
  }
}

const DEFAULT_OPTIONS: MatchOptions = {
  size: 7,
  mode: "bot",
  level: "medium",
  roadworks: true,
  clock: "off",
};

const isOptions = (v: unknown): boolean => {
  const o = v as Partial<MatchOptions> | null;
  return (
    !!o &&
    (o.size === 7 || o.size === 9) &&
    (o.mode === "bot" || o.mode === "friend" || o.mode === "online" || o.mode === "nearby") &&
    (o.level === "easy" || o.level === "medium" || o.level === "hard") &&
    typeof o.roadworks === "boolean" &&
    (o.clock === undefined || isClockPreset(o.clock))
  );
};

/** Remember an online seat for a reload; nearby guests can't resume that way, so they're skipped. */
function remember(session: OnlineSession) {
  if (session.backend.kind !== "nearby") save(KEYS.online, { code: session.code });
  else if (isNearbyHost(session.backend)) save(KEYS.online, { code: session.code, nearby: true });
  else remove(KEYS.online);
}

/** A saved race the player can pick back up: well-formed and not finished yet. */
const resumable = (match: Match | null) => (match && !winnerOf(match) ? match : null);

export function App() {
  const [settings, setSettings] = useState<Settings>(() => load(KEYS.settings, DEFAULT_SETTINGS, isSettings));
  const [joinCode, setJoinCode] = useState(codeFromHash);
  const [nearbyCode, setNearbyCode] = useState(nearbyFromHash);
  const [options, setOptions] = useState<MatchOptions>(() => {
    const saved = load(KEYS.options, DEFAULT_OPTIONS, isOptions);
    return joinCode ? { ...saved, mode: "online" } : saved;
  });
  const [match, setMatch] = useState<Match | null>(() => load<Match | null>(KEYS.match, null, isMatch));
  const [record, setRecord] = useState<RaceRecord>(() => load(KEYS.record, {}));
  // Open straight into a race that was left unfinished; otherwise start at the menu.
  const [screen, setScreen] = useState<"menu" | "game" | "online" | "nearby">(() =>
    nearbyCode ? "nearby" : resumable(match) && !joinCode ? "game" : "menu",
  );
  const [online, setOnline] = useState<OnlineSession | null>(null);
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

  // An invite link opened in a tab that already has the game: switch to joining it.
  useEffect(() => {
    const onHash = () => {
      const pairing = nearbyFromHash();
      if (pairing) {
        setNearbyCode(pairing);
        setScreen("nearby");
        return;
      }
      const code = codeFromHash();
      if (!code) return;
      setJoinCode(code);
      setOptions((o) => ({ ...o, mode: "online" }));
      setScreen((s) => (s === "online" ? s : "menu"));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Back into an online race that was in progress before a reload. (A nearby race only comes
  // back on the host, whose tab is the referee; a guest pairs again instead.)
  useEffect(() => {
    const saved = load<{ code: string; nearby?: boolean } | null>(KEYS.online, null);
    if (!saved || joinCode || nearbyCode) return;
    let live = true;
    const backend = saved.nearby
      ? hadNearbyHost()
        ? import("../nearby/link").then((m) => m.nearbyHost().backend)
        : Promise.resolve(null)
      : onlineBackend().then((choice) => choice.backend);
    void backend.then(async (backend) => {
      if (!backend) return remove(KEYS.online);
      const session = await backend.resume(saved.code).catch(() => null);
      if (!live || !session) return;
      if (session.game().status === "finished") {
        session.leave();
        remove(KEYS.online);
        return;
      }
      setOnline(session);
      setScreen("online");
    });
    return () => {
      live = false;
    };
    // Only on first load: later changes to the codes are handled where they happen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enterOnline = useCallback((session: OnlineSession) => {
    setOnline(session);
    remember(session);
    setScreen("online");
    setNearbyCode(null);
    clearHash();
  }, []);

  const exitOnline = useCallback(() => {
    setOnline((current) => {
      current?.leave();
      return null;
    });
    remove(KEYS.online);
    setScreen("menu");
  }, []);

  const switchOnline = useCallback((next: OnlineSession) => {
    setOnline((current) => {
      if (current && current !== next) current.leave();
      return next;
    });
    remember(next);
  }, []);

  // Count each finished online race once in the record.
  const finishedOnline = useCallback((code: string, won: boolean, size: 7 | 9) => {
    const counted = load<string[]>(KEYS.counted, []);
    if (counted.includes(code)) return;
    save(KEYS.counted, [...counted.slice(-49), code]);
    const key = onlineRecordKey(size);
    setRecord((current) => {
      const entry = { ...EMPTY_ENTRY, ...current[key] };
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
  }, []);

  const start = (opts: MatchOptions) => {
    setMatch(
      createMatch({
        size: opts.size,
        mode: opts.mode,
        level: opts.level,
        roadworks: opts.roadworks,
        clock: opts.clock ?? "off",
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
            key={
              screen === "online" && online
                ? `online-${online.code}`
                : screen === "nearby" && nearbyCode
                  ? `nearby-${nearbyCode}`
                  : screen === "game" && match
                    ? `game-${match.setup.seed}`
                    : "menu"
            }
            className="screen"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.24, ease: [0.25, 0.8, 0.3, 1] }}
          >
            {screen === "online" && online ? (
              <OnlineScreen
                session={online}
                settings={settings}
                onSettings={patchSettings}
                onHelp={() => setHelpOpen(true)}
                onOpenSettings={() => setSettingsOpen(true)}
                onExit={exitOnline}
                onSwitch={switchOnline}
                onFinished={finishedOnline}
              />
            ) : screen === "nearby" && nearbyCode ? (
              <NearbyJoin
                code={nearbyCode}
                onSeated={enterOnline}
                onCancel={() => {
                  setNearbyCode(null);
                  clearHash();
                  setOptions((o) => ({ ...o, mode: "nearby" }));
                  setScreen("menu");
                }}
              />
            ) : screen === "game" && match ? (
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
                onOnline={enterOnline}
                onNearbyJoin={(code) => {
                  setNearbyCode(code);
                  setScreen("nearby");
                }}
                joinCode={joinCode}
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
