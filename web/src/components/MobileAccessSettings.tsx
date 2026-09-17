import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "../api";
import {
  createMobileAccessApi,
  type MobileAccessApi,
  type MobileAccessInspection,
  type PairedDeviceSession,
  type PairingChallenge,
  type PairingCompletionResult,
} from "../mobileAccessApi";
import { createPairingQrDataUrl } from "../mobilePairingQr.mjs";
import { useTaskboardI18n } from "../i18n";
import {
  detectInAppBrowser,
  hrefWithHandoff,
  hrefWithoutHandoff,
  isStandaloneDisplay,
  pointManifestAtHandoff,
  replaceLocationHref,
  shareableLink,
  type HandoffFailureContext,
} from "../phoneOnboarding";
import { InAppBrowserNotice } from "./PhoneOnboarding";
import "./MobileAccessSettings.css";

const defaultApi = createMobileAccessApi();
const DEVICE_LABEL_MAX_LENGTH = 120;
const CLOCK_TICK_MS = 5000;
const COPIED_FEEDBACK_MS = 1600;
const APPROVAL_RETRY_MS = 2000;
const APPROVAL_WAIT_LIMIT_MS = 5 * 60 * 1000;
const SHORT_CODE_LENGTH = 6;
/** Link fragment key (Amendment 10): `#pair=<challengeId>.<challengeCode>`. */
export const PAIRING_FRAGMENT_KEY = "pair";

export type AccessStage = "unknown" | "local-only" | "enabled" | "tailscale-missing";

/** Additive fields T5 returns on GET/PUT /api/local/mobile-access (no codes or tokens). */
export interface MobileAccessInspectionDetails extends MobileAccessInspection {
  sessions?: PairedDeviceSession[];
  pendingChallenges?: Array<{ challengeId: string; deviceLabel: string; expiresAt: string; approved: boolean }>;
}

/** Server reason for a missing tailnet address (shared/mobile-access-contract.mjs TAILSCALE_NOT_FOUND). */
export function isTailscaleMissingReason(reason: string | null | undefined): boolean {
  return typeof reason === "string" && /TAILSCALE/i.test(reason);
}

/**
 * Settings stage from the C7 inspection. The reason wins: without a tailnet address the page shows
 * 「找不到 Tailscale」 even while mobile access is off (enabling would fail), and an enabled board whose
 * tailnet address disappeared is not reachable from the phone either.
 */
export function stageOf(inspection: MobileAccessInspection | null): AccessStage {
  if (!inspection) return "unknown";
  if (isTailscaleMissingReason(inspection.reason)) return "tailscale-missing";
  if (!inspection.enabled) return "local-only";
  return inspection.url ? "enabled" : "tailscale-missing";
}

/** True when the page itself is served from this PC (desktop), not from the tailnet address (phone). */
export function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

/**
 * main.tsx: an unpaired phone gets 401 (PAIRING_REQUIRED) from /api/client-storage and must still render
 * the pairing page. Any other storage failure (or any failure on this PC) stays fatal, so default display
 * settings never overwrite the saved server values.
 */
export function canRenderWithoutClientStorage(error: unknown, hostname: string): boolean {
  if (isLoopbackHostname(hostname)) return false;
  return error instanceof Error && error.message.endsWith(" 401");
}

let phonePairingRequired = false;
/** main.tsx: this phone page loaded without a paired session, so show the manual 6-digit entry. */
export function markPhonePairingRequired(): void {
  phonePairingRequired = true;
}

export function isPhonePairingRequired(): boolean {
  return phonePairingRequired;
}

let phoneHandoffFailed: HandoffFailureContext | null = null;
/** main.tsx (Amendment 13): a `?handoff=` token could not be traded; ask for the 6-digit code with a fitting text. */
export function markPhoneHandoffFailed(context: HandoffFailureContext): void {
  phoneHandoffFailed = context;
}

let phoneAccessPaused = false;
/** main.tsx (Amendment 13): mobile access is paused on the PC. */
export function markPhoneAccessPaused(): void {
  phoneAccessPaused = true;
}

let phonePendingHandoff: string | null = null;
/** main.tsx (Amendment 13): a browser tab opened with `?handoff=` and no session; let the user choose. */
export function markPhonePendingHandoff(token: string): void {
  phonePendingHandoff = token;
}

/**
 * Amendment 13: after pairing in a browser, the address becomes `?handoff=<single-use token>` and the web manifest
 * start_url follows, so 「加入主畫面」 saves a URL that lets the home-screen web app get its own session.
 * A page already running standalone needs no handoff.
 */
export function applyPairingHandoff(result: PairingCompletionResult | undefined, win: Window = window): void {
  if (!result?.handoffToken || isStandaloneDisplay(win)) return;
  replaceLocationHref(hrefWithHandoff(win.location.href, result.handoffToken), win);
  pointManifestAtHandoff(result.handoffToken, win.document);
}

function isLocalHost(hostname: string): boolean {
  return isLoopbackHostname(hostname);
}

export interface PairingLinkSecret {
  challengeId: string;
  challengeCode: string;
}

/** Reads `#pair=<challengeId>.<challengeCode>` from a pairing link (null when absent or malformed). */
export function readPairingFragment(href: string): PairingLinkSecret | null {
  let hash: string;
  try {
    hash = new URL(href).hash.replace(/^#/, "");
  } catch {
    return null;
  }
  const value = new URLSearchParams(hash).get(PAIRING_FRAGMENT_KEY);
  const match = value?.match(/^([A-Za-z0-9-]{1,128})\.([A-Za-z0-9_-]{16,256})$/);
  return match ? { challengeId: match[1], challengeCode: match[2] } : null;
}

/** Removes the pairing secret from the address bar / history entry (keeps path and query). */
export function scrubPairingSecretFromLocation(win: Window = window): void {
  try {
    const url = new URL(win.location.href);
    const params = new URLSearchParams(url.hash.replace(/^#/, ""));
    if (!params.has(PAIRING_FRAGMENT_KEY)) return;
    params.delete(PAIRING_FRAGMENT_KEY);
    const rest = params.toString();
    url.hash = rest ? `#${rest}` : "";
    win.history.replaceState(win.history.state, "", url.toString());
  } catch {
    // Best effort: a failed scrub must not block pairing; the secret is single use and expires in minutes.
  }
}

function formatTimestamp(locale: string, value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(date);
}

// CONTRACTS Amendment 10 (scan-to-pair): the QR/link carries the one-time pairing secret in the URL
// fragment (`#pair=<challengeId>.<challengeCode>`). A fragment is never sent to the server (no access-log
// or Referer leak); the phone page removes it from history right after reading it. The secret is single use,
// bound to its challenge, expires with it (5 min) and dies when the desktop removes the request. This replaces
// the earlier fork design (id-only link + typed long code), which was unusable on a phone.
export function pairingLink(baseUrl: string, challengeId: string, challengeCode: string): string | null {
  try {
    const url = new URL(baseUrl);
    url.hash = `${PAIRING_FRAGMENT_KEY}=${challengeId}.${challengeCode}`;
    return url.toString();
  } catch {
    return null;
  }
}

function safeQrDataUrl(link: string): string | null {
  try {
    return createPairingQrDataUrl(link);
  } catch {
    return null;
  }
}

function mobileAccessErrorMessage(cause: unknown, text: ReturnType<typeof useTaskboardI18n>["text"]): string {
  // Only the generic "no route matched" 404 (server/app.mjs's catch-all `NOT_FOUND`) means the
  // mobile access service is not available. A named 404 from a route that DOES exist (e.g. approveChallenge's
  // PAIRING_CHALLENGE_NOT_FOUND or revokeDevice's SESSION_NOT_FOUND) is a real not-found and keeps its message.
  if (cause instanceof ApiError && cause.status === 404 && cause.code === "NOT_FOUND") {
    return text(
      "目前無法使用手機存取，請重新開啟 AutoMate 後再試。",
      "Mobile access is not available right now. Restart AutoMate and try again.",
    );
  }
  return cause instanceof Error ? cause.message : text("手機存取設定失敗", "Mobile access setup failed");
}

/** Phone-facing message for a pairing failure (Taiwan Traditional Chinese first). */
export function pairingErrorMessage(cause: unknown, text: ReturnType<typeof useTaskboardI18n>["text"]): string {
  const code = cause instanceof ApiError ? cause.code : null;
  switch (code) {
    case "PAIRING_CHALLENGE_INVALID":
      return text("配對碼不正確或已使用過。請確認電腦上的配對碼，或重新產生。", "The pairing code is wrong or already used. Check the code on the PC or create a new one.");
    case "PAIRING_CHALLENGE_EXPIRED":
      return text("配對碼已過期，請在電腦上重新產生配對碼。", "The pairing code expired. Create a new one on the PC.");
    case "PAIRING_ATTEMPTS_EXCEEDED":
      return text("錯誤次數過多，這組配對碼已鎖定。請在電腦上重新產生配對碼。", "Too many wrong tries; this pairing code is locked. Create a new one on the PC.");
    case "MOBILE_ACCESS_DISABLED":
      return text("電腦上的手機存取已關閉。", "Mobile access is turned off on the PC.");
    case "SERVICE_UNAVAILABLE":
      return text("無法連線到電腦，請確認 Tailscale 已連線。", "Cannot reach the PC. Check that Tailscale is connected.");
    default:
      return cause instanceof Error && cause.message ? cause.message : text("配對失敗", "Pairing failed");
  }
}

type PairingPhase = "hidden" | "in-app" | "paused" | "handoff-choice" | "auto" | "waiting-approval" | "manual" | "working" | "done";

/** Amendment 13: why the automatic sign-in did not work, and what to do on the PC. */
export function handoffFailureMessage(context: HandoffFailureContext, text: ReturnType<typeof useTaskboardI18n>["text"]): string {
  return context === "standalone"
    ? text(
      "從主畫面開啟時沒有自動登入成功。請在電腦開「連接手機」產生配對碼，再在這裡輸入 6 位數配對碼。",
      "Signing in automatically from the Home Screen did not work. On the PC, open Connect a phone to create a pairing code, then enter the 6 digits here.",
    )
    : text(
      "這個網址的自動登入已失效（已用過、已過期，或這支手機已在電腦上移除）。請在電腦開「連接手機」產生配對碼，再在這裡輸入 6 位數配對碼。",
      "This address can no longer sign in (already used, expired, or this phone was removed on the PC). On the PC, open Connect a phone to create a pairing code, then enter the 6 digits here.",
    );
}

/**
 * Phone-side half of pairing (CONTRACTS Amendment 10).
 * - Opened from the desktop QR / link (`#pair=<challengeId>.<challengeCode>`): the secret is removed from the
 *   address bar at once and pairing is submitted automatically (「正在配對…」). If the desktop has not allowed
 *   the request yet (409 PAIRING_APPROVAL_REQUIRED) the page waits and retries on its own.
 * - Opened on the plain board URL while unpaired (`pairingRequired`): manual fallback with the 6-digit code
 *   shown on the PC (numeric keyboard). Validation messages appear only after submitting.
 * Renders nothing on this PC itself or once pairing is done.
 */
export function PairingCompletion({
  api = defaultApi,
  locationHref = window.location.href,
  pairingRequired = phonePairingRequired,
  handoffFailed = phoneHandoffFailed,
  pendingHandoff = phonePendingHandoff,
  paused = phoneAccessPaused,
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  onPaired,
}: {
  api?: MobileAccessApi;
  locationHref?: string;
  /** The page loaded without a paired session (main.tsx); shows the 6-digit entry when there is no link secret. */
  pairingRequired?: boolean;
  /** Amendment 13: a handoff token did not work (main.tsx); explain before asking for the code. */
  handoffFailed?: HandoffFailureContext | null;
  /** Amendment 13: browser tab with `?handoff=` and no session; offer 「在這個瀏覽器繼續」. */
  pendingHandoff?: string | null;
  /** Amendment 13: mobile access is paused on the PC (main.tsx). */
  paused?: boolean;
  userAgent?: string;
  /** Called after the phone received its session (App re-reads projects, storage and tasks). */
  onPaired?: (result?: PairingCompletionResult) => void;
}) {
  const { text } = useTaskboardI18n();
  // Captured once: the address bar is scrubbed right after this read, so later renders must not re-parse it.
  const [initial] = useState(() => {
    let local = true;
    try {
      local = isLocalHost(new URL(locationHref).hostname);
    } catch {
      local = true;
    }
    // Amendment 13: inside an in-app browser the single-use secret is left untouched (not sent, not scrubbed).
    const inAppBrowser = local ? null : detectInAppBrowser(userAgent);
    return { local, inAppBrowser, secret: local ? null : readPairingFragment(locationHref) };
  });
  const [phase, setPhase] = useState<PairingPhase>(() => (
    initial.local
      ? "hidden"
      : initial.inAppBrowser && (initial.secret || pairingRequired)
        ? "in-app"
        : initial.secret ? "auto" : pairingRequired ? (paused ? "paused" : pendingHandoff ? "handoff-choice" : "manual") : "hidden"
  ));
  const isPausedError = (cause: unknown) => cause instanceof ApiError && cause.code === "MOBILE_ACCESS_DISABLED";
  const [shortCode, setShortCode] = useState("");
  const [message, setMessage] = useState(() => (
    handoffFailed && !initial.secret ? handoffFailureMessage(handoffFailed, text) : ""
  ));
  const started = useRef(false);
  const mounted = useRef(true);
  const retryTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (retryTimer.current !== undefined) window.clearTimeout(retryTimer.current);
    };
  }, []);

  const finish = (result?: PairingCompletionResult) => {
    setPhase("done");
    applyPairingHandoff(result);
    onPaired?.(result);
  };

  useEffect(() => {
    const secret = initial.secret;
    if (!secret || initial.inAppBrowser || started.current) return;
    started.current = true;
    scrubPairingSecretFromLocation();
    const deadline = Date.now() + APPROVAL_WAIT_LIMIT_MS;
    const attempt = async () => {
      try {
        const result = await api.completePairing(secret.challengeId, secret.challengeCode);
        if (mounted.current) finish(result);
      } catch (cause) {
        if (!mounted.current) return;
        if (cause instanceof ApiError && cause.code === "PAIRING_APPROVAL_REQUIRED" && Date.now() < deadline) {
          setPhase("waiting-approval");
          retryTimer.current = window.setTimeout(() => void attempt(), APPROVAL_RETRY_MS);
          return;
        }
        if (isPausedError(cause)) {
          setPhase("paused");
          return;
        }
        setMessage(pairingErrorMessage(cause, text));
        setPhase("manual");
      }
    };
    void attempt();
    // Runs once per page load; `started` guards StrictMode's double effect so a single-use secret is sent once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === "hidden" || phase === "done") return null;
  if (phase === "in-app" && initial.inAppBrowser) {
    return <InAppBrowserNotice browser={initial.inAppBrowser} userAgent={userAgent} href={locationHref} />;
  }
  if (phase === "paused") {
    return (
      <div className="mobile-pairing-gate" role="dialog" aria-modal="true" aria-label={text("手機配對", "Phone pairing")}>
        <div>
          <h2>{text("電腦已暫停手機存取", "Phone access is paused on the PC")}</h2>
          <p>{text(
            "這支手機的配對仍然保留，不需要重新配對。請在電腦上重新開啟手機存取，再按「重新整理」。",
            "This phone stays paired; no need to pair again. Turn phone access back on at the PC, then tap Refresh.",
          )}</p>
          <div className="phone-onboarding-actions">
            <button className="button primary" type="button" onClick={() => window.location.reload()}>{text("重新整理", "Refresh")}</button>
          </div>
        </div>
      </div>
    );
  }
  if (phase === "handoff-choice" && pendingHandoff) {
    const continueInBrowser = async () => {
      setPhase("working");
      try {
        const result = await api.redeemHandoff(pendingHandoff, false);
        if (mounted.current) finish(result);
      } catch (cause) {
        if (!mounted.current) return;
        if (isPausedError(cause)) {
          setPhase("paused");
          return;
        }
        replaceLocationHref(hrefWithoutHandoff(window.location.href));
        setMessage(cause instanceof ApiError && cause.code === "SERVICE_UNAVAILABLE"
          ? pairingErrorMessage(cause, text)
          : handoffFailureMessage("browser", text));
        setPhase("manual");
      }
    };
    return (
      <div className="mobile-pairing-gate" role="dialog" aria-modal="true" aria-label={text("手機配對", "Phone pairing")}>
        <div>
          <h2>{text("請從主畫面圖示開啟", "Open it from the Home Screen icon")}</h2>
          <p>{text(
            "這個網址帶有給主畫面 App 用的一次性登入。如果已經把看板加到主畫面，請改從主畫面的圖示開啟。",
            "This address carries a one-time sign-in for the Home Screen app. If you already added the board, open it from its Home Screen icon.",
          )}</p>
          <div className="phone-onboarding-actions">
            <button className="button secondary" type="button" onClick={() => setPhase("manual")}>{text("改輸入 6 位數配對碼", "Enter a 6-digit code")}</button>
            <button className="button primary" type="button" onClick={() => void continueInBrowser()}>{text("在這個瀏覽器繼續", "Continue in this browser")}</button>
          </div>
        </div>
      </div>
    );
  }

  const submitShortCode = async (event: FormEvent) => {
    event.preventDefault();
    if (phase === "working") return;
    const code = shortCode.replace(/\s+/g, "");
    if (!new RegExp(`^[0-9]{${SHORT_CODE_LENGTH}}$`).test(code)) {
      setMessage(text("請輸入電腦上顯示的 6 位數配對碼", "Enter the 6-digit pairing code shown on the PC"));
      return;
    }
    setPhase("working");
    setMessage("");
    try {
      finish(await api.completePairingWithShortCode(code));
    } catch (cause) {
      if (isPausedError(cause)) {
        setPhase("paused");
        return;
      }
      setMessage(pairingErrorMessage(cause, text));
      setPhase("manual");
    }
  };

  const automatic = phase === "auto" || phase === "waiting-approval";
  return (
    <div className="mobile-pairing-gate" role="dialog" aria-modal="true" aria-label={text("手機配對", "Phone pairing")}>
      <div>
        <h2>{text("連接這支手機", "Connect this phone")}</h2>
        {automatic ? (
          <p className="mobile-pairing-progress" role="status">
            {phase === "auto"
              ? text("正在配對…", "Pairing…")
              : text("正在配對…等待電腦上按「允許」", "Pairing… waiting for Allow on the PC")}
          </p>
        ) : (
          <form noValidate onSubmit={(event) => void submitShortCode(event)}>
            <p>{text(
              "用手機相機掃描電腦上的 QR 碼即可自動配對。無法掃描時，請輸入電腦上顯示的 6 位數配對碼。",
              "Scan the QR code on the PC with the phone camera to pair automatically. If you cannot scan, enter the 6-digit code shown on the PC.",
            )}</p>
            <label>
              <span>{text("6 位數配對碼", "6-digit pairing code")}</span>
              <input
                className="mobile-pairing-short-code-input"
                value={shortCode}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={SHORT_CODE_LENGTH}
                autoComplete="one-time-code"
                spellCheck={false}
                onChange={(event) => setShortCode(event.target.value.replace(/[^0-9]/g, "").slice(0, SHORT_CODE_LENGTH))}
              />
            </label>
            {message && <p className="mobile-access-error" role="alert">{message}</p>}
            <button className="button primary" type="submit" disabled={phase === "working"}>
              {phase === "working" ? text("正在配對…", "Pairing…") : text("完成配對", "Complete pairing")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export function MobileAccessSettings({
  api = defaultApi,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
  showPairingCompletion = true,
}: {
  api?: MobileAccessApi;
  /** Controlled dialog state (App opens it from the project menu); uncontrolled when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Floating 「手機存取」 button (the standalone mount); App uses its own menu entry instead. */
  showTrigger?: boolean;
  /** Phone-side pairing gate; App mounts PairingCompletion itself. */
  showPairingCompletion?: boolean;
}) {
  const { text, locale } = useTaskboardI18n();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [inspection, setInspection] = useState<MobileAccessInspectionDetails | null>(null);
  const [devices, setDevices] = useState<PairedDeviceSession[] | null>(null);
  const [devicesUnavailable, setDevicesUnavailable] = useState(false);
  const [challenges, setChallenges] = useState<PairingChallenge[]>([]);
  const [deviceLabel, setDeviceLabel] = useState(() => text("我的手機", "My phone"));
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedChallengeId, setCopiedChallengeId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const stage = stageOf(inspection);

  // T5 returns paired sessions and pending challenges on the inspection itself; the separate
  // listPairedDevices() route is only a fallback for servers that do not send them.
  const applyInspection = (next: MobileAccessInspectionDetails) => {
    setInspection(next);
    if (Array.isArray(next.pendingChallenges)) {
      const pendingById = new Map(next.pendingChallenges.map((challenge) => [challenge.challengeId, challenge]));
      setChallenges((prev) => prev.flatMap((candidate) => {
        const pending = pendingById.get(candidate.challengeId);
        // Gone from the server list = the phone completed pairing, or the challenge expired.
        if (!pending) return [];
        return pending.approved && !candidate.approved ? [{ ...candidate, approved: true }] : [candidate];
      }));
    }
    return next;
  };

  const loadDevices = async (current?: MobileAccessInspectionDetails) => {
    if (current && Array.isArray(current.sessions)) {
      setDevices(current.sessions);
      setDevicesUnavailable(false);
      return;
    }
    try {
      setDevices(await api.listPairedDevices());
      setDevicesUnavailable(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        setDevices(null);
        setDevicesUnavailable(true);
        return;
      }
      throw cause;
    }
  };

  const refresh = async (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    try {
      const next = applyInspection(await api.inspect() as MobileAccessInspectionDetails);
      await loadDevices(next);
    } catch (cause) {
      if (!quiet) setError(mobileAccessErrorMessage(cause, text));
    } finally {
      if (!quiet) setLoading(false);
    }
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (open) void refresh();
    // Deliberately runs only when the dialog opens; `refresh` is stable enough for this UI.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const waitingForPhone = challenges.some((challenge) => challenge.approved);
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
      // An allowed challenge completes on the phone; re-read so the device list and challenge list follow.
      if (waitingForPhone) void refreshRef.current(true);
    }, CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [open, waitingForPhone]);

  const toggleEnabled = async () => {
    if (!inspection || loading) return;
    setLoading(true);
    setError(null);
    try {
      const next = applyInspection(await api.setEnabled(!inspection.enabled) as MobileAccessInspectionDetails);
      await loadDevices(next);
    } catch (cause) {
      setError(mobileAccessErrorMessage(cause, text));
    } finally {
      setLoading(false);
    }
  };

  const submitCreateChallenge = async (event: FormEvent) => {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const label = deviceLabel.trim() || text("我的手機", "My phone");
      const challenge = await api.createChallenge(label);
      setChallenges((prev) => [...prev, challenge]);
      // Amendment 10: pressing 「產生配對碼」 on this PC is the approval (loopback-only, user is at the PC),
      // so the QR works immediately. If this step fails the request stays listed with an 「允許」 retry button.
      const approval = await api.approveChallenge(challenge.challengeId);
      setChallenges((prev) => prev.map((candidate) => (
        candidate.challengeId === challenge.challengeId
          ? { ...candidate, approved: true, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt }
          : candidate
      )));
    } catch (cause) {
      setError(mobileAccessErrorMessage(cause, text));
    } finally {
      setLoading(false);
    }
  };

  const approve = async (challengeId: string) => {
    setBusyId(challengeId);
    setError(null);
    try {
      const approval = await api.approveChallenge(challengeId);
      setChallenges((prev) => prev.map((candidate) => (
        candidate.challengeId === challengeId
          ? { ...candidate, approved: true, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt }
          : candidate
      )));
    } catch (cause) {
      setError(mobileAccessErrorMessage(cause, text));
    } finally {
      setBusyId(null);
    }
  };

  const dismissChallenge = async (challengeId: string) => {
    setChallenges((prev) => prev.filter((candidate) => candidate.challengeId !== challengeId));
    try {
      // Removing a request revokes it on the server: its QR link and 6-digit code stop working.
      await api.revokeChallenge(challengeId);
    } catch (cause) {
      // Already consumed / expired / gone: nothing left to revoke.
      if (!(cause instanceof ApiError && [404, 409, 410].includes(cause.status))) setError(mobileAccessErrorMessage(cause, text));
    }
  };

  const revoke = async (sessionId: string) => {
    setBusyId(sessionId);
    setError(null);
    try {
      await api.revokeDevice(sessionId);
      await refresh(true);
    } catch (cause) {
      setError(mobileAccessErrorMessage(cause, text));
    } finally {
      setBusyId(null);
    }
  };

  const copyLink = (challengeId: string, link: string) => {
    void navigator.clipboard.writeText(link).then(() => {
      setCopiedChallengeId(challengeId);
      window.setTimeout(() => {
        setCopiedChallengeId((current) => (current === challengeId ? null : current));
      }, COPIED_FEEDBACK_MS);
    });
  };

  const stageLabel = stage === "unknown"
    ? text("狀態尚未確認", "Status not verified")
    : stage === "local-only"
      ? text("僅限本機", "Local only")
      : stage === "enabled"
        ? text("手機存取已開啟", "Mobile access is on")
        : text("找不到 Tailscale（請先安裝並登入 Tailscale）", "Tailscale not found (install and sign in first)");

  return (
    <>
      {showPairingCompletion && <PairingCompletion api={api} />}
      {showTrigger && (
        <button
          type="button"
          className="mobile-access-settings-trigger no-drag"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          {text("手機存取", "Mobile access")}
        </button>
      )}
      {open && (
        <div
          className="mobile-access-settings-backdrop no-drag"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            className="mobile-access-settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={text("手機存取設定", "Mobile access settings")}
          >
            <header>
              <div>
                <h2>{text("手機存取設定", "Mobile access settings")}</h2>
                <p>{text(
                  "透過 Tailscale 私人網路，在你自己配對過的手機上開啟這個看板。",
                  "Open this board on phones you pair yourself, over your private Tailscale network.",
                )}</p>
              </div>
              <button className="icon-button" type="button" aria-label={text("關閉", "Close")} onClick={() => setOpen(false)}>×</button>
            </header>

            <div className={`mobile-access-stage is-${stage}`} role="status">
              <strong>{stageLabel}</strong>
              {stage === "tailscale-missing" && inspection?.reason && !isTailscaleMissingReason(inspection.reason) && (
                <span>{inspection.reason}</span>
              )}
            </div>

            {stage === "local-only" && (
              <p className="mobile-access-guidance">{text(
                "看板目前只能在這台電腦上使用。啟用後才會開放給你自己配對過的手機。",
                "The board is local to this PC right now. Enabling it opens access only to phones you pair yourself.",
              )}</p>
            )}
            {!inspection?.enabled && (devices ?? []).some((device) => !device.revokedAt) && (
              <p className="mobile-access-guidance">{text(
                "手機存取關閉期間，已配對的手機暫時無法使用；重新開啟後不必重新配對。要讓某支手機永久失效，請在下方按「移除」。",
                "While phone access is off, paired phones are paused; they work again without re-pairing when it is turned back on. To remove a phone for good, use Remove below.",
              )}</p>
            )}
            {stage === "tailscale-missing" && (
              <p className="mobile-access-guidance">{text(
                "請先安裝 Tailscale 並登入你的帳號，然後回來重新整理。",
                "Install Tailscale and sign in to your account, then come back and refresh.",
              )}</p>
            )}

            {stage === "enabled" && inspection?.url && (
              <div className="mobile-access-url">
                <span>{text("手機開啟網址", "Open on your phone")}</span>
                <code>{inspection.url}</code>
              </div>
            )}

            {stage === "enabled" && (
              <form className="mobile-access-pairing" onSubmit={(event) => void submitCreateChallenge(event)}>
                <label>
                  <span>{text("裝置名稱", "Device name")}</span>
                  <input
                    value={deviceLabel}
                    maxLength={DEVICE_LABEL_MAX_LENGTH}
                    onChange={(event) => setDeviceLabel(event.target.value)}
                  />
                </label>
                <button className="button secondary" type="submit" disabled={loading}>
                  {text("產生配對碼", "Create pairing code")}
                </button>
              </form>
            )}

            {stage === "enabled" && challenges.length > 0 && (
              <div className="mobile-pairing-list">
                <h3>{text("待處理的配對請求", "Pending pairing requests")}</h3>
                {challenges.map((challenge) => {
                  const expired = Date.parse(challenge.expiresAt) <= nowMs;
                  const link = inspection?.url ? pairingLink(inspection.url, challenge.challengeId, challenge.challengeCode) : null;
                  const qrDataUrl = link && !expired ? safeQrDataUrl(link) : null;
                  return (
                    <div
                      key={challenge.challengeId}
                      className={`mobile-pairing-item ${challenge.approved ? "is-approved" : "is-pending"}`}
                    >
                      <button
                        className="mobile-pairing-item-dismiss icon-button"
                        type="button"
                        aria-label={text("取消這個配對請求", "Cancel this pairing request")}
                        onClick={() => void dismissChallenge(challenge.challengeId)}
                      >
                        ×
                      </button>
                      <div className="mobile-pairing-item-head">
                        <strong>{challenge.deviceLabel}</strong>
                        <span>
                          {expired
                            ? text("已過期", "Expired")
                            : challenge.approved
                              ? text("已允許 · 等待手機完成配對", "Allowed · waiting for the phone")
                              : text("尚未允許", "Not allowed yet")}
                        </span>
                      </div>
                      {!challenge.approved && !expired && (
                        <button
                          className="button primary"
                          type="button"
                          disabled={busyId === challenge.challengeId}
                          onClick={() => void approve(challenge.challengeId)}
                        >
                          {text("允許", "Allow")}
                        </button>
                      )}
                      {challenge.approved && !expired && link && (
                        <div className="mobile-pairing-entry">
                          {qrDataUrl && (
                            <img
                              className="mobile-pairing-qr"
                              src={qrDataUrl}
                              alt={text("用手機相機掃描即可自動配對", "Scan with the phone camera to pair automatically")}
                            />
                          )}
                          <div className="mobile-pairing-entry-details">
                            <p className="mobile-access-guidance">{text(
                              "用手機相機掃描 QR 碼，手機會自動完成配對。無法掃描時，在手機開啟上方網址並輸入 6 位數配對碼。",
                              "Scan the QR code with the phone camera; the phone pairs automatically. If you cannot scan, open the address above on the phone and enter the 6-digit code.",
                            )}</p>
                            <div className="mobile-pairing-code">
                              <span>{text("6 位數配對碼", "6-digit pairing code")}</span>
                              <code className="mobile-pairing-short-code" aria-label={text("6 位數配對碼", "6-digit pairing code")}>{challenge.shortCode}</code>
                            </div>
                            <div>
                              <button
                                className="button secondary"
                                type="button"
                                onClick={() => copyLink(challenge.challengeId, shareableLink(link))}
                              >
                                {copiedChallengeId === challenge.challengeId ? text("已複製", "Copied") : text("複製連結", "Copy link")}
                              </button>
                              <span>{text("到期：", "Expires: ")}{formatTimestamp(locale, challenge.expiresAt)}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mobile-access-devices">
              <h3>{text("已配對裝置", "Paired devices")}</h3>
              {devicesUnavailable && (
                <p className="mobile-access-guidance">{text(
                  "目前無法讀取已配對的手機，請按「重新整理」再試。",
                  "Paired phones cannot be loaded right now. Press Refresh to try again.",
                )}</p>
              )}
              {!devicesUnavailable && devices && devices.length === 0 && (
                <p className="mobile-access-empty">{text("尚未配對任何手機。", "No phones paired yet.")}</p>
              )}
              {!devicesUnavailable && devices?.map((device) => (
                <div key={device.id} className={`mobile-access-device ${device.revokedAt ? "is-revoked" : ""}`}>
                  <span>
                    <strong>{device.deviceLabel}</strong>
                    <small>
                      {text("最後使用：", "Last seen: ")}{formatTimestamp(locale, device.lastSeenAt)}
                      {" · "}{device.expiresAt
                        ? <>{text("到期：", "Expires: ")}{formatTimestamp(locale, device.expiresAt)}</>
                        : text("不會過期（移除後失效）", "Does not expire (until removed)")}
                    </small>
                  </span>
                  {!device.revokedAt && (
                    <button
                      className="button secondary"
                      type="button"
                      disabled={busyId === device.id}
                      aria-label={text(`移除 ${device.deviceLabel}`, `Remove ${device.deviceLabel}`)}
                      onClick={() => void revoke(device.id)}
                    >
                      {text("移除", "Remove")}
                    </button>
                  )}
                </div>
              ))}
            </div>

            {error && <div className="mobile-access-error" role="alert">{error}</div>}

            <footer>
              <button className="button secondary" type="button" disabled={loading} onClick={() => void refresh()}>
                {text("重新整理", "Refresh")}
              </button>
              {inspection && (
                <button
                  className="button primary"
                  type="button"
                  disabled={loading || (!inspection.enabled && stage === "tailscale-missing")}
                  onClick={() => void toggleEnabled()}
                >
                  {loading
                    ? text("處理中…", "Working…")
                    : inspection.enabled
                      ? text("關閉手機存取", "Disable mobile access")
                      : text("啟用手機存取", "Enable mobile access")}
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
