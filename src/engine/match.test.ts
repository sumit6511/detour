import { describe, it, expect } from "vitest";
import { WallGrid, wallKey } from "./board.js";
import { botAction, type BotLevel } from "./bot.js";
import { applyAction, createState, isLegalAction, type DetourAction } from "./game.js";
import { generateStones, rotateWall } from "./generator.js";
import { createRng } from "./rng.js";
import {
  BOT,
  HUMAN,
  createMatch,
  isBotTurn,
  isMatch,
  play,
  playBot,
  replay,
  resign,
  routeLength,
  sideToMove,
  undo,
  wallsUsed,
  winnerOf,
  type Match,
} from "./match.js";

const step = (row: number, col: number): DetourAction => ({ type: "step", row, col });

describe("generateStones", () => {
  it("places mirror-image pairs that never overlap and keep the race fair", () => {
    for (const size of [7, 9]) {
      for (let seed = 0; seed < 40; seed++) {
        const stones = generateStones(createRng(seed), size, 3);
        const keys = new Set(stones.map(wallKey));
        expect(keys.size).toBe(stones.length);
        for (const stone of stones) expect(keys.has(wallKey(rotateWall(stone, size)))).toBe(true);
        const grid = new WallGrid(size);
        for (const stone of stones) {
          expect(grid.fitsGeometrically(stone)).toBe(true);
          grid.place(stone);
        }
        const south = grid.distanceTo({ row: size - 1, col: Math.floor(size / 2) }, 0);
        const north = grid.distanceTo({ row: 0, col: Math.floor(size / 2) }, size - 1);
        expect(south).toBe(north);
        expect(south).toBeLessThanOrEqual(size + 1);
      }
    }
  });
});

describe("createMatch", () => {
  it("is reproducible from its seed and honours the roadworks switch", () => {
    const a = createMatch({ size: 9, mode: "bot", level: "hard", roadworks: true }, 1234);
    const b = createMatch({ size: 9, mode: "bot", level: "hard", roadworks: true }, 1234);
    expect(a).toEqual(b);
    expect(a.setup.wallsEach).toBe(10);
    expect(a.setup.stones.length).toBeGreaterThan(0);
    expect(createMatch({ size: 7, mode: "bot", level: "easy", roadworks: false }, 1234).setup.stones).toEqual([]);
  });
});

describe("play", () => {
  const fresh = () => createMatch({ size: 7, mode: "friend", level: "easy", roadworks: false }, 1);

  it("alternates sides, south first", () => {
    let match = fresh();
    expect(sideToMove(match)).toBe("south");
    match = play(match, step(5, 3))!;
    expect(sideToMove(match)).toBe("north");
    match = play(match, step(1, 3))!;
    expect(sideToMove(match)).toBe("south");
    expect(replay(match).pawns).toEqual({ south: { row: 5, col: 3 }, north: { row: 1, col: 3 } });
  });

  it("refuses illegal moves", () => {
    const match = fresh();
    expect(play(match, step(4, 3))).toBeNull(); // two squares
    expect(play(match, { type: "wall", orientation: "h", row: 6, col: 0 })).toBeNull(); // off the board
  });

  it("refuses a barricade once a side has none left", () => {
    let match = createMatch({ size: 7, mode: "friend", level: "easy", roadworks: false }, 1);
    match = { ...match, setup: { ...match.setup, wallsEach: 1 } };
    match = play(match, { type: "wall", orientation: "h", row: 0, col: 0 })!;
    match = play(match, step(1, 3))!;
    expect(play(match, { type: "wall", orientation: "h", row: 2, col: 4 })).toBeNull();
    expect(wallsUsed(match, "south")).toBe(1);
  });

  it("ends the race when a pawn reaches its goal row, and accepts nothing after", () => {
    // Friend mode on an open 7x7: walk both pawns up and down different files.
    let match = fresh();
    const moves = [step(6, 2), step(0, 4), step(5, 2), step(1, 4), step(4, 2), step(2, 4), step(3, 2), step(3, 4), step(2, 2), step(4, 4), step(1, 2), step(5, 4), step(0, 2)];
    for (const m of moves) {
      const next = play(match, m);
      expect(next).not.toBeNull();
      match = next!;
    }
    expect(winnerOf(match)).toBe("south");
    expect(play(match, step(6, 4))).toBeNull();
    expect(routeLength(replay(match), "north")).toBe(1);
  });
});

describe("against the bot", () => {
  const vsBot = (level: BotLevel = "medium") => createMatch({ size: 7, mode: "bot", level, roadworks: true }, 77);

  it("hands the turn to the bot after each human move", () => {
    let match = play(vsBot(), step(5, 3))!;
    expect(isBotTurn(match)).toBe(true);
    match = playBot(match);
    expect(match.moves).toHaveLength(2);
    expect(match.moves[1]!.side).toBe(BOT);
    expect(isBotTurn(match)).toBe(false);
    expect(playBot(match)).toBe(match); // not its turn: nothing happens
  });

  it("undo takes back the bot's reply and your move together", () => {
    const before = vsBot();
    const after = playBot(play(before, step(5, 3))!);
    expect(undo(after).moves).toEqual([]);
    expect(sideToMove(undo(after))).toBe(HUMAN);
  });

  it("resigning hands the race to the bot and freezes it", () => {
    const match = resign(play(vsBot(), step(5, 3))!, HUMAN);
    expect(winnerOf(match)).toBe(BOT);
    expect(undo(match)).toBe(match);
    expect(play(match, step(4, 3))).toBeNull();
  });

  it("replays a saved race exactly", () => {
    let match: Match = vsBot("hard");
    for (let i = 0; i < 6 && !winnerOf(match); i++) {
      const state = replay(match);
      const human = botAction(state, HUMAN, "easy", 5, i);
      match = playBot(play(match, human)!);
    }
    const restored = JSON.parse(JSON.stringify(match)) as unknown;
    expect(isMatch(restored)).toBe(true);
    expect(replay(restored as Match)).toEqual(replay(match));
  });

  it("rejects malformed saves", () => {
    expect(isMatch(null)).toBe(false);
    expect(isMatch({ setup: { size: 8 }, moves: [] })).toBe(false);
  });
});

describe("bot levels", () => {
  it("always choose legal moves, deterministically, through whole races", () => {
    for (const level of ["easy", "medium", "hard"] as BotLevel[]) {
      for (const size of [7, 9]) {
        const stones = generateStones(createRng(`${level}-${size}`), size, 2);
        const state = createState({ size, wallsEach: size === 9 ? 10 : 6, stones });
        const twin = createState({ size, wallsEach: size === 9 ? 10 : 6, stones });
        for (let turn = 0; turn < 120 && !state.winner; turn++) {
          const side = turn % 2 === 0 ? "south" : "north";
          const action = botAction(state, side, level, 9, turn);
          expect(isLegalAction(state, side, action)).toBe(true);
          expect(botAction(twin, side, level, 9, turn)).toEqual(action);
          applyAction(state, side, action);
          applyAction(twin, side, action);
        }
        expect(state.winner).not.toBeNull();
      }
    }
  });

  it("takes a winning step when one is there", () => {
    const state = createState({ size: 7, wallsEach: 6, stones: [] });
    state.pawns.north = { row: 5, col: 0 };
    for (const level of ["easy", "medium", "hard"] as BotLevel[]) {
      expect(botAction(state, "north", level, 1, 0)).toEqual(step(6, 0));
    }
  });

  it("medium and hard barricade a racer who is about to win", () => {
    const state = createState({ size: 7, wallsEach: 6, stones: [] });
    state.pawns.south = { row: 1, col: 5 };
    expect(botAction(state, "north", "medium", 1, 0).type).toBe("wall");
    expect(botAction(state, "north", "hard", 1, 0).type).toBe("wall");
  });
});
