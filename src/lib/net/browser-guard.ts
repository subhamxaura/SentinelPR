import type { BrowserContext } from "playwright";
import { validatePublicUrl } from "./guard";

const NON_NETWORK_SCHEME = /^(data|blob|about):/i;

function toHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  return url;
}

/** Block browser requests and WebSocket connections to private/reserved targets. */
export async function installBrowserRequestGuard(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (NON_NETWORK_SCHEME.test(requestUrl)) {
      await route.continue().catch(() => undefined);
      return;
    }
    try {
      await validatePublicUrl(requestUrl);
      await route.continue();
    } catch {
      await route.abort("blockedbyclient").catch(() => undefined);
    }
  });

  await context.routeWebSocket(/.*/, async (socket) => {
    try {
      await validatePublicUrl(toHttpUrl(socket.url()));
      socket.connectToServer();
    } catch {
      await socket.close({ code: 1008, reason: "Blocked target" }).catch(() => undefined);
    }
  });
}
