/// <reference lib="webworker" />
import { botAction, type BotLevel } from "../engine/bot";
import { replay, sideToMove, type Match } from "../engine/match";

export interface BotRequest {
  id: number;
  match: Match;
  level: BotLevel;
  /** Offsets the seed so hints don't simply mirror the bot's own tie-breaks. */
  seedOffset: number;
}

// The bot thinks off the main thread, so a Hard search on the big board never stalls an animation.
self.onmessage = (event: MessageEvent<BotRequest>) => {
  const { id, match, level, seedOffset } = event.data;
  const state = replay(match);
  const side = sideToMove(match);
  const turn = Math.floor(match.moves.length / 2);
  const action = botAction(state, side, level, match.setup.seed + seedOffset, turn);
  (self as unknown as Worker).postMessage({ id, action });
};
