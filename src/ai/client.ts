import { botAction, type BotLevel } from "../engine/bot";
import type { DetourAction } from "../engine/game";
import { replay, sideToMove, type Match } from "../engine/match";
import BotWorker from "./bot.worker.ts?worker&inline";

let worker: Worker | null | undefined;
let nextId = 1;

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new BotWorker();
    worker.addEventListener("error", () => {
      worker?.terminate();
      worker = null;
    });
  } catch {
    worker = null; // Workers refused here: think on the main thread instead.
  }
  return worker;
}

function computeHere(match: Match, level: BotLevel, seedOffset: number): DetourAction {
  const state = replay(match);
  const turn = Math.floor(match.moves.length / 2);
  return botAction(state, sideToMove(match), level, match.setup.seed + seedOffset, turn);
}

/**
 * Asks the bot for a move for whoever is to move in `match`. Runs in a Web Worker when one is
 * available, and falls back to the main thread if the worker fails or takes too long.
 */
export function think(match: Match, level: BotLevel, seedOffset = 0): Promise<DetourAction> {
  const w = getWorker();
  if (!w)
    return new Promise((resolve) => setTimeout(() => resolve(computeHere(match, level, seedOffset)), 0));
  const id = nextId++;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      w.removeEventListener("message", onMessage);
      resolve(computeHere(match, level, seedOffset));
    }, 5000);
    function onMessage(event: MessageEvent<{ id: number; action: DetourAction }>) {
      if (event.data.id !== id) return;
      clearTimeout(timeout);
      w!.removeEventListener("message", onMessage);
      resolve(event.data.action);
    }
    w.addEventListener("message", onMessage);
    w.postMessage({ id, match, level, seedOffset });
  });
}
