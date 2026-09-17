// CONTRACTS Amendment 13 (W12-C): pure helpers for the phone pairing guide and home-screen web app.
// No React here, so every rule can be unit tested with plain strings.
import { isEmbeddedHostFrame, taskboardPageHostname } from "./hostEmbedding";

/** Official Tailscale store pages (verified 2026-09-17). */
export const TAILSCALE_APP_STORE_URL = "https://apps.apple.com/app/tailscale/id1470499037";
export const TAILSCALE_GOOGLE_PLAY_URL = "https://play.google.com/store/apps/details?id=com.tailscale.ipn";
export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";

/** Query parameter carrying the single-use home-screen handoff token. */
export const HANDOFF_QUERY_KEY = "handoff";
/** LINE opens links carrying this parameter in the phone's default browser. */
export const OPEN_EXTERNAL_BROWSER_KEY = "openExternalBrowser";

/** Per-device (browser localStorage) flags; phones have no desktop storage of their own before pairing. */
export const PHONE_STORAGE_KEYS = Object.freeze({
  homeScreenSkipped: "automate.phone.homeScreen.skipped.v1",
  homeScreenHintDismissed: "automate.phone.homeScreen.hintDismissed.v1",
  tipsDone: "automate.phone.tips.done.v1",
});
/** Desktop (taskboardStorage) flag: the phone-setup wizard was dismissed with 「稍後」 or finished. */
export const PHONE_WIZARD_DISMISSED_KEY = "automate.phoneWizard.dismissed.v1";

export type InAppBrowser = "line" | "facebook" | "instagram" | null;

/** LINE (`Line/`), Facebook (`FBAN`/`FBAV` iOS, `FB_IAB` Android) and Instagram in-app browsers. */
export function detectInAppBrowser(userAgent: string): InAppBrowser {
  const ua = String(userAgent ?? "");
  if (/\bLine\//.test(ua)) return "line";
  if (/Instagram/.test(ua)) return "instagram";
  if (/FBAN|FBAV|FB_IAB/.test(ua)) return "facebook";
  return null;
}

export type PhonePlatform = "ios" | "android" | "other";

export function detectPhonePlatform(userAgent: string, maxTouchPoints = 0): PhonePlatform {
  const ua = String(userAgent ?? "");
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  // iPadOS Safari asks for the desktop site by default and reports a Mac UA; touch points give it away.
  if (/Macintosh/.test(ua) && maxTouchPoints > 1) return "ios";
  if (/Android/.test(ua)) return "android";
  return "other";
}

/** iOS major version from `OS 18_5 like Mac OS X`, or Safari's `Version/26.0` (Safari 26 freezes the OS number). */
export function iosMajorVersion(userAgent: string): number | null {
  const ua = String(userAgent ?? "");
  const os = /OS (\d+)[_.]\d+/.exec(ua);
  const safari = /Version\/(\d+)/.exec(ua);
  const values = [os?.[1], safari?.[1]].map((value) => (value ? Number(value) : NaN)).filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

export type HomeScreenGuideKind =
  | "ios-safari"
  | "ios-safari-26"
  | "ios-other-browser"
  | "android-chrome"
  | "android-other"
  | "unknown";

/** Where the arrow points: the browser button the first step talks about. */
export type GuideArrow = "bottom-center" | "bottom-right" | "top-right" | "none";

export interface HomeScreenGuide {
  kind: HomeScreenGuideKind;
  arrow: GuideArrow;
  /** `[zh-TW, en]` step texts. */
  steps: Array<readonly [string, string]>;
  icon: "share" | "more-horizontal" | "more-vertical" | "none";
}

export function homeScreenGuideKind(userAgent: string, maxTouchPoints = 0): HomeScreenGuideKind {
  const ua = String(userAgent ?? "");
  const platform = detectPhonePlatform(ua, maxTouchPoints);
  if (platform === "ios") {
    if (/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|DuckDuckGo/.test(ua)) return "ios-other-browser";
    return (iosMajorVersion(ua) ?? 0) >= 26 ? "ios-safari-26" : "ios-safari";
  }
  if (platform === "android") {
    const otherBrowser = /SamsungBrowser|EdgA|OPR\/|Firefox|UCBrowser|MiuiBrowser|HeyTapBrowser|YaBrowser|; wv\)/.test(ua);
    return /Chrome\//.test(ua) && !otherBrowser ? "android-chrome" : "android-other";
  }
  return "unknown";
}

export function homeScreenGuide(userAgent: string, maxTouchPoints = 0): HomeScreenGuide {
  const kind = homeScreenGuideKind(userAgent, maxTouchPoints);
  const iPad = /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  switch (kind) {
    case "ios-safari":
      return {
        kind,
        arrow: iPad ? "top-right" : "bottom-center",
        icon: "share",
        steps: [
          [iPad ? "點右上角的「分享」按鈕（方框加向上箭頭）" : "點下方工具列中間的「分享」按鈕（方框加向上箭頭）", "Tap the Share button (square with an up arrow)"],
          ["往下滑，點「加入主畫面」", "Scroll down and tap “Add to Home Screen”"],
          ["點右上角的「加入」", "Tap “Add” in the top-right corner"],
        ],
      };
    case "ios-safari-26":
      return {
        kind,
        arrow: iPad ? "top-right" : "bottom-right",
        icon: "more-horizontal",
        steps: [
          ["點網址列右邊的「⋯」按鈕，再點「分享」", "Tap the “⋯” button next to the address bar, then “Share”"],
          ["往下找，點「加入主畫面」", "Scroll down and tap “Add to Home Screen”"],
          ["確認「以 Web App 開啟」是開啟的，再點「加入」", "Make sure “Open as Web App” is on, then tap “Add”"],
        ],
      };
    case "ios-other-browser":
      return {
        kind,
        arrow: "top-right",
        icon: "share",
        steps: [
          ["點網址列右側的「分享」按鈕", "Tap the Share button at the right of the address bar"],
          ["點「加入主畫面」", "Tap “Add to Home Screen”"],
          ["點「加入」。找不到的話，請改用 Safari 開啟這個網址", "Tap “Add”. If it is missing, open this address in Safari instead"],
        ],
      };
    case "android-chrome":
      return {
        kind,
        arrow: "top-right",
        icon: "more-vertical",
        steps: [
          ["點右上角的「⋮」選單", "Tap the “⋮” menu in the top-right corner"],
          ["點「加到主畫面」", "Tap “Add to Home screen”"],
          ["點「安裝」或「新增」", "Tap “Install” or “Add”"],
        ],
      };
    case "android-other":
      return {
        kind,
        arrow: "top-right",
        icon: "more-vertical",
        steps: [
          ["打開瀏覽器選單（通常在右上角或右下角）", "Open the browser menu (usually top-right or bottom-right)"],
          ["找「加到主畫面」並點它", "Find “Add to Home screen” and tap it"],
          ["找不到的話，請改用 Chrome 開啟這個網址", "If it is missing, open this address in Chrome instead"],
        ],
      };
    default:
      return {
        kind,
        arrow: "none",
        icon: "none",
        steps: [
          ["在瀏覽器選單或分享選單中找「加入主畫面」", "Find “Add to Home Screen” in the browser or share menu"],
        ],
      };
  }
}

/** True when running as a home-screen web app (display-mode standalone, or iOS `navigator.standalone`). */
export function isStandaloneDisplay(win: Window = window): boolean {
  try {
    if (win.matchMedia?.("(display-mode: standalone)").matches) return true;
    if (win.matchMedia?.("(display-mode: fullscreen)").matches) return true;
  } catch {
    // Old engines without display-mode support.
  }
  return (win.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** `?handoff=<token>` of a location, or null when absent / malformed. */
export function readHandoffToken(href: string): string | null {
  try {
    const value = new URL(href).searchParams.get(HANDOFF_QUERY_KEY);
    return value && /^[A-Za-z0-9_-]{16,256}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * After pairing: the address becomes `<path>?handoff=<token>` (pairing fragment and openExternalBrowser gone,
 * other query parameters kept), so 「加入主畫面」 saves a URL whose single-use token lets the web app get its own
 * session. Returns the new href (null when it could not be built).
 */
export function hrefWithHandoff(href: string, token: string): string | null {
  try {
    const url = new URL(href);
    url.hash = "";
    url.searchParams.delete(OPEN_EXTERNAL_BROWSER_KEY);
    url.searchParams.set(HANDOFF_QUERY_KEY, token);
    return url.toString();
  } catch {
    return null;
  }
}

/** The address without `?handoff=` (other parts kept). */
export function hrefWithoutHandoff(href: string): string | null {
  try {
    const url = new URL(href);
    if (!url.searchParams.has(HANDOFF_QUERY_KEY)) return href;
    url.searchParams.delete(HANDOFF_QUERY_KEY);
    return url.toString();
  } catch {
    return null;
  }
}

export function replaceLocationHref(next: string | null, win: Window = window): void {
  if (!next) return;
  try {
    win.history.replaceState(win.history.state, "", next);
  } catch {
    // Best effort only.
  }
}

/** Points `<link rel="manifest">` at `manifest.webmanifest?handoff=<token>` so its start_url carries the token too. */
export function pointManifestAtHandoff(token: string | null, doc: Document = document): void {
  const link = doc.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link) return;
  const base = "manifest.webmanifest";
  link.setAttribute("href", token ? `${base}?${HANDOFF_QUERY_KEY}=${encodeURIComponent(token)}` : base);
}

/** A link that is shared (copied / sent) carries openExternalBrowser=1 so LINE opens it in the real browser. */
export function shareableLink(link: string): string {
  try {
    const url = new URL(link);
    url.searchParams.set(OPEN_EXTERNAL_BROWSER_KEY, "1");
    return url.toString();
  } catch {
    return link;
  }
}

/** LINE honours openExternalBrowser=1 when the page is (re)opened with it; returns the href to go to, or null. */
export function lineExternalBrowserHref(href: string, userAgent: string): string | null {
  if (detectInAppBrowser(userAgent) !== "line") return null;
  try {
    const url = new URL(href);
    if (url.searchParams.get(OPEN_EXTERNAL_BROWSER_KEY) === "1") return null;
    url.searchParams.set(OPEN_EXTERNAL_BROWSER_KEY, "1");
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * 「在 App 開啟」 opens codex:// / claude:// links, which only the desktop apps on this PC handle. On a phone
 * (or any browser that is not on this PC) the button cannot work, so it is hidden.
 */
export function runAppLinksWorkHere(hostname: string = taskboardPageHostname()): boolean {
  if (isEmbeddedHostFrame()) return true;
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

export function readLocalFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeLocalFlag(key: string, value: boolean): void {
  try {
    if (value) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // Flags are conveniences only.
  }
}

/** Minimal session shape used by the wizard progress. */
export interface WizardSession {
  id: string;
  revokedAt: string | null;
  /** null = never expires. */
  expiresAt: string | null;
  homeScreenAt?: string | null;
}

/**
 * Desktop wizard progress: 「手機已配對」 once a session that did not exist when the wizard opened is active;
 * 「已加到主畫面」 once such a session reported display-mode standalone (or came from a handoff).
 */
function sessionActive(session: WizardSession, nowMs: number): boolean {
  return !session.revokedAt && (session.expiresAt === null || Date.parse(session.expiresAt) > nowMs);
}

export function wizardProgress(sessions: WizardSession[] | undefined, knownIds: ReadonlySet<string>, nowMs = Date.now()) {
  const fresh = (sessions ?? []).filter((session) => !knownIds.has(session.id) && sessionActive(session, nowMs));
  return { paired: fresh.length > 0, homeScreen: fresh.some((session) => Boolean(session.homeScreenAt)) };
}

export function hasActivePairedSession(sessions: WizardSession[] | undefined, nowMs = Date.now()): boolean {
  return (sessions ?? []).some((session) => sessionActive(session, nowMs));
}

/**
 * Paired phones connected to this PC: active sessions (permanent `expiresAt: null` included) that are not derived
 * through a handoff from another active session (the 「· 主畫面」 / 「· 瀏覽器」 copies of the same phone).
 */
export function activePairedPhones<T extends WizardSession & { parentSessionId?: string | null }>(
  sessions: T[] | undefined,
  nowMs = Date.now(),
): T[] {
  const active = (sessions ?? []).filter((session) => sessionActive(session, nowMs));
  const activeIds = new Set(active.map((session) => session.id));
  return active.filter((session) => !session.parentSessionId || !activeIds.has(session.parentSessionId));
}

export interface TailscaleMobilePeer {
  id: string;
  hostName: string;
  os: string;
  online: boolean;
}

/** First online phone that was not online when the wizard started watching (null when none). */
export function newlyOnlinePeer(peers: TailscaleMobilePeer[] | undefined, baselineOnline: ReadonlySet<string>): TailscaleMobilePeer | null {
  return (peers ?? []).find((peer) => peer.online && !baselineOnline.has(peer.id)) ?? null;
}

const TABLET_HOST_NAME = /ipad|tablet|galaxy[-_ ]?tab/i;

/**
 * Amendment 14: an online peer that is clearly a phone (OS iOS / android, host name not a tablet) — it
 * may already have been online when the wizard opened. Peers with an unknown OS or tablets only count
 * when they newly come online (`newlyOnlinePeer`).
 */
export function onlinePhonePeer(peers: TailscaleMobilePeer[] | undefined): TailscaleMobilePeer | null {
  return (peers ?? []).find((peer) => (
    peer.online
    && ["ios", "android"].includes(peer.os.toLowerCase())
    && !TABLET_HOST_NAME.test(peer.hostName)
  )) ?? null;
}


export type HandoffFailureContext = "standalone" | "browser";

export interface PhoneSessionStartup {
  /** The page address at startup. */
  href: string;
  standalone: boolean;
  /** Client storage answered 401 (no usable session cookie). */
  storageFailed: boolean;
  hasCsrfToken: () => boolean;
  /** POST /api/pairing/csrf; stores the token; rejects with an error carrying `status`. */
  refreshCsrf: () => Promise<unknown>;
  /** POST /api/pairing/handoff (standalone only here); stores the CSRF token. */
  redeemHandoff: (token: string, standalone: boolean) => Promise<unknown>;
  replaceHref: (next: string | null) => void;
  /** GET /api/pairing/availability; may reject (then pairing is assumed to be available). */
  availability?: () => Promise<{ mobileAccess: "on" | "paused" }>;
}

export interface PhoneSessionOutcome {
  /** A new session cookie was obtained (reload client storage). */
  redeemed: boolean;
  /** Show the pairing gate (6-digit code, or the handoff choice when `pendingHandoff` is set). */
  pairingRequired: boolean;
  handoffFailed: HandoffFailureContext | null;
  /** Browser tab opened with `?handoff=` and no session: the token is kept until the user chooses. */
  pendingHandoff: string | null;
  /** Mobile access is paused on the PC: show 「電腦已暫停手機存取」, not the 6-digit entry. */
  paused: boolean;
}

function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/**
 * Amendment 13 startup on a phone page (not this PC):
 * 1. Session cookie works but the CSRF token is missing (ITP cleared script storage, or a home-screen web app got
 *    only the cookie) → recover it from the cookie. Only a 401 means the session itself is gone.
 * 2. `?handoff=` in a home-screen web app → removed from the address; redeemed (`standalone: true`) when there is
 *    no usable session. A failure asks for the 6-digit code.
 * 3. `?handoff=` in a browser tab without a session → not redeemed automatically (it belongs to the home-screen
 *    app); the pairing gate offers 「在這個瀏覽器繼續」 or the 6-digit code.
 */
export async function resolvePhoneSession(startup: PhoneSessionStartup): Promise<PhoneSessionOutcome> {
  const outcome: PhoneSessionOutcome = { redeemed: false, pairingRequired: false, handoffFailed: null, pendingHandoff: null, paused: false };
  let sessionMissing = startup.storageFailed;
  if (!sessionMissing && !startup.hasCsrfToken()) {
    try {
      await startup.refreshCsrf();
    } catch (error) {
      if (errorStatus(error) === 401) sessionMissing = true;
    }
  }
  const token = readHandoffToken(startup.href);
  if (token && startup.standalone) startup.replaceHref(hrefWithoutHandoff(startup.href));
  if (!sessionMissing) return outcome;
  if (startup.availability) {
    try {
      if ((await startup.availability()).mobileAccess === "paused") {
        outcome.paused = true;
        outcome.pairingRequired = true;
        return outcome;
      }
    } catch {
      // Unknown: continue with the normal pairing path.
    }
  }
  if (token && startup.standalone) {
    try {
      await startup.redeemHandoff(token, true);
      outcome.redeemed = true;
      return outcome;
    } catch {
      outcome.handoffFailed = "standalone";
    }
  } else if (token) {
    outcome.pendingHandoff = token;
  }
  outcome.pairingRequired = true;
  return outcome;
}
