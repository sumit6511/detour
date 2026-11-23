import { useMemo } from "react";
import { createState, type Side } from "../../engine/game";
import type { Wall } from "../../engine/board";
import { Board } from "../board/Board";
import { viewOfState } from "../board/view";
import { Modal } from "../components/Modal";

interface Diagram {
  title: string;
  text: string;
  south: { row: number; col: number };
  north: { row: number; col: number };
  walls?: Array<Wall & { owner: Side | "stone" }>;
  mover?: Side;
  targets?: boolean;
  bad?: Wall;
}

const DIAGRAMS: Diagram[] = [
  {
    title: "Race to the far side",
    text: "You start at the bottom and race to any square on the top row. Your opponent races the other way. The bottom racer moves first.",
    south: { row: 4, col: 2 },
    north: { row: 0, col: 2 },
  },
  {
    title: "Step, or drop a barricade",
    text: "Each turn, do one thing: step one square (no diagonals), or place a barricade. Barricades are two squares long and block everyone.",
    south: { row: 3, col: 2 },
    north: { row: 1, col: 3 },
    walls: [{ orientation: "h", row: 2, col: 3, owner: "south" }],
    targets: true,
  },
  {
    title: "Jump face to face",
    text: "Next to the other racer? Jump straight over. If a barricade or the edge is right behind them, hop diagonally instead.",
    south: { row: 3, col: 2 },
    north: { row: 2, col: 2 },
    targets: true,
  },
  {
    title: "Never wall anyone in",
    text: "Barricades can't overlap or cross, and every racer must always have a way through. A barricade that seals someone in is refused.",
    south: { row: 4, col: 0 },
    north: { row: 0, col: 4 },
    walls: [{ orientation: "h", row: 3, col: 0, owner: "north" }],
    bad: { orientation: "v", row: 3, col: 1 },
  },
];

function DiagramBoard({ d }: { d: Diagram }) {
  const view = useMemo(() => {
    const state = createState({ size: 5, wallsEach: 3, stones: [] });
    state.pawns = { south: d.south, north: d.north };
    for (const w of d.walls ?? []) {
      state.grid.place(w);
      state.owners.set(`${w.orientation}${w.row}-${w.col}`, w.owner);
    }
    return viewOfState(state, d.mover ?? "south", !!d.targets);
  }, [d]);
  return (
    <Board
      view={view}
      illustrateTargets={!!d.targets}
      armed={d.bad ?? null}
      showRoutes={!d.targets}
      label={d.title}
    />
  );
}

export function HowToPlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="How to play"
      size="lg"
      footer={
        <button type="button" className="btn btn--go" onClick={onClose} data-autofocus>
          Got it
        </button>
      }
    >
      <ol className="rules-grid">
        {DIAGRAMS.map((d, i) => (
          <li key={d.title} className="rule">
            <div className="rule__board">
              <DiagramBoard d={d} />
            </div>
            <div>
              <h3>
                <span className="rule__n num">{i + 1}</span>
                {d.title}
              </h3>
              <p>{d.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="keys">
        <h3>Controls</h3>
        <dl>
          <div>
            <dt>Mouse</dt>
            <dd>
              Click a highlighted square to move. Point at a groove between squares to aim a barricade, click
              to place.
            </dd>
          </div>
          <div>
            <dt>Touch</dt>
            <dd>
              Tap a highlighted square to move. Switch to Barricade, tap or drag to aim, then press Place.
            </dd>
          </div>
          <div>
            <dt>Keyboard</dt>
            <dd>
              <kbd>←</kbd> <kbd>↑</kbd> <kbd>→</kbd> <kbd>↓</kbd> step · <kbd>W</kbd> barricade mode · arrows
              aim · <kbd>R</kbd> rotate · <kbd>Enter</kbd> place · <kbd>U</kbd> undo · <kbd>H</kbd> hint
            </dd>
          </div>
        </dl>
      </div>
    </Modal>
  );
}
