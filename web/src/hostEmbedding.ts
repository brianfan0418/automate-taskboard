import { postEmbeddedHostMessage } from "./embeddedHost.mjs";

/*
 * E1/E2: the board embedded in the Codex App runs inside a sandboxed iframe whose document was written
 * with Page.setDocumentContent. There `window.location` is about:blank (empty hostname) and the frame
 * has no allow-top-navigation, so the embed state and the page address come from document.baseURI
 * (the injector inserts <base href="http://127.0.0.1:<port>/<token>/?host=codex">).
 */

const EMBEDDING_HOSTS = new Set(["codex", "deepseek-harness"]);

function baseUrl(baseUri: string): URL | null {
  try {
    return new URL(baseUri);
  } catch {
    return null;
  }
}

/** Same rule as App: `?host=codex|deepseek-harness` on the base URI and a real parent frame. */
export function isEmbeddedHostFrame(
  baseUri: string = document.baseURI,
  frame: Pick<Window, "parent"> = window,
): boolean {
  const host = baseUrl(baseUri)?.searchParams.get("host") ?? null;
  return host !== null && EMBEDDING_HOSTS.has(host) && frame.parent !== frame;
}

/** Hostname the board is served from; the base URI wins because an embedded frame's location is about:blank. */
export function taskboardPageHostname(
  baseUri: string = document.baseURI,
  locationHostname: string = window.location.hostname,
): string {
  return baseUrl(baseUri)?.hostname || locationHostname;
}

export type RunAppOpenResult = "host-bridge" | "navigated" | "unsupported-embedded";

export interface RunAppOpenOptions {
  embedded?: boolean;
  postHostMessage?: (message: Record<string, unknown>) => void;
  assign?: (url: string) => void;
}

/**
 * Open a run's app link (codex://threads/<id> or claude://…).
 * Embedded: Codex threads go through the host bridge (`taskboard:open-thread`, like App's legacy local
 * thread link); other schemes have no bridge, and navigating the sandboxed frame would blank the board,
 * so nothing is opened and the caller shows a hint. Standalone: navigate so the OS hands off the scheme.
 */
export function openRunAppUrl(url: string, options: RunAppOpenOptions = {}): RunAppOpenResult {
  const embedded = options.embedded ?? isEmbeddedHostFrame();
  if (embedded) {
    const codexThread = /^codex:\/\/threads\/([^/?#]+)/.exec(url);
    if (!codexThread) return "unsupported-embedded";
    (options.postHostMessage ?? postEmbeddedHostMessage)({
      type: "taskboard:open-thread",
      payload: { threadId: decodeURIComponent(codexThread[1]), legacyLocal: true },
    });
    return "host-bridge";
  }
  (options.assign ?? ((target: string) => window.location.assign(target)))(url);
  return "navigated";
}

export const RUN_APP_LINK_EMBEDDED_TEXT = [
  "看板嵌在 Codex App 裡時無法直接開啟這個連結，請改用「複製對話編號」。",
  "This link can't be opened while the board is embedded in the Codex App. Use Copy conversation ID instead.",
] as const;
