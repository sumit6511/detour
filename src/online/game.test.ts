import { describe, it, expect } from "vitest";
import { createRng } from "../engine/rng.js";
import {
  applyMove,
  cleanName,
  makeCode,
  newGame,
  normaliseCode,
  parseGame,
  rematchGame,
  resignGame,
  sideOf,
  winnerOfGame,
  type OnlineGame,
} from "./game.js";

const alice = { id: "u_alice", name: "Alice" };
const bob = { id: "u_bob", name: "Bob" };

function started(): OnlineGame {
  const game = newGame("ABCDE", { size: 7, roadworks: false, isPublic: false }, alice, 1000, createRng(1));
  const open = game.players.south ? "north" : "south";
  return { ...game, players: { ...game.players, [open]: bob }, status: "playing" };
}

describe("codes and names", () => {
  it("makes typeable codes and normalises what people type", () => {
    const code = makeCode(createRng(3));
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    expect(normaliseCode(" ab-cde ")).toBe("ABCDE");
    expect(normaliseCode("ABC0E")).toBeNull(); // 0 is not in the alphabet
    expect(normaliseCode("ABCD")).toBeNull();
  });

  it("keeps names short and plain", () => {
    expect(cleanName("  <b>Robert'); DROP</b>  ")).toBe("bRobert' DROPb");
    expect(cleanName("A".repeat(40))).toHaveLength(20);
  });
});

describe("game flow", () => {
  it("seats the host on a random side and starts open", () => {
    const game = newGame("ABCDE", { size: 9, roadworks: true, isPublic: true }, alice, 5, createRng(9));
    expect(game.status).toBe("open");
    expect(sideOf(game, "u_alice")).not.toBeNull();
    expect(game.setup.wallsEach).toBe(10);
    expect(game.setup.stones.length).toBeGreaterThan(0);
  });

  it("enforces turns and legality, and finishes on resign", () => {
    let game = started();
    expect(applyMove(game, "north", { type: "step", row: 1, col: 3 }, 2)).toBe("It's not your turn.");
    expect(applyMove(game, "south", { type: "step", row: 4, col: 3 }, 2)).toBe("That move isn't allowed.");
    const moved = applyMove(game, "south", { type: "step", row: 5, col: 3 }, 2);
    expect(typeof moved).toBe("object");
    game = moved as OnlineGame;
    expect(game.moves).toHaveLength(1);
    const over = resignGame(game, "north", 3) as OnlineGame;
    expect(over.status).toBe("finished");
    expect(winnerOfGame(over)).toBe("south");
    expect(applyMove(over, "north", { type: "step", row: 1, col: 3 }, 4)).toBe("This race is over.");
  });

  it("swaps sides for a rematch", () => {
    const game = started();
    const next = rematchGame(game, "FGHJK", 10, createRng(2));
    expect(next.players.south).toEqual(game.players.north);
    expect(next.players.north).toEqual(game.players.south);
    expect(next.status).toBe("playing");
  });
});

describe("parseGame", () => {
  it("round-trips a real game", () => {
    let game = started();
    game = applyMove(game, "south", { type: "step", row: 5, col: 3 }, 2) as OnlineGame;
    game = applyMove(game, "north", { type: "wall", orientation: "h", row: 4, col: 2 }, 3) as OnlineGame;
    expect(parseGame(JSON.parse(JSON.stringify(game)))).toEqual(game);
  });

  it("cuts a history at the first illegal move", () => {
    const game = started();
    const tampered = {
      ...game,
      moves: [
        { side: "south", action: { type: "step", row: 5, col: 3 } },
        { side: "north", action: { type: "step", row: 3, col: 3 } }, // two squares at once
        { side: "south", action: { type: "step", row: 4, col: 3 } },
      ],
    };
    expect(parseGame(tampered)!.moves).toHaveLength(1);
  });

  it("rejects malformed documents and layouts that seal someone in", () => {
    expect(parseGame(null)).toBeNull();
    expect(parseGame({ v: 1, code: "ABCDE", setup: { size: 8, stones: [], seed: 1 } })).toBeNull();
    const sealed = {
      ...started(),
      setup: {
        size: 7,
        roadworks: true,
        seed: 1,
        stones: [
          { orientation: "h", row: 5, col: 2 },
          { orientation: "v", row: 5, col: 1 },
          { orientation: "v", row: 5, col: 3 },
        ],
      },
    };
    expect(parseGame(sealed)).toBeNull();
  });
});
