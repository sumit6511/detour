import { useMemo } from "react";
import { wallKey } from "../engine/board";
import type { BotLevel } from "../engine/bot";
import { goalRow } from "../engine/game";
import { WALLS_FOR_SIZE, createMatch, replay, type BoardSize, type Match, type MatchOptions } from "../engine/match";
import { Board, type BoardView } from "./Board";
import { LEVEL_LABEL } from "./Game";
import { DetourArrow, IconShuffle } from "./icons";

export interface RecordEntry {
  wins: number;
  losses: number;
}
export type RaceRecord = Record<string, RecordEntry>;

export const recordKey = (level: BotLevel, size: BoardSize) => `${level}-${size}`;

interface MenuProps {
  options: MatchOptions;
  onOptions: (options: MatchOptions) => void;
  previewSeed: number;
  onShuffle: () => void;
  onStart: () => void;
  saved: Match | null;
  onResume: () => void;
  record: RaceRecord;
}

const LEVEL_NOTES: Record<BotLevel, string> = {
  easy: "Wanders a bit and only barricades in a panic.",
  medium: "Races hard and barricades whenever it falls behind.",
  hard: "Looks a move ahead and saves barricades for when they hurt.",
};

export function Menu({ options, onOptions, previewSeed, onShuffle, onStart, saved, onResume, record }: MenuProps) {
  const preview: BoardView = useMemo(() => {
    const state = replay(createMatch(options, previewSeed));
    return {
      size: state.size,
      walls: state.grid.walls.map((w) => ({ ...w, owner: state.owners.get(wallKey(w)) ?? "stone" })),
      pawns: state.pawns,
      routes: {
        south: state.grid.shortestPath(state.pawns.south, goalRow(state.size, "south")),
        north: state.grid.shortestPath(state.pawns.north, goalRow(state.size, "north")),
      },
      legalSteps: [],
      legalWalls: new Set<string>(),
      mover: "south",
    };
  }, [options, previewSeed]);

  const set = <K extends keyof MatchOptions>(key: K, value: MatchOptions[K]) => onOptions({ ...options, [key]: value });
  const played = Object.values(record).some((r) => r.wins + r.losses > 0);
  const savedLabel = saved
    ? `${saved.setup.mode === "bot" ? `vs bot (${LEVEL_LABEL[saved.setup.level]})` : "2 players"}, ${saved.setup.size}×${
        saved.setup.size
      }, turn ${Math.floor(saved.moves.length / 2) + 1}`
    : "";

  return (
    <main className="app app--wide">
      <section className="hero">
        <div className="sign" role="img" aria-label="Detour">
          <span className="sign__word">DETOUR</span>
          <DetourArrow className="sign__arrow" />
        </div>
        <p className="lede">
          Race your pawn to the far side of the board. On each turn, take a step or drop a barricade to send your opponent
          the long way round. Just don't wall anyone in completely.
        </p>
      </section>

      {saved ? (
        <section className="panel resume" aria-label="Race in progress">
          <div>
            <div className="eyebrow">Race in progress</div>
            <div>{savedLabel}</div>
          </div>
          <button type="button" className="btn btn--go" onClick={onResume}>
            Resume
          </button>
        </section>
      ) : null}

      <div className="menu-grid">
        <form
          className="panel setup setup-form"
          onSubmit={(event) => {
            event.preventDefault();
            onStart();
          }}
        >
          <fieldset className="field">
            <legend className="eyebrow">Opponent</legend>
            <div className="segmented">
              <label>
                <input
                  type="radio"
                  name="mode"
                  id="mode-bot"
                  checked={options.mode === "bot"}
                  onChange={() => set("mode", "bot")}
                />
                <span>Bot</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="mode"
                  id="mode-friend"
                  checked={options.mode === "friend"}
                  onChange={() => set("mode", "friend")}
                />
                <span>Friend, same screen</span>
              </label>
            </div>
          </fieldset>

          {options.mode === "bot" ? (
            <fieldset className="field">
              <legend className="eyebrow">Bot level</legend>
              <div className="segmented">
                {(["easy", "medium", "hard"] as BotLevel[]).map((level) => (
                  <label key={level}>
                    <input
                      type="radio"
                      name="level"
                      id={`level-${level}`}
                      checked={options.level === level}
                      onChange={() => set("level", level)}
                    />
                    <span>{LEVEL_LABEL[level]}</span>
                  </label>
                ))}
              </div>
              <p className="hint">{LEVEL_NOTES[options.level]}</p>
            </fieldset>
          ) : null}

          <fieldset className="field">
            <legend className="eyebrow">Board</legend>
            <div className="segmented">
              {([7, 9] as BoardSize[]).map((size) => (
                <label key={size}>
                  <input
                    type="radio"
                    name="size"
                    id={`size-${size}`}
                    checked={options.size === size}
                    onChange={() => set("size", size)}
                  />
                  <span>
                    {size === 7 ? "Quick" : "Classic"} {size}×{size}
                    <small>{WALLS_FOR_SIZE[size]} barricades each</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="field">
            <legend className="eyebrow">Roadworks</legend>
            <div className="segmented">
              <label>
                <input
                  type="radio"
                  name="roadworks"
                  id="roadworks-on"
                  checked={options.roadworks}
                  onChange={() => set("roadworks", true)}
                />
                <span>On</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="roadworks"
                  id="roadworks-off"
                  checked={!options.roadworks}
                  onChange={() => set("roadworks", false)}
                />
                <span>Off</span>
              </label>
            </div>
            <p className="hint">Fixed concrete blocks scattered in mirror-image pairs, so every layout is fair.</p>
          </fieldset>

          <div className="row">
            <button type="submit" className="btn btn--go">
              {saved ? "Start a new race" : "Start race"}
            </button>
          </div>
        </form>

        <section className="panel preview" aria-label="Board preview">
          <div className="row row--between">
            <span className="eyebrow">Your starting board</span>
            {options.roadworks ? (
              <button type="button" className="btn btn--quiet" onClick={onShuffle}>
                <IconShuffle /> New layout
              </button>
            ) : null}
          </div>
          <div className="preview__board">
            <Board
              view={preview}
              showRoutes={false}
              sideName={options.mode === "bot" ? { south: "You", north: "Bot" } : { south: "Orange", north: "Teal" }}
            />
          </div>
          <p className="hint" style={{ textAlign: "center" }}>
            {options.mode === "bot" ? "You start at the bottom (orange) and head for the top." : "Orange starts at the bottom and moves first."}
          </p>
        </section>

        <section className="panel setup record-panel" aria-label="Your record against the bot">
          <span className="eyebrow">Your record vs the bot</span>
          {played ? (
            <table className="record">
              <thead>
                <tr>
                  <th>Level</th>
                  <th className="num">Quick 7×7</th>
                  <th className="num">Classic 9×9</th>
                </tr>
              </thead>
              <tbody>
                {(["easy", "medium", "hard"] as BotLevel[]).map((level) => (
                  <tr key={level}>
                    <td>{LEVEL_LABEL[level]}</td>
                    {([7, 9] as BoardSize[]).map((size) => {
                      const r = record[recordKey(level, size)] ?? { wins: 0, losses: 0 };
                      return (
                        <td key={size} className="num">
                          {r.wins}W – {r.losses}L
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="hint">Wins and losses against each bot level show up here after your first race.</p>
          )}
        </section>
      </div>
    </main>
  );
}
