// CONTRACTS Amendment 13 (W12-C), phone side: in-app browser notice, 「✓ 配對完成」 + add-to-home-screen guide,
// the dismissible hint bar, the home-screen (standalone) report and the 2–3 first-use tips.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTaskboardI18n } from "../i18n";
import { createMobileAccessApi, type MobileAccessApi } from "../mobileAccessApi";
import {
  PHONE_STORAGE_KEYS,
  detectPhonePlatform,
  homeScreenGuide,
  isStandaloneDisplay,
  lineExternalBrowserHref,
  readLocalFlag,
  writeLocalFlag,
  type HomeScreenGuide,
  type InAppBrowser,
} from "../phoneOnboarding";
import "./PhoneOnboarding.css";

const defaultApi = createMobileAccessApi();

function currentUserAgent(): string {
  try {
    return window.navigator.userAgent;
  } catch {
    return "";
  }
}

function currentTouchPoints(): number {
  try {
    return window.navigator.maxTouchPoints ?? 0;
  } catch {
    return 0;
  }
}

function GuideIcon({ icon }: { icon: HomeScreenGuide["icon"] }) {
  if (icon === "share") {
    return (
      <svg className="phone-guide-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8 10.5H6.5A1.5 1.5 0 0 0 5 12v7.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V12a1.5 1.5 0 0 0-1.5-1.5H16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (icon === "more-horizontal" || icon === "more-vertical") {
    const vertical = icon === "more-vertical";
    return (
      <svg className="phone-guide-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        {[6, 12, 18].map((position) => (
          <circle key={position} cx={vertical ? 12 : position} cy={vertical ? position : 12} r="1.9" fill="currentColor" />
        ))}
      </svg>
    );
  }
  return null;
}

function AddToHomeIcon() {
  return (
    <svg className="phone-guide-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="16" height="16" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 8.5v7M8.5 12h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * In-app browser (detected silently from the user agent): pairing here would leave the session inside that app, and
 * it cannot add to the home screen. The pairing secret is NOT used; the page only asks, without naming any app, to
 * open it in Safari or Chrome. Apps that honour openExternalBrowser=1 are sent to the default browser once.
 */
export function InAppBrowserNotice({
  userAgent = currentUserAgent(),
  href = window.location.href,
  redirect = (target: string) => window.location.replace(target),
}: {
  /** Which in-app browser was detected; never shown to the user. */
  browser: Exclude<InAppBrowser, null>;
  userAgent?: string;
  href?: string;
  redirect?: (target: string) => void;
}) {
  const { text } = useTaskboardI18n();
  const [copied, setCopied] = useState(false);
  const redirected = useRef(false);

  useEffect(() => {
    if (redirected.current) return;
    const target = lineExternalBrowserHref(href, userAgent);
    if (!target) return;
    redirected.current = true;
    redirect(target);
    // Once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const message = text("請用 Safari 或 Chrome 開啟這個網頁", "Please open this page in Safari or Chrome");
  const copy = () => {
    void navigator.clipboard?.writeText(href).then(() => setCopied(true), () => setCopied(false));
  };

  return (
    <div className="phone-onboarding-backdrop" role="dialog" aria-modal="true" aria-label={message}>
      <section className="phone-onboarding-card">
        <div role="alert"><h2>{message}</h2></div>
        <div className="phone-onboarding-actions">
          <button className="button primary" type="button" onClick={copy}>
            {copied ? text("已複製", "Copied") : text("複製網址", "Copy address")}
          </button>
        </div>
      </section>
    </div>
  );
}

/** Illustrated, platform-specific 「加入主畫面」 steps with an arrow toward the browser button. */
export function HomeScreenGuideDialog({
  justPaired,
  userAgent = currentUserAgent(),
  maxTouchPoints = currentTouchPoints(),
  onAdded,
  onLater,
}: {
  justPaired: boolean;
  userAgent?: string;
  maxTouchPoints?: number;
  onAdded: () => void;
  onLater: () => void;
}) {
  const { text } = useTaskboardI18n();
  const guide = homeScreenGuide(userAgent, maxTouchPoints);
  return (
    <div className="phone-onboarding-backdrop" role="dialog" aria-modal="true" aria-label={text("加入主畫面", "Add to Home Screen")} data-guide={guide.kind}>
      {justPaired && (
        <div className="phone-paired-banner" role="status">{text("✓ 配對完成", "✓ Paired")}</div>
      )}
      <section className="phone-onboarding-card">
        <h2>{text("把看板加到主畫面", "Add the board to your Home Screen")}</h2>
        <p>{text("加好之後，從主畫面圖示一點就開，像 App 一樣。", "Then open it from its Home Screen icon, like an app.")}</p>
        <ol className="phone-guide-steps">
          {guide.steps.map(([zh, en], index) => (
            <li key={zh}>
              <span className="phone-guide-step-number">{index + 1}</span>
              <span>{text(zh, en)}</span>
              {index === 0 && <GuideIcon icon={guide.icon} />}
              {index === 1 && guide.kind !== "unknown" && <AddToHomeIcon />}
            </li>
          ))}
        </ol>
        <p className="phone-onboarding-note">{text(
          "找不到「加入主畫面」？請用 Safari 或 Chrome 開啟這個網頁。",
          "Can't find “Add to Home Screen”? Please open this page in Safari or Chrome.",
        )}</p>
        <div className="phone-onboarding-actions">
          <button className="button secondary" type="button" onClick={onLater}>{text("稍後再說", "Later")}</button>
          <button className="button primary" type="button" onClick={onAdded}>{text("我已加好", "I added it")}</button>
        </div>
      </section>
      {guide.arrow !== "none" && (
        <div className={`phone-guide-arrow is-${guide.arrow}`} aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M12 3v16M5.5 12.5 12 19l6.5-6.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}
    </div>
  );
}

/** 2–3 contextual first-use tips, one at a time; 「略過」 ends them all. Not a multi-page tour. */
export const PHONE_TIPS: ReadonlyArray<{ title: readonly [string, string]; body: readonly [string, string] }> = [
  {
    title: ["看狀態", "See status"],
    body: ["上方可以切換欄位，看每張卡片現在是「待處理、進行中、待審」哪一種。", "Switch columns at the top to see which state each card is in."],
  },
  {
    title: ["點卡片能做什麼", "Tap a card"],
    body: ["點一下卡片可以看詳情、留言，或讓 AI 開工／停止。", "Tap a card to see details, comment, or start / stop the AI."],
  },
  {
    title: ["打不開時", "If it won't open"],
    body: ["之後看板打不開，先確認手機的 Tailscale 開關是開的，電腦也開著。", "If the board won't open later, first check that Tailscale is on on the phone and the PC is on."],
  },
];

export function PhoneBoardTips({ onDone }: { onDone: () => void }) {
  const { text } = useTaskboardI18n();
  const [index, setIndex] = useState(0);
  const tip = PHONE_TIPS[index];
  const last = index === PHONE_TIPS.length - 1;
  return (
    <aside className="phone-tip" role="note" aria-label={text("使用提示", "Tip")}>
      <div className="phone-tip-head">
        <strong>{text(tip.title[0], tip.title[1])}</strong>
        <span>{`${index + 1} / ${PHONE_TIPS.length}`}</span>
      </div>
      <p>{text(tip.body[0], tip.body[1])}</p>
      <div className="phone-tip-actions">
        {!last && <button className="button secondary" type="button" onClick={onDone}>{text("略過", "Skip")}</button>}
        <button className="button primary" type="button" onClick={() => (last ? onDone() : setIndex(index + 1))}>
          {text("知道了", "Got it")}
        </button>
      </div>
    </aside>
  );
}

/** Top hint bar in browser mode after the user skipped adding to the Home Screen. */
export function HomeScreenHintBar({ onShowGuide, onDismiss }: { onShowGuide: () => void; onDismiss: () => void }) {
  const { text } = useTaskboardI18n();
  return (
    <div className="phone-hint-bar" role="status">
      <span>{text("把看板加到主畫面，下次一點就開", "Add the board to your Home Screen to open it in one tap")}</span>
      <button className="phone-hint-bar-link" type="button" onClick={onShowGuide}>{text("怎麼加", "How")}</button>
      <button className="phone-hint-bar-close" type="button" aria-label={text("關閉提示", "Dismiss")} onClick={onDismiss}>×</button>
    </div>
  );
}

/**
 * Phone-side orchestrator (mounted by App when the page is not served from this PC).
 * - just paired in a browser → 「✓ 配對完成」 + home-screen guide (「我已加好」 / 「稍後再說」)
 * - skipped earlier, browser mode, mobile board → dismissible hint bar
 * - running standalone while paired → report to the PC once per launch (wizard ticks 「已加到主畫面」)
 * - paired, nothing else on screen, mobile board → first-use tips (once)
 */
export function PhoneOnboarding({
  paired,
  justPaired,
  onJustPairedSeen,
  mobileBoard,
  api = defaultApi,
  standalone = isStandaloneDisplay(),
  userAgent = currentUserAgent(),
  hintBarSlot = null,
}: {
  /** Element at the top of the board (in the page flow) that hosts the hint bar; rendered in place when null. */
  hintBarSlot?: HTMLElement | null;
  paired: boolean;
  justPaired: boolean;
  onJustPairedSeen: () => void;
  mobileBoard: boolean;
  api?: MobileAccessApi;
  standalone?: boolean;
  userAgent?: string;
}) {
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideAfterPairing, setGuideAfterPairing] = useState(false);
  const [skipped, setSkipped] = useState(() => readLocalFlag(PHONE_STORAGE_KEYS.homeScreenSkipped));
  const [hintDismissed, setHintDismissed] = useState(() => readLocalFlag(PHONE_STORAGE_KEYS.homeScreenHintDismissed));
  const [tipsDone, setTipsDone] = useState(() => readLocalFlag(PHONE_STORAGE_KEYS.tipsDone));
  const [pairedBanner, setPairedBanner] = useState(false);
  const reported = useRef(false);

  useEffect(() => {
    if (!justPaired) return;
    onJustPairedSeen();
    if (standalone) {
      setPairedBanner(true);
      const timer = window.setTimeout(() => setPairedBanner(false), 2500);
      return () => window.clearTimeout(timer);
    }
    setGuideAfterPairing(true);
    setGuideOpen(true);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justPaired]);

  useEffect(() => {
    if (!paired || !standalone || reported.current) return;
    reported.current = true;
    void api.reportHomeScreen().catch(() => {
      // Best effort: the PC wizard simply does not tick; nothing to show on the phone.
    });
  }, [api, paired, standalone]);

  const { text } = useTaskboardI18n();
  const closeGuide = (added: boolean) => {
    setGuideOpen(false);
    setGuideAfterPairing(false);
    if (added) {
      writeLocalFlag(PHONE_STORAGE_KEYS.homeScreenSkipped, false);
      setSkipped(false);
    } else {
      writeLocalFlag(PHONE_STORAGE_KEYS.homeScreenSkipped, true);
      setSkipped(true);
    }
  };

  if (!paired) return null;
  if (guideOpen && !standalone) {
    return (
      <HomeScreenGuideDialog
        justPaired={guideAfterPairing}
        userAgent={userAgent}
        onAdded={() => closeGuide(true)}
        onLater={() => closeGuide(false)}
      />
    );
  }
  // Phones and tablets (also wider than the mobile board layout, e.g. iPad or a phone in landscape).
  const touchDevice = mobileBoard || detectPhonePlatform(userAgent, currentTouchPoints()) !== "other";
  const showHint = touchDevice && !standalone && skipped && !hintDismissed;
  const showTips = mobileBoard && !tipsDone;
  return (
    <>
      {pairedBanner && <div className="phone-paired-toast" role="status">{text("✓ 配對完成", "✓ Paired")}</div>}
      {showHint && (() => {
        const bar = (
          <HomeScreenHintBar
            onShowGuide={() => setGuideOpen(true)}
            onDismiss={() => {
              writeLocalFlag(PHONE_STORAGE_KEYS.homeScreenHintDismissed, true);
              setHintDismissed(true);
            }}
          />
        );
        return hintBarSlot ? createPortal(bar, hintBarSlot) : bar;
      })()}
      {showTips && (
        <PhoneBoardTips
          onDone={() => {
            writeLocalFlag(PHONE_STORAGE_KEYS.tipsDone, true);
            setTipsDone(true);
          }}
        />
      )}
    </>
  );
}
