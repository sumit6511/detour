import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { botAction, type BotLevel } from "../../engine/bot";
import {
  WALLS_FOR_SIZE,
  createMatch,
  play,
  replay,
  sideToMove,
  winnerOf,
  type BoardSize,
  type Match,
  type MatchOptions,
} from "../../engine/match";
import { Board } from "../board/Board";
import { viewOfMatch } from "../board/view";
import { Segmented } from "../components/Controls";
import { DetourArrow, IconHelp, IconPlay, IconSettings } from "../icons";
import { LEVEL_LABEL, LEVEL_NOTE } from "../labels";
import type { ClockPreset } from "../../engine/clock";
import type { OnlineSession } from "../../online/backend";
import { OnlinePanel } from "./OnlinePanel";
import { NearbyPanel } from "./NearbyLazy";

export interface RecordEntry {
  wins: number;
  losses: number;
  streak: number;
  best: number;
}
export type RaceRecord = Record<string, RecordEntry>;
export const recordKey = (level: BotLevel, size: BoardSize) => `${level}-${size}`;
export const onlineRecordKey = (size: BoardSize) => `online-${size}`;
export const EMPTY_ENTRY: RecordEntry = {
  wins: 0,
  losses: 0,
  streak: 0,
  best: 0,
};

interface MenuProps {
  options: MatchOptions;
  onOptions: (options: MatchOptions) => void;
  onStart: () => void;
  saved: Match | null;
  onResume: () => void;
  record: RaceRecord;
  onHelp: () => void;
  onOpenSettings: () => void;
  onOnline: (session: OnlineSession) => void;
  /** Open the nearby join screen with a pasted invite. */
  onNearbyJoin: (code: string) => void;
  joinCode?: string | null;
}

const LEVELS: BotLevel[] = ["easy", "medium", "hard"];
const SIZES: BoardSize[] = [7, 9];

export function Menu({
  options,
  onOptions,
  onStart,
  saved,
  onResume,
  record,
  onHelp,
  onOpenSettings,
  onOnline,
  onNearbyJoin,
  joinCode = null,
}: MenuProps) {
  const set = <K extends keyof MatchOptions>(key: K, value: MatchOptions[K]) =>
    onOptions({ ...options, [key]: value });
  const entries = Object.values(record);
  const wins = entries.reduce((n, r) => n + r.wins, 0);
  const losses = entries.reduce((n, r) => n + r.losses, 0);
  const best = entries.reduce((n, r) => Math.max(n, r.best ?? 0), 0);

  return (
    <main className="menu">
      <header className="bar bar--menu">
        <span />
        <div className="bar__actions">
          <button type="button" className="icon-btn" onClick={onHelp} aria-label="How to play">
            <IconHelp />
          </button>
          <button type="button" className="icon-btn" onClick={onOpenSettings} aria-label="Settings">
            <IconSettings />
          </button>
        </div>
      </header>

      <div className="menu__grid">
        <section className="menu__intro">
          <motion.div
            className="sign"
            role="img"
            aria-label="Detour"
            initial={{ opacity: 0, y: -24, rotate: -10 }}
            animate={{ opacity: 1, y: 0, rotate: -2 }}
            transition={{
              type: "spring",
              stiffness: 260,
              damping: 14,
              delay: 0.05,
            }}
          >
            <span className="sign__word">DETOUR</span>
            <DetourArrow className="sign__arrow" />
          </motion.div>
          <p className="lede">
            Race to the far side of the board. Each turn, take a step or drop a barricade to send your
            opponent the long way round. Just never wall anyone in completely.
          </p>

          {saved ? (
            <motion.section
              className="card resume"
              aria-label="Race in progress"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div>
                <div className="eyebrow">Race in progress</div>
                <div className="resume__what">
                  {saved.setup.mode === "bot" ? `vs Bot · ${LEVEL_LABEL[saved.setup.level]}` : "Two players"}{" "}
                  · {saved.setup.size}×{saved.setup.size} · turn {Math.floor(saved.moves.length / 2) + 1}
                </div>
              </div>
              <button type="button" className="btn btn--go" onClick={onResume}>
                <IconPlay /> Resume
              </button>
            </motion.section>
          ) : null}

          <form
            className="card setup"
            onSubmit={(event) => {
              event.preventDefault();
              if (options.mode === "bot" || options.mode === "friend") onStart();
            }}
          >
            <div className="field">
              <span className="eyebrow">Opponent</span>
              <Segmented
                name="mode"
                label="Opponent"
                value={options.mode}
                onChange={(v) => set("mode", v)}
                choices={[
                  { value: "bot", label: "Bot" },
                  { value: "friend", label: "Friend", note: "same screen" },
                  { value: "online", label: "Online", note: "anyone" },
                  { value: "nearby", label: "Nearby", note: "same Wi-Fi" },
                ]}
              />
            </div>

            {options.mode === "bot" ? (
              <div className="field">
                <span className="eyebrow">Bot level</span>
                <Segmented
                  name="level"
                  label="Bot level"
                  value={options.level}
                  onChange={(v) => set("level", v)}
                  choices={LEVELS.map((level) => ({
                    value: level,
                    label: LEVEL_LABEL[level],
                  }))}
                />
                <p className="hint">{LEVEL_NOTE[options.level]}</p>
              </div>
            ) : null}

            <div className="field">
              <span className="eyebrow">Board</span>
              <Segmented
                name="size"
                label="Board"
                value={options.size}
                onChange={(v) => set("size", v)}
                choices={SIZES.map((size) => ({
                  value: size,
                  label: `${size === 7 ? "Quick" : "Classic"} ${size}×${size}`,
                  note: `${WALLS_FOR_SIZE[size]} barricades each`,
                }))}
              />
            </div>

            <div className="field">
              <span className="eyebrow">Roadworks</span>
              <Segmented
                name="roadworks"
                label="Roadworks"
                value={options.roadworks ? "on" : "off"}
                onChange={(v) => set("roadworks", v === "on")}
                choices={[
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                ]}
              />
              <p className="hint">
                Fixed concrete blocks in mirror-image pairs, so every layout is fair to both racers.
              </p>
            </div>

            <div className="field">
              <span className="eyebrow">Clock</span>
              <Segmented<ClockPreset>
                name="clock"
                label="Clock"
                value={options.clock ?? "off"}
                onChange={(v) => set("clock", v)}
                choices={[
                  { value: "off", label: "Off" },
                  { value: "3+2", label: "3 min", note: "+2s a move" },
                  { value: "5+3", label: "5 min", note: "+3s a move" },
                  { value: "10+5", label: "10 min", note: "+5s a move" },
                ]}
              />
              <p className="hint">
                {(options.clock ?? "off") === "off"
                  ? "No time limit. Take as long as you like."
                  : "Each racer gets this much thinking time for the whole race, plus a little back after every move. Run out and you lose."}
              </p>
            </div>

            {options.mode === "online" ? (
              <OnlinePanel options={options} onOnline={onOnline} initialCode={joinCode} />
            ) : options.mode === "nearby" ? (
              <NearbyPanel options={options} onOnline={onOnline} onJoin={onNearbyJoin} />
            ) : (
              <button type="submit" className="btn btn--go btn--big">
                <IconPlay /> {saved ? "Start a new race" : "Start race"}
              </button>
            )}
          </form>
        </section>

        <aside className="menu__side">
          <figure className="card demo">
            <DemoRace />
            <figcaption>
              <span className="live-dot" aria-hidden="true" /> Live demo: two bots racing
            </figcaption>
          </figure>

          <section className="card record" aria-label="Your record against the bot">
            <div className="record__summary">
              <div>
                <b className="num">{wins}</b>
                <span>Wins</span>
              </div>
              <div>
                <b className="num">{losses}</b>
                <span>Losses</span>
              </div>
              <div>
                <b className="num">
                  {wins + losses ? `${Math.round((100 * wins) / (wins + losses))}%` : "–"}
                </b>
                <span>Win rate</span>
              </div>
              <div>
                <b className="num">{best}</b>
                <span>Best streak</span>
              </div>
            </div>
            <table className="record__table">
              <thead>
                <tr>
                  <th scope="col">Opponent</th>
                  {SIZES.map((size) => (
                    <th scope="col" key={size} className="num-col">
                      {size}×{size}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {LEVELS.map((level) => (
                  <tr key={level}>
                    <th scope="row">{LEVEL_LABEL[level]}</th>
                    {SIZES.map((size) => {
                      const r = record[recordKey(level, size)] ?? EMPTY_ENTRY;
                      return (
                        <td key={size} className="num-col num">
                          {r.wins}–{r.losses}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr>
                  <th scope="row">Online</th>
                  {SIZES.map((size) => {
                    const r = record[onlineRecordKey(size)] ?? EMPTY_ENTRY;
                    return (
                      <td key={size} className="num-col num">
                        {r.wins}–{r.losses}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </section>
        </aside>
      </div>
    </main>
  );
}

/** Two bots racing on a loop: the menu shows the game in motion before anyone has to read a rule. */
function DemoRace() {
  const fresh = () =>
    createMatch(
      { size: 7, mode: "friend", level: "medium", roadworks: true },
      Math.floor(Math.random() * 2 ** 31),
    );
  const [match, setMatch] = useState(fresh);

  useEffect(() => {
    const finished = winnerOf(match);
    const timer = setTimeout(
      () => {
        if (document.hidden) return setMatch({ ...match }); // re-arm the timer, play nothing while hidden
        if (finished) return setMatch(fresh());
        const side = sideToMove(match);
        const turn = Math.floor(match.moves.length / 2);
        // Medium against Easy keeps the demo races varied and readable.
        const level: BotLevel = side === "south" ? "medium" : "easy";
        const action = botAction(
          replay(match),
          side,
          level,
          match.setup.seed + (side === "south" ? 0 : 3),
          turn,
        );
        setMatch(play(match, action) ?? fresh());
      },
      finished ? 2800 : 900,
    );
    return () => clearTimeout(timer);
  }, [match]);

  const view = useMemo(() => viewOfMatch(match, false), [match]);
  return (
    <Board
      view={view}
      showRoutes
      sideName={{ south: "Orange", north: "Teal" }}
      label="A demo race between two bots"
    />
  );
}
