/*
 * W12-C (CONTRACTS Amendment 13) component tests:
 *   npx vitest run web/src/components/PhoneOnboarding.test.tsx --environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import type { MobileAccessApi } from "../mobileAccessApi";
import {
  HANDOFF_QUERY_KEY,
  PHONE_STORAGE_KEYS,
  TAILSCALE_APP_STORE_URL,
  TAILSCALE_GOOGLE_PLAY_URL,
  detectInAppBrowser,
  homeScreenGuide,
  homeScreenGuideKind,
  hrefWithHandoff,
  hrefWithoutHandoff,
  iosMajorVersion,
  activePairedPhones,
  lineExternalBrowserHref,
  newlyOnlinePeer,
  readHandoffToken,
  resolvePhoneSession,
  runAppLinksWorkHere,
  shareableLink,
  wizardProgress,
} from "../phoneOnboarding";
import { PairingCompletion } from "./MobileAccessSettings";
import { HomeScreenGuideDialog, InAppBrowserNotice, PHONE_TIPS, PhoneBoardTips, PhoneOnboarding } from "./PhoneOnboarding";
import { PhoneSetupWizard } from "./PhoneSetupWizard";
import { HeaderPhoneButton, usePairedPhones } from "./HeaderPhoneButton";

const UA = {
  iosSafari17: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iosSafari26: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  iosChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.119 Mobile/15E148 Safari/604.1",
  iPadDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36",
  lineIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.10.0",
  lineAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/139.0.0.0 Mobile Safari/537.36 Line/15.10.0/IAB",
  fbIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0.0.0;FBBV/1]",
  fbAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/139.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/500.0.0.0;]",
  instagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0",
};

const PHONE_BASE = "http://100.64.0.1:47833/";
const CHALLENGE_ID = "c4a11e00-0000-4000-8000-000000000002";
const SECRET = "TestPairingSecret00000000000000000000000000";
const HANDOFF = "H".repeat(43);

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
  document.head.querySelectorAll('link[rel="manifest"]').forEach((link) => link.remove());
});

describe("phoneOnboarding model", () => {
  it("detects LINE, Facebook and Instagram in-app browsers by UA", () => {
    expect(detectInAppBrowser(UA.lineIos)).toBe("line");
    expect(detectInAppBrowser(UA.lineAndroid)).toBe("line");
    expect(detectInAppBrowser(UA.fbIos)).toBe("facebook");
    expect(detectInAppBrowser(UA.fbAndroid)).toBe("facebook");
    expect(detectInAppBrowser(UA.instagram)).toBe("instagram");
    expect(detectInAppBrowser(UA.iosSafari17)).toBeNull();
    expect(detectInAppBrowser(UA.androidChrome)).toBeNull();
    expect(detectInAppBrowser("Mozilla/5.0 Online/1.0")).toBeNull();
  });

  it("chooses the home-screen guide by platform, browser and iOS version", () => {
    expect(iosMajorVersion(UA.iosSafari17)).toBe(17);
    expect(iosMajorVersion(UA.iosSafari26)).toBe(26);
    expect(homeScreenGuideKind(UA.iosSafari17)).toBe("ios-safari");
    expect(homeScreenGuideKind(UA.iosSafari26)).toBe("ios-safari-26");
    expect(homeScreenGuideKind(UA.iosChrome)).toBe("ios-other-browser");
    expect(homeScreenGuideKind(UA.iPadDesktop, 5)).toBe("ios-safari");
    expect(homeScreenGuideKind(UA.iPadDesktop, 0)).toBe("unknown");
    expect(homeScreenGuideKind(UA.androidChrome)).toBe("android-chrome");
    expect(homeScreenGuideKind(UA.samsung)).toBe("android-other");
    expect(homeScreenGuide(UA.iosSafari17).arrow).toBe("bottom-center");
    expect(homeScreenGuide(UA.iPadDesktop, 5).arrow).toBe("top-right");
    expect(homeScreenGuide(UA.iosSafari26).arrow).toBe("bottom-right");
    expect(homeScreenGuide(UA.androidChrome).arrow).toBe("top-right");
  });

  it("replaces the address with a handoff token and strips it again", () => {
    const next = hrefWithHandoff(`${PHONE_BASE}?view=board&openExternalBrowser=1#pair=${CHALLENGE_ID}.${SECRET}`, HANDOFF)!;
    const url = new URL(next);
    expect(url.hash).toBe("");
    expect(url.searchParams.get("view")).toBe("board");
    expect(url.searchParams.get("openExternalBrowser")).toBeNull();
    expect(url.searchParams.get(HANDOFF_QUERY_KEY)).toBe(HANDOFF);
    expect(next.includes(SECRET)).toBe(false);
    expect(readHandoffToken(next)).toBe(HANDOFF);
    expect(readHandoffToken(`${PHONE_BASE}?handoff=bad%20token`)).toBeNull();
    expect(hrefWithoutHandoff(next)).toBe(`${PHONE_BASE}?view=board`);
  });

  it("shared links carry openExternalBrowser=1; LINE is sent out once", () => {
    const shared = shareableLink(`${PHONE_BASE}#pair=${CHALLENGE_ID}.${SECRET}`);
    expect(new URL(shared).searchParams.get("openExternalBrowser")).toBe("1");
    expect(new URL(shared).hash).toBe(`#pair=${CHALLENGE_ID}.${SECRET}`);
    expect(lineExternalBrowserHref(PHONE_BASE, UA.lineIos)).toBe(`${PHONE_BASE}?openExternalBrowser=1`);
    expect(lineExternalBrowserHref(`${PHONE_BASE}?openExternalBrowser=1`, UA.lineIos)).toBeNull();
    expect(lineExternalBrowserHref(PHONE_BASE, UA.fbIos)).toBeNull();
  });

  it("wizard progress ticks only for sessions created after the wizard opened", () => {
    const future = "2099-01-01T00:00:00.000Z";
    const known = new Set(["old"]);
    expect(wizardProgress([{ id: "old", revokedAt: null, expiresAt: future, homeScreenAt: "x" }], known)).toEqual({ paired: false, homeScreen: false });
    expect(wizardProgress([{ id: "new", revokedAt: null, expiresAt: future, homeScreenAt: null }], known)).toEqual({ paired: true, homeScreen: false });
    expect(wizardProgress([{ id: "new", revokedAt: null, expiresAt: future, homeScreenAt: "2026-09-17T00:00:00Z" }], known)).toEqual({ paired: true, homeScreen: true });
    expect(wizardProgress([{ id: "gone", revokedAt: "x", expiresAt: future }], known).paired).toBe(false);
    expect(newlyOnlinePeer([{ id: "a", hostName: "iPad", os: "iOS", online: true }], new Set(["a"]))).toBeNull();
    expect(newlyOnlinePeer([{ id: "b", hostName: "iPhone", os: "iOS", online: true }], new Set(["a"]))?.hostName).toBe("iPhone");
  });

  it("paired phones: permanent (expiresAt null) and future sessions count, revoked / expired do not, handoff copies count once", () => {
    const now = Date.parse("2026-09-17T09:00:00.000Z");
    const base = { deviceLabel: "我的手機", createdAt: "", lastSeenAt: "" };
    // The product owner's database: one permanent pairing (stored 'never', reported as null).
    expect(activePairedPhones([{ ...base, id: "p", expiresAt: null, revokedAt: null, homeScreenAt: "2026-09-17T08:20:07.843Z", parentSessionId: null }], now).map((s) => s.id)).toEqual(["p"]);
    expect(activePairedPhones([
      { ...base, id: "a", expiresAt: null, revokedAt: null, parentSessionId: null },
      { ...base, id: "a-home", deviceLabel: "我的手機 · 主畫面", expiresAt: null, revokedAt: null, parentSessionId: "a" },
      { ...base, id: "b", expiresAt: "2099-01-01T00:00:00.000Z", revokedAt: null },
      { ...base, id: "gone", expiresAt: null, revokedAt: "2026-09-17T00:00:00.000Z" },
      { ...base, id: "old", expiresAt: "2026-09-01T00:00:00.000Z", revokedAt: null },
      { ...base, id: "orphan", expiresAt: null, revokedAt: null, parentSessionId: "gone" },
    ], now).map((s) => s.id)).toEqual(["a", "b", "orphan"]);
    expect(activePairedPhones(undefined, now)).toEqual([]);
  });

  it("「在 App 開啟」 links only work on this PC", () => {
    expect(runAppLinksWorkHere("127.0.0.1")).toBe(true);
    expect(runAppLinksWorkHere("localhost")).toBe(true);
    expect(runAppLinksWorkHere("100.64.0.1")).toBe(false);
    expect(runAppLinksWorkHere("192.168.50.5")).toBe(false);
  });

  it("Tailscale store links are the official pages", () => {
    expect(TAILSCALE_APP_STORE_URL).toBe("https://apps.apple.com/app/tailscale/id1470499037");
    expect(TAILSCALE_GOOGLE_PLAY_URL).toBe("https://play.google.com/store/apps/details?id=com.tailscale.ipn");
  });
});

function phoneApi(overrides: Record<string, unknown> = {}) {
  const session = { session: { id: "s1", deviceLabel: "iPhone", expiresAt: "2099-01-01T00:00:00.000Z" }, csrfToken: "csrf", handoffToken: HANDOFF, handoffExpiresAt: "2099-01-01T00:00:00.000Z" };
  return {
    inspect: vi.fn(),
    setEnabled: vi.fn(),
    createChallenge: vi.fn(),
    approveChallenge: vi.fn(),
    revokeChallenge: vi.fn(async () => ({ challengeId: CHALLENGE_ID, revoked: true })),
    completePairing: vi.fn(async () => session),
    completePairingWithShortCode: vi.fn(async () => session),
    redeemHandoff: vi.fn(),
    reportHomeScreen: vi.fn(async () => ({ sessionId: "s1", homeScreenAt: "2026-09-17T00:00:00.000Z" })),
    tailscaleStatus: vi.fn(),
    listPairedDevices: vi.fn(async () => []),
    revokeDevice: vi.fn(),
    ...overrides,
  } as unknown as MobileAccessApi & Record<string, ReturnType<typeof vi.fn>>;
}

describe("phone pairing (PairingCompletion)", () => {
  it("inside an in-app browser the single-use secret is neither sent nor scrubbed", async () => {
    window.history.replaceState(null, "", `/#pair=${CHALLENGE_ID}.${SECRET}`);
    const api = phoneApi();
    render(<PairingCompletion api={api} userAgent={UA.fbIos} locationHref={`${PHONE_BASE}#pair=${CHALLENGE_ID}.${SECRET}`} />);
    expect(await screen.findByRole("heading", { name: "請用 Safari 或 Chrome 開啟這個網頁" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/LINE|Facebook|Instagram/i);
    expect(api.completePairing).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(`#pair=${CHALLENGE_ID}.${SECRET}`);
  });

  it("after pairing the address carries ?handoff= and the manifest start_url follows", async () => {
    const link = document.createElement("link");
    link.rel = "manifest";
    link.href = "manifest.webmanifest";
    document.head.append(link);
    window.history.replaceState(null, "", `/?view=board#pair=${CHALLENGE_ID}.${SECRET}`);
    const api = phoneApi();
    const onPaired = vi.fn();
    render(<PairingCompletion api={api} userAgent={UA.iosSafari17} locationHref={`${PHONE_BASE}?view=board#pair=${CHALLENGE_ID}.${SECRET}`} onPaired={onPaired} />);
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(window.location.hash).toBe("");
    expect(new URLSearchParams(window.location.search).get("handoff")).toBe(HANDOFF);
    expect(new URLSearchParams(window.location.search).get("view")).toBe("board");
    expect(link.getAttribute("href")).toBe(`manifest.webmanifest?handoff=${HANDOFF}`);
  });

  it("a failed handoff explains itself above the 6-digit entry, per context", () => {
    const { unmount } = render(<PairingCompletion api={phoneApi()} userAgent={UA.iosSafari17} locationHref={PHONE_BASE} pairingRequired handoffFailed="standalone" />);
    expect(screen.getByRole("alert").textContent).toContain("從主畫面開啟時沒有自動登入成功");
    expect(screen.getByRole("alert").textContent).toContain("在電腦開「連接手機」產生配對碼");
    expect(screen.getByLabelText("6 位數配對碼")).toBeTruthy();
    unmount();
    render(<PairingCompletion api={phoneApi()} userAgent={UA.iosSafari17} locationHref={PHONE_BASE} pairingRequired handoffFailed="browser" />);
    expect(screen.getByRole("alert").textContent).toContain("這個網址的自動登入已失效");
  });

  it("browser tab with ?handoff= and no session: nothing is used until 「在這個瀏覽器繼續」, which gets a fresh handoff", async () => {
    const NEXT = "N".repeat(43);
    window.history.replaceState(null, "", `/?handoff=${HANDOFF}`);
    const session = { session: { id: "tab", deviceLabel: "iPhone", expiresAt: null }, csrfToken: "csrf", handoffToken: NEXT, handoffExpiresAt: "2099-01-01T00:00:00.000Z" };
    const api = phoneApi({ redeemHandoff: vi.fn(async () => session) });
    const onPaired = vi.fn();
    render(<PairingCompletion api={api} userAgent={UA.iosSafari17} locationHref={`${PHONE_BASE}?handoff=${HANDOFF}`} pairingRequired pendingHandoff={HANDOFF} onPaired={onPaired} />);
    expect(screen.getByRole("heading", { name: "請從主畫面圖示開啟" })).toBeTruthy();
    expect(api.redeemHandoff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "在這個瀏覽器繼續" }));
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(api.redeemHandoff).toHaveBeenCalledWith(HANDOFF, false);
    expect(new URLSearchParams(window.location.search).get("handoff")).toBe(NEXT);
  });

  it("browser tab handoff choice: 6-digit instead, or a failed continue explains and drops the token", async () => {
    const { unmount } = render(<PairingCompletion api={phoneApi()} userAgent={UA.iosSafari17} locationHref={PHONE_BASE} pairingRequired pendingHandoff={HANDOFF} />);
    fireEvent.click(screen.getByRole("button", { name: "改輸入 6 位數配對碼" }));
    expect(screen.getByLabelText("6 位數配對碼")).toBeTruthy();
    unmount();

    window.history.replaceState(null, "", `/?handoff=${HANDOFF}`);
    const used = new ApiError(401, { error: { code: "PAIRING_HANDOFF_INVALID", message: "used" } });
    const api = phoneApi({ redeemHandoff: vi.fn(async () => { throw used; }) });
    render(<PairingCompletion api={api} userAgent={UA.iosSafari17} locationHref={`${PHONE_BASE}?handoff=${HANDOFF}`} pairingRequired pendingHandoff={HANDOFF} />);
    fireEvent.click(screen.getByRole("button", { name: "在這個瀏覽器繼續" }));
    expect((await screen.findByRole("alert")).textContent).toContain("這個網址的自動登入已失效");
    expect(window.location.search).toBe("");
  });
});

describe("phone startup (resolvePhoneSession)", () => {
  function startup(overrides: Partial<Parameters<typeof resolvePhoneSession>[0]> = {}) {
    let csrf = false;
    const calls = { refreshCsrf: 0, redeem: [] as Array<[string, boolean]>, replaced: [] as Array<string | null> };
    const base: Parameters<typeof resolvePhoneSession>[0] = {
      href: PHONE_BASE,
      standalone: false,
      storageFailed: false,
      hasCsrfToken: () => csrf,
      refreshCsrf: async () => { calls.refreshCsrf += 1; csrf = true; },
      redeemHandoff: async (token, standalone) => { calls.redeem.push([token, standalone]); },
      replaceHref: (next) => { calls.replaced.push(next); },
      ...overrides,
    };
    return { base, calls };
  }
  const withHandoff = `${PHONE_BASE}?handoff=${HANDOFF}`;
  const unauthorized = Object.assign(new Error("401"), { status: 401 });

  it("paired browser tab without CSRF: recovered from the cookie, no re-pairing", async () => {
    const { base, calls } = startup();
    expect(await resolvePhoneSession(base)).toEqual({ redeemed: false, pairingRequired: false, handoffFailed: null, pendingHandoff: null, paused: false });
    expect(calls.refreshCsrf).toBe(1);
  });

  it("CSRF recovery refused with 401 → pair again; other refusals (LAN, access off) change nothing", async () => {
    const gone = startup({ refreshCsrf: async () => { throw unauthorized; } });
    expect((await resolvePhoneSession(gone.base)).pairingRequired).toBe(true);
    const lan = startup({ refreshCsrf: async () => { throw Object.assign(new Error("403"), { status: 403 }); } });
    expect((await resolvePhoneSession(lan.base)).pairingRequired).toBe(false);
  });

  it("home-screen app with a session: token removed from the address, not redeemed", async () => {
    const { base, calls } = startup({ href: withHandoff, standalone: true, hasCsrfToken: () => true });
    expect((await resolvePhoneSession(base)).redeemed).toBe(false);
    expect(calls.redeem).toEqual([]);
    expect(calls.replaced).toEqual([PHONE_BASE]);
  });

  it("home-screen app without a session: redeemed as standalone; failure asks for the code", async () => {
    const ok = startup({ href: withHandoff, standalone: true, storageFailed: true });
    expect(await resolvePhoneSession(ok.base)).toEqual({ redeemed: true, pairingRequired: false, handoffFailed: null, pendingHandoff: null, paused: false });
    expect(ok.calls.redeem).toEqual([[HANDOFF, true]]);
    const fail = startup({ href: withHandoff, standalone: true, storageFailed: true, redeemHandoff: async () => { throw unauthorized; } });
    expect(await resolvePhoneSession(fail.base)).toEqual({ redeemed: false, pairingRequired: true, handoffFailed: "standalone", pendingHandoff: null, paused: false });
    // Cookie copied but CSRF recovery says the session is gone: the handoff is used.
    const copied = startup({ href: withHandoff, standalone: true, refreshCsrf: async () => { throw unauthorized; } });
    expect((await resolvePhoneSession(copied.base)).redeemed).toBe(true);
  });

  it("browser tab without a session keeps the token for the user's choice; a paired tab keeps it for 加入主畫面", async () => {
    const lost = startup({ href: withHandoff, storageFailed: true });
    expect(await resolvePhoneSession(lost.base)).toEqual({ redeemed: false, pairingRequired: true, handoffFailed: null, pendingHandoff: HANDOFF, paused: false });
    expect(lost.calls.redeem).toEqual([]);
    expect(lost.calls.replaced).toEqual([]);
    const paired = startup({ href: withHandoff, hasCsrfToken: () => true });
    expect(await resolvePhoneSession(paired.base)).toEqual({ redeemed: false, pairingRequired: false, handoffFailed: null, pendingHandoff: null, paused: false });
    expect(paired.calls.replaced).toEqual([]);
  });

  it("no session and no token: pairing gate", async () => {
    const { base } = startup({ storageFailed: true });
    expect((await resolvePhoneSession(base)).pairingRequired).toBe(true);
  });

  it("mobile access paused on the PC: paused notice instead of pairing, nothing redeemed", async () => {
    const { base, calls } = startup({ href: withHandoff, standalone: true, storageFailed: true, availability: async () => ({ mobileAccess: "paused" }) });
    expect(await resolvePhoneSession(base)).toEqual({ redeemed: false, pairingRequired: true, handoffFailed: null, pendingHandoff: null, paused: true });
    expect(calls.redeem).toEqual([]);
    const unknown = startup({ storageFailed: true, availability: async () => { throw new Error("offline"); } });
    expect((await resolvePhoneSession(unknown.base)).paused).toBe(false);
  });
});

describe("paused phone access (PairingCompletion)", () => {
  it("shows 「電腦已暫停手機存取」 instead of the 6-digit entry", () => {
    render(<PairingCompletion api={phoneApi()} userAgent={UA.iosSafari17} locationHref={PHONE_BASE} pairingRequired paused />);
    expect(screen.getByRole("heading", { name: "電腦已暫停手機存取" })).toBeTruthy();
    expect(screen.queryByLabelText("6 位數配對碼")).toBeNull();
  });

  it("a pairing call refused with MOBILE_ACCESS_DISABLED switches to the paused notice", async () => {
    const off = new ApiError(403, { error: { code: "MOBILE_ACCESS_DISABLED", message: "off" } });
    const api = phoneApi({ completePairingWithShortCode: vi.fn(async () => { throw off; }) });
    render(<PairingCompletion api={api} userAgent={UA.iosSafari17} locationHref={PHONE_BASE} pairingRequired />);
    fireEvent.change(screen.getByLabelText("6 位數配對碼"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "完成配對" }));
    expect(await screen.findByRole("heading", { name: "電腦已暫停手機存取" })).toBeTruthy();
  });
});

describe("phone onboarding UI", () => {
  it("in-app browser notice: generic text only (no app names); LINE is still sent out once silently", () => {
    const redirect = vi.fn();
    const { unmount } = render(<InAppBrowserNotice browser="line" userAgent={UA.lineAndroid} href={PHONE_BASE} redirect={redirect} />);
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith(`${PHONE_BASE}?openExternalBrowser=1`);
    expect(screen.getByRole("alert").textContent).toBe("請用 Safari 或 Chrome 開啟這個網頁");
    expect(screen.getByRole("button", { name: "複製網址" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/LINE|Facebook|Instagram/i);
    unmount();
    render(<InAppBrowserNotice browser="instagram" userAgent={UA.instagram} href={PHONE_BASE} redirect={redirect} />);
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toBe("請用 Safari 或 Chrome 開啟這個網頁");
    expect(document.body.textContent).not.toMatch(/LINE|Facebook|Instagram/i);
  });

  it("home-screen guides: iOS Safari, iOS 26 and Android Chrome", () => {
    const { container, unmount } = render(<HomeScreenGuideDialog justPaired userAgent={UA.iosSafari17} maxTouchPoints={0} onAdded={() => {}} onLater={() => {}} />);
    expect(screen.getByRole("status").textContent).toBe("✓ 配對完成");
    expect(screen.getByText(/分享」按鈕/)).toBeTruthy();
    expect(screen.getByText("往下滑，點「加入主畫面」")).toBeTruthy();
    expect(container.querySelector(".phone-guide-arrow.is-bottom-center")).toBeTruthy();
    unmount();

    const ios26 = render(<HomeScreenGuideDialog justPaired={false} userAgent={UA.iosSafari26} maxTouchPoints={0} onAdded={() => {}} onLater={() => {}} />);
    expect(screen.queryByText("✓ 配對完成")).toBeNull();
    expect(screen.getByText("確認「以 Web App 開啟」是開啟的，再點「加入」")).toBeTruthy();
    expect(ios26.container.querySelector(".phone-guide-arrow.is-bottom-right")).toBeTruthy();
    ios26.unmount();

    const android = render(<HomeScreenGuideDialog justPaired={false} userAgent={UA.androidChrome} maxTouchPoints={0} onAdded={() => {}} onLater={() => {}} />);
    expect(screen.getByText("點右上角的「⋮」選單")).toBeTruthy();
    expect(screen.getByText("點「加到主畫面」")).toBeTruthy();
    expect(android.container.querySelector(".phone-guide-arrow.is-top-right")).toBeTruthy();
  });

  it("tips: one at a time, skippable, not shown again", () => {
    const onDone = vi.fn();
    render(<PhoneBoardTips onDone={onDone} />);
    expect(PHONE_TIPS.length).toBeLessThanOrEqual(3);
    expect(screen.getByText("看狀態")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.getByText("點卡片能做什麼")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.getByText(/Tailscale 開關是開的/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "略過" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("just paired in a browser: guide, 「稍後再說」 → dismissible hint bar; tips stay behind the guide", () => {
    const api = phoneApi();
    const { rerender } = render(
      <PhoneOnboarding paired justPaired onJustPairedSeen={() => {}} mobileBoard api={api} standalone={false} userAgent={UA.iosSafari17} />,
    );
    expect(screen.getByText("✓ 配對完成")).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "稍後再說" }));
    expect(window.localStorage.getItem(PHONE_STORAGE_KEYS.homeScreenSkipped)).toBe("1");
    expect(screen.getByText("把看板加到主畫面，下次一點就開")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "略過" }));
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "怎麼加" }));
    expect(screen.getByRole("dialog", { name: "加入主畫面" })).toBeTruthy();
    expect(screen.queryByText("✓ 配對完成")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "稍後再說" }));
    fireEvent.click(screen.getByRole("button", { name: "關閉提示" }));
    expect(screen.queryByText("把看板加到主畫面，下次一點就開")).toBeNull();
    rerender(<PhoneOnboarding paired justPaired={false} onJustPairedSeen={() => {}} mobileBoard api={api} standalone={false} userAgent={UA.iosSafari17} />);
    expect(screen.queryByText("把看板加到主畫面，下次一點就開")).toBeNull();
    expect(api.reportHomeScreen).not.toHaveBeenCalled();
  });

  it("standalone and paired: reports 「已加到主畫面」 once, no hint bar", async () => {
    window.localStorage.setItem(PHONE_STORAGE_KEYS.homeScreenSkipped, "1");
    const api = phoneApi();
    const { rerender } = render(<PhoneOnboarding paired justPaired={false} onJustPairedSeen={() => {}} mobileBoard api={api} standalone userAgent={UA.iosSafari17} />);
    await waitFor(() => expect(api.reportHomeScreen).toHaveBeenCalledTimes(1));
    rerender(<PhoneOnboarding paired justPaired={false} onJustPairedSeen={() => {}} mobileBoard api={api} standalone userAgent={UA.iosSafari17} />);
    expect(api.reportHomeScreen).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("把看板加到主畫面，下次一點就開")).toBeNull();
    expect(screen.getByText("看狀態")).toBeTruthy();
  });

  it("hint bar also on tablets / landscape (wider than the mobile board), not on desktop browsers", () => {
    window.localStorage.setItem(PHONE_STORAGE_KEYS.homeScreenSkipped, "1");
    window.localStorage.setItem(PHONE_STORAGE_KEYS.tipsDone, "1");
    const api = phoneApi();
    const { unmount } = render(<PhoneOnboarding paired justPaired={false} onJustPairedSeen={() => {}} mobileBoard={false} api={api} standalone={false} userAgent={UA.iosSafari17} />);
    expect(screen.getByText("把看板加到主畫面，下次一點就開")).toBeTruthy();
    unmount();
    render(<PhoneOnboarding paired justPaired={false} onJustPairedSeen={() => {}} mobileBoard={false} api={api} standalone={false} userAgent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/139.0 Safari/537.36" />);
    expect(screen.queryByText("把看板加到主畫面，下次一點就開")).toBeNull();
  });

  it("unpaired: nothing is shown and nothing is reported", () => {
    const api = phoneApi();
    const { container } = render(<PhoneOnboarding paired={false} justPaired={false} onJustPairedSeen={() => {}} mobileBoard api={api} standalone userAgent={UA.iosSafari17} />);
    expect(container.innerHTML).toBe("");
    expect(api.reportHomeScreen).not.toHaveBeenCalled();
  });
});

describe("desktop phone-setup wizard", () => {
  const FUTURE = "2099-01-01T00:00:00.000Z";
  const enabledUrl = "http://100.64.0.9:47833/";

  type Peer = { id: string; hostName: string; os: string; online: boolean };
  function desktopApi({ tailscaleMissing = false, initialPeers = [{ id: "ipad", hostName: "iPad", os: "iOS", online: true }] as Peer[] } = {}) {
    let inspection: Record<string, unknown> = tailscaleMissing
      ? { enabled: false, url: null, tailnetAddress: null, reason: "TAILSCALE_NOT_FOUND", sessions: [], pendingChallenges: [] }
      : { enabled: false, url: null, tailnetAddress: "100.64.0.9", sessions: [{ id: "old", deviceLabel: "old", expiresAt: FUTURE, revokedAt: "2026-09-16T00:00:00.000Z", createdAt: "", lastSeenAt: "" }], pendingChallenges: [] };
    let peers: Peer[] = initialPeers;
    const api = {
      inspect: vi.fn(async () => inspection),
      setEnabled: vi.fn(async () => {
        inspection = { ...inspection, enabled: true, url: enabledUrl };
        return inspection;
      }),
      createChallenge: vi.fn(async () => ({ challengeId: CHALLENGE_ID, challengeCode: SECRET, shortCode: "482913", deviceLabel: "我的手機", expiresAt: new Date(Date.now() + 300_000).toISOString(), approved: false, approvedAt: null })),
      approveChallenge: vi.fn(async () => ({ challengeId: CHALLENGE_ID, deviceLabel: "我的手機", expiresAt: new Date(Date.now() + 300_000).toISOString(), approvedAt: new Date().toISOString() })),
      revokeChallenge: vi.fn(async () => ({ challengeId: CHALLENGE_ID, revoked: true })),
      tailscaleStatus: vi.fn(async () => ({ installed: true, running: true, loginName: "alice@example.com", tailnetAddress: "100.64.0.9", mobilePeers: peers })),
    } as unknown as MobileAccessApi & Record<string, ReturnType<typeof vi.fn>>;
    return {
      api,
      setInspection(next: Record<string, unknown>) { inspection = { ...inspection, ...next }; },
      setPeers(next: typeof peers) { peers = next; },
    };
  }

  function fakeEvents() {
    const listeners: Array<() => void> = [];
    return {
      factory: () => ({
        addEventListener: (_type: string, listener: () => void) => { listeners.push(listener); },
        close: () => {},
      }),
      fire: () => listeners.forEach((listener) => listener()),
    };
  }

  it("walks start → install (store QRs) → sign-in (auto tick on a new phone) → explicit consent → QR + code with live progress", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const env = desktopApi({ initialPeers: [{ id: "ipad", hostName: "iPad", os: "iOS", online: false }] });
    const events = fakeEvents();
    const onClose = vi.fn();
    render(<PhoneSetupWizard api={env.api} onClose={onClose} eventSourceFactory={events.factory} />);
    expect(screen.getByRole("heading", { name: "用手機看看板" })).toBeTruthy();
    const start = screen.getByRole("button", { name: "開始" }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);

    expect(screen.getByRole("heading", { name: "在手機安裝 Tailscale" })).toBeTruthy();
    expect(screen.getByAltText("iPhone：App Store 的 Tailscale")).toBeTruthy();
    expect(screen.getByAltText("Android：Google Play 的 Tailscale")).toBeTruthy();
    expect(screen.getByText(/允許加入 VPN 設定/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "手機已裝好，下一步" }));

    expect(await screen.findByText(/alice@example.com/)).toBeTruthy();
    expect(screen.getByText("正在等待手機上線…")).toBeTruthy();
    env.setPeers([{ id: "ipad", hostName: "iPad", os: "iOS", online: false }, { id: "phone", hostName: "iPhone-15", os: "iOS", online: true }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(await screen.findByText("已偵測到你的手機：iPhone-15")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });

    expect(await screen.findByRole("heading", { name: "開啟手機存取" })).toBeTruthy();
    expect(env.api.setEnabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "同意開啟手機存取" }));
    await waitFor(() => expect(env.api.setEnabled).toHaveBeenCalledWith(true));
    expect(await screen.findByRole("heading", { name: "用手機相機掃描配對" })).toBeTruthy();
    expect(env.api.approveChallenge).toHaveBeenCalledWith(CHALLENGE_ID);
    expect(screen.getByLabelText("6 位數配對碼").textContent).toBe("482913");
    expect(screen.getByAltText("配對 QR 碼")).toBeTruthy();
    expect(screen.getByText("請用手機內建的相機 App 掃描，手機會自動完成配對。")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/LINE/);
    const checks = () => Array.from(document.querySelectorAll(".phone-wizard-checks li")).map((item) => item.classList.contains("is-done"));
    expect(checks()).toEqual([false, false]);

    env.setInspection({ sessions: [
      { id: "old", deviceLabel: "old", expiresAt: FUTURE, revokedAt: "2026-09-16T00:00:00.000Z", createdAt: "", lastSeenAt: "" },
      { id: "new", deviceLabel: "我的手機", expiresAt: FUTURE, revokedAt: null, createdAt: "", lastSeenAt: "", homeScreenAt: null },
    ] });
    await act(async () => { events.fire(); });
    await waitFor(() => expect(checks()).toEqual([true, false]));
    expect(screen.queryByAltText("配對 QR 碼")).toBeNull();
    env.setInspection({ sessions: [
      { id: "new", deviceLabel: "我的手機", expiresAt: FUTURE, revokedAt: null, createdAt: "", lastSeenAt: "", homeScreenAt: "2026-09-17T00:00:00.000Z" },
    ] });
    await act(async () => { events.fire(); });
    await waitFor(() => expect(checks()).toEqual([true, true]));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("a phone that joins the tailnet during the install step (before step ③) is still auto-detected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const env = desktopApi({ initialPeers: [{ id: "ipad", hostName: "iPad", os: "iOS", online: false }] });
    render(<PhoneSetupWizard api={env.api} onClose={() => {}} eventSourceFactory={null} />);
    const start = screen.getByRole("button", { name: "開始" }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    await waitFor(() => expect(env.api.tailscaleStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(start);
    // The user signs in on the phone while still on 「在手機安裝 Tailscale」.
    env.setPeers([{ id: "ipad", hostName: "iPad", os: "iOS", online: false }, { id: "phone", hostName: "iPhone-15", os: "iOS", online: true }]);
    fireEvent.click(screen.getByRole("button", { name: "手機已裝好，下一步" }));
    expect(await screen.findByText("已偵測到你的手機：iPhone-15")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(await screen.findByRole("heading", { name: "開啟手機存取" })).toBeTruthy();
  });

  it("a phone of this account already online when the wizard opens ticks step ③ at once and advances", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const env = desktopApi({ initialPeers: [{ id: "phone", hostName: "iPhone-15", os: "iOS", online: true }] });
    render(<PhoneSetupWizard api={env.api} onClose={() => {}} eventSourceFactory={null} />);
    const start = screen.getByRole("button", { name: "開始" }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    fireEvent.click(screen.getByRole("button", { name: "手機已裝好，下一步" }));
    expect(await screen.findByText("已偵測到你的手機：iPhone-15")).toBeTruthy();
    expect(screen.queryByText("正在等待手機上線…")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(await screen.findByRole("heading", { name: "開啟手機存取" })).toBeTruthy();
  });

  it("an already online iPad or unknown-OS peer does not tick step ③; an unknown-OS peer that comes online does", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const env = desktopApi({ initialPeers: [
      { id: "ipad", hostName: "Alice-iPad", os: "iOS", online: true },
      { id: "n8", hostName: "some-device", os: "", online: true },
      { id: "n9", hostName: "my-phone", os: "", online: false },
    ] });
    render(<PhoneSetupWizard api={env.api} onClose={() => {}} initialStep="phone-signin" eventSourceFactory={null} />);
    expect(await screen.findByText("正在等待手機上線…")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    expect(screen.queryByText(/已偵測到你的手機/)).toBeNull();
    env.setPeers([
      { id: "ipad", hostName: "Alice-iPad", os: "iOS", online: true },
      { id: "n8", hostName: "some-device", os: "", online: true },
      { id: "n9", hostName: "my-phone", os: "", online: true },
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    expect(await screen.findByText("已偵測到你的手機：my-phone")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(await screen.findByRole("heading", { name: "開啟手機存取" })).toBeTruthy();
  });

  it("after 10 s of waiting, explains that a signed-in phone can continue with 「下一步」", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const env = desktopApi({ initialPeers: [] });
    render(<PhoneSetupWizard api={env.api} onClose={() => {}} initialStep="phone-signin" eventSourceFactory={null} />);
    expect(await screen.findByText("正在等待手機上線…")).toBeTruthy();
    const hint = "如果手機已經登入，按「下一步」繼續。";
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(screen.queryByText(hint)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByText(hint)).toBeTruthy();
    expect(screen.getByText("正在等待手機上線…")).toBeTruthy();
    const next = screen.getByRole("button", { name: "下一步" }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(await screen.findByRole("heading", { name: "開啟手機存取" })).toBeTruthy();
  });

  it("「稍後」 closes without enabling anything", async () => {
    const env = desktopApi();
    const onClose = vi.fn();
    render(<PhoneSetupWizard api={env.api} onClose={onClose} eventSourceFactory={null} />);
    fireEvent.click(screen.getByRole("button", { name: "稍後" }));
    expect(onClose).toHaveBeenCalledWith(false);
    expect(env.api.setEnabled).not.toHaveBeenCalled();
    expect(env.api.createChallenge).not.toHaveBeenCalled();
  });

  it("PC without Tailscale: install link, then continues on its own once Tailscale is detected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const env = desktopApi({ tailscaleMissing: true });
    render(<PhoneSetupWizard api={env.api} onClose={() => {}} eventSourceFactory={null} />);
    const start = screen.getByRole("button", { name: "開始" }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    expect(screen.getByRole("heading", { name: "先在這台電腦安裝 Tailscale" })).toBeTruthy();
    expect((screen.getByRole("link", { name: "下載 Tailscale（官方網站）" }) as HTMLAnchorElement).href).toBe("https://tailscale.com/download");
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(screen.getByRole("heading", { name: "先在這台電腦安裝 Tailscale" })).toBeTruthy();
    env.setInspection({ reason: undefined, tailnetAddress: "100.64.0.9" });
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(await screen.findByRole("heading", { name: "在手機安裝 Tailscale" })).toBeTruthy();
    expect(env.api.setEnabled).not.toHaveBeenCalled();
  });

  it("sign-in step falls back to a manual 「下一步」 when detection is unavailable; mobile access already on skips consent text", async () => {
    const env = desktopApi();
    env.setInspection({ enabled: true, url: enabledUrl });
    (env.api.tailscaleStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(404, { error: { code: "NOT_FOUND", message: "no" } }));
    render(<PhoneSetupWizard api={env.api} onClose={() => {}} initialStep="phone-signin" eventSourceFactory={null} />);
    expect(await screen.findByText("無法自動偵測，登入好後請按「下一步」。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(await screen.findByText("手機存取已經開啟。接著產生配對 QR 碼。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "產生配對 QR 碼" }));
    expect(await screen.findByRole("heading", { name: "用手機相機掃描配對" })).toBeTruthy();
    expect(env.api.setEnabled).not.toHaveBeenCalled();
  });

  it("opened while a phone is paired (permanent pairing): shows 「已連接 1 支手機」 instead of the first-time page", async () => {
    const env = desktopApi();
    env.setInspection({ enabled: true, url: enabledUrl, sessions: [
      { id: "p", deviceLabel: "我的手機", expiresAt: null, revokedAt: null, createdAt: "2026-09-17T08:18:09.579Z", lastSeenAt: "2026-09-17T08:50:28.921Z", homeScreenAt: "2026-09-17T08:20:07.843Z", parentSessionId: null },
    ] });
    const onClose = vi.fn();
    const onOpenSettings = vi.fn();
    render(<PhoneSetupWizard api={env.api} onClose={onClose} onOpenSettings={onOpenSettings} eventSourceFactory={null} />);
    expect(await screen.findByRole("heading", { name: "已連接 1 支手機" })).toBeTruthy();
    expect(screen.getByText("我的手機")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "用手機看看板" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "手機存取設定" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "再連接一支手機" }));
    expect(screen.getByRole("heading", { name: "在手機安裝 Tailscale" })).toBeTruthy();
    expect(env.api.setEnabled).not.toHaveBeenCalled();
  });
});

describe("desktop header phone button", () => {
  function PhoneButtonHarness({ api }: { api: MobileAccessApi }) {
    const paired = usePairedPhones(true, api);
    return (
      <>
        <HeaderPhoneButton pairedCount={paired.phones?.length ?? 0} onClick={() => {}} />
        <button type="button" onClick={() => void paired.refresh()}>refresh</button>
      </>
    );
  }

  it("says 「連接手機」 without a phone and 「已連接 1 支手機」 with the permanent pairing; follows removal", async () => {
    let sessions: unknown[] = [];
    const api = { inspect: vi.fn(async () => ({ enabled: true, url: "http://100.64.0.9:47833/", tailnetAddress: "100.64.0.9", pairing: "unpaired", sessions, pendingChallenges: [] })) } as unknown as MobileAccessApi;
    render(<PhoneButtonHarness api={api} />);
    const button = () => document.querySelector(".header-phone-button") as HTMLButtonElement;
    expect(button().getAttribute("aria-label")).toBe("連接手機");
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => expect(api.inspect).toHaveBeenCalledTimes(1));
    expect(button().getAttribute("aria-label")).toBe("連接手機");
    expect(button().querySelector(".header-phone-badge")).toBeNull();

    const permanent = { id: "p", deviceLabel: "我的手機", expiresAt: null, revokedAt: null, createdAt: "2026-09-17T08:18:09.579Z", lastSeenAt: "2026-09-17T08:50:28.921Z", homeScreenAt: "2026-09-17T08:20:07.843Z", parentSessionId: null };
    sessions = [permanent];
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(button().getAttribute("aria-label")).toBe("已連接 1 支手機"));
    expect(button().title).toBe("已連接 1 支手機");
    expect(button().classList.contains("is-paired")).toBe(true);
    expect(button().querySelector(".header-phone-badge")).toBeTruthy();

    sessions = [{ ...permanent, revokedAt: "2026-09-17T09:00:00.000Z" }];
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => expect(button().getAttribute("aria-label")).toBe("連接手機"));
  });
});
