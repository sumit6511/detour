import type { OnlineBackend } from "./backend";
import { ClaudeBackend, type ClaudeRuntime } from "./claude-backend";
import { ServerBackend, serverUrl } from "./server-backend";

export type BackendChoice = { backend: OnlineBackend } | { backend: null; reason: string };

let choice: Promise<BackendChoice> | null = null;

/**
 * Where online games happen for this copy of the game:
 * - inside a Claude artifact viewer: the page's own shared storage (no server needed);
 * - anywhere else: the Detour game server, at VITE_SERVER_URL or this site's own /ws.
 */
export function onlineBackend(): Promise<BackendChoice> {
  choice ??= (async (): Promise<BackendChoice> => {
    const runtime = (window as unknown as { claude?: ClaudeRuntime }).claude;
    if (runtime && typeof runtime.use === "function") {
      const backend = await ClaudeBackend.connect(runtime).catch(() => null);
      if (backend) return { backend };
      return { backend: null, reason: "Sign in to claude.ai to play online on this page." };
    }
    const url = serverUrl();
    if (url) return { backend: new ServerBackend(url) };
    return {
      backend: null,
      reason:
        "This site doesn't have a game server, so online play is off here. You can still race the bot, or a friend on this screen.",
    };
  })();
  return choice;
}
