// CONTRACTS Amendment 13 (W12-C), desktop side: 「連接手機」 wizard.
// start → (install Tailscale on this PC) → install Tailscale on the phone → sign in with the same account
// → explicit 「同意開啟手機存取」 → pairing QR + 6-digit code with live progress.
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, resolveTaskboardUrl } from "../api";
import { useTaskboardI18n } from "../i18n";
import {
  createMobileAccessApi,
  type MobileAccessApi,
  type PairingChallenge,
  type TailscaleStatus,
} from "../mobileAccessApi";
import { createPairingQrDataUrl } from "../mobilePairingQr.mjs";
import {
  TAILSCALE_APP_STORE_URL,
  TAILSCALE_DOWNLOAD_URL,
  TAILSCALE_GOOGLE_PLAY_URL,
  activePairedPhones,
  newlyOnlinePeer,
  onlinePhonePeer,
  shareableLink,
  wizardProgress,
  type TailscaleMobilePeer,
} from "../phoneOnboarding";
import { pairingLink, stageOf, type MobileAccessInspectionDetails } from "./MobileAccessSettings";
import "./PhoneOnboarding.css";

const defaultApi = createMobileAccessApi();
const POLL_MS = 3000;
const PROGRESS_POLL_MS = 5000;
const AUTO_ADVANCE_MS = 1500;
const SLOW_WAIT_MS = 10_000;
const MOBILE_ACCESS_EVENT = "mobile-access.updated";

/** The part of EventSource the wizard uses (injectable in tests). */
export interface WizardEventSource {
  addEventListener(type: string, listener: () => void): void;
  close(): void;
}

export type PhoneWizardStep = "start" | "pc-tailscale" | "phone-install" | "phone-signin" | "consent" | "pair";
const STEPPER: PhoneWizardStep[] = ["start", "phone-install", "phone-signin", "consent", "pair"];

function qr(link: string): string | null {
  try {
    return createPairingQrDataUrl(link);
  } catch {
    return null;
  }
}

function remaining(expiresAt: string, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - nowMs) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function useInterval(callback: () => void, delayMs: number | null) {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (delayMs === null) return;
    const timer = window.setInterval(() => saved.current(), delayMs);
    return () => window.clearInterval(timer);
  }, [delayMs]);
}

export function PhoneSetupWizard({
  api = defaultApi,
  onClose,
  onOpenSettings,
  initialStep = "start",
  eventSourceFactory = (url: string) => new EventSource(url),
}: {
  api?: MobileAccessApi;
  /** `finished` true after 「完成」; false for 「稍後」 / ×. */
  onClose: (finished: boolean) => void;
  /** Opens the full 「手機存取設定」 dialog (paired devices, revoke). */
  onOpenSettings?: () => void;
  initialStep?: PhoneWizardStep;
  eventSourceFactory?: ((url: string) => WizardEventSource) | null;
}) {
  const { text } = useTaskboardI18n();
  const [step, setStep] = useState<PhoneWizardStep>(initialStep);
  const [inspection, setInspection] = useState<MobileAccessInspectionDetails | null>(null);
  const [knownSessionIds, setKnownSessionIds] = useState<Set<string> | null>(null);
  const [tailscale, setTailscale] = useState<TailscaleStatus | null>(null);
  const [tailscaleUnavailable, setTailscaleUnavailable] = useState(false);
  const [baselineOnline, setBaselineOnline] = useState<Set<string> | null>(null);
  const [detectedPeer, setDetectedPeer] = useState<TailscaleMobilePeer | null>(null);
  const [challenge, setChallenge] = useState<PairingChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const mounted = useRef(true);
  const challengeRef = useRef<PairingChallenge | null>(null);
  challengeRef.current = challenge;

  const errorText = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : text("發生錯誤，請再試一次", "Something went wrong; try again"));

  const refresh = async () => {
    try {
      const next = await api.inspect() as MobileAccessInspectionDetails;
      if (!mounted.current) return null;
      setInspection(next);
      setKnownSessionIds((current) => current ?? new Set((next.sessions ?? []).map((session) => session.id)));
      return next;
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
      return null;
    }
  };

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // Baseline of phones already online, taken when the wizard opens (users often sign in on the phone during the
    // install step), so a phone that joins during steps ②–③ is still detected.
    void pollTailscale();
    return () => {
      mounted.current = false;
      // An unfinished pairing code must not outlive the wizard.
      const open = challengeRef.current;
      if (open) void api.revokeChallenge(open.challengeId).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stage = stageOf(inspection);
  // Amendment 15: phones already paired with this PC (permanent pairings included) are shown on the first page.
  const pairedPhones = useMemo(() => activePairedPhones(inspection?.sessions, nowMs), [inspection, nowMs]);
  const progress = useMemo(
    () => wizardProgress(inspection?.sessions, knownSessionIds ?? new Set(), nowMs),
    [inspection, knownSessionIds, nowMs],
  );

  // This PC has no Tailscale yet: poll until it shows up, then continue on its own.
  useInterval(() => {
    void refresh().then((next) => {
      if (next && stageOf(next) !== "tailscale-missing") setStep("phone-install");
    });
  }, step === "pc-tailscale" ? POLL_MS : null);

  // Sign-in step: watch for a phone that comes online in the tailnet.
  const pollTailscale = async () => {
    try {
      const status = await api.tailscaleStatus();
      if (!mounted.current) return;
      setTailscale(status);
      // The baseline is taken from the first status while Tailscale runs on this PC.
      if (status.running) {
        setBaselineOnline((current) => current ?? new Set(status.mobilePeers.filter((peer) => peer.online).map((peer) => peer.id)));
      }
    } catch (cause) {
      if (mounted.current && cause instanceof ApiError && cause.status === 404) setTailscaleUnavailable(true);
    }
  };
  useEffect(() => {
    if (step === "phone-signin") void pollTailscale();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  useInterval(() => void pollTailscale(), step === "phone-signin" && !detectedPeer && !tailscaleUnavailable ? POLL_MS : null);
  // Before step ③ keep trying to take the baseline (e.g. Tailscale was installed on this PC during the wizard).
  useInterval(
    () => void pollTailscale(),
    (step === "pc-tailscale" || step === "phone-install") && !baselineOnline && !tailscaleUnavailable ? POLL_MS : null,
  );
  useEffect(() => {
    if (step !== "phone-signin" || detectedPeer || !tailscale) return;
    // A peer that newly came online since the wizard opened counts (any listed OS); otherwise a peer that
    // is clearly a phone (iOS / android, not a tablet) counts even if it was already online. An already
    // online tablet or unknown-OS peer never ticks by itself (「下一步」 stays available).
    const peer = (baselineOnline && newlyOnlinePeer(tailscale.mobilePeers, baselineOnline))
      || onlinePhonePeer(tailscale.mobilePeers);
    if (peer) setDetectedPeer(peer);
  }, [step, tailscale, baselineOnline, detectedPeer]);
  // Still waiting after a while: tell the user a signed-in phone can simply continue with 「下一步」.
  const [slowWait, setSlowWait] = useState(false);
  useEffect(() => {
    if (step !== "phone-signin") setSlowWait(false);
  }, [step]);
  useEffect(() => {
    if (step !== "phone-signin" || detectedPeer || tailscaleUnavailable) return;
    const timer = window.setTimeout(() => {
      if (mounted.current) setSlowWait(true);
    }, SLOW_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [step, detectedPeer, tailscaleUnavailable]);
  useEffect(() => {
    if (step !== "phone-signin" || !detectedPeer) return;
    const timer = window.setTimeout(() => {
      if (mounted.current) setStep("consent");
    }, AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [step, detectedPeer]);

  // Pair step: live progress through the event stream, with a slow poll as a fallback; clock for the countdown.
  useEffect(() => {
    if (step !== "pair" || !eventSourceFactory) return;
    let source: WizardEventSource | null = null;
    try {
      source = eventSourceFactory(resolveTaskboardUrl("/api/events"));
      source.addEventListener(MOBILE_ACCESS_EVENT, () => void refresh());
    } catch {
      source = null;
    }
    return () => source?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  useInterval(() => void refresh(), step === "pair" ? PROGRESS_POLL_MS : null);
  useInterval(() => setNowMs(Date.now()), step === "pair" ? 1000 : null);

  const createPairingCode = async () => {
    setBusy(true);
    setError(null);
    const previous = challengeRef.current;
    try {
      const created = await api.createChallenge(text("我的手機", "My phone"));
      const approval = await api.approveChallenge(created.challengeId);
      if (!mounted.current) return;
      setChallenge({ ...created, approved: true, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt });
      setNowMs(Date.now());
      setStep("pair");
      if (previous) void api.revokeChallenge(previous.challengeId).catch(() => {});
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const consent = async () => {
    setBusy(true);
    setError(null);
    try {
      // The only place the wizard turns mobile access on: this explicit click.
      const next = await api.setEnabled(true) as MobileAccessInspectionDetails;
      if (!mounted.current) return;
      setInspection(next);
      if (stageOf(next) !== "enabled") {
        setError(text("找不到這台電腦的 Tailscale 位址，請確認 Tailscale 已登入並連線。", "This PC has no Tailscale address; make sure Tailscale is signed in and connected."));
        setBusy(false);
        return;
      }
    } catch (cause) {
      if (mounted.current) {
        setError(errorText(cause));
        setBusy(false);
      }
      return;
    }
    setBusy(false);
    await createPairingCode();
  };

  const start = () => setStep(stage === "tailscale-missing" ? "pc-tailscale" : "phone-install");

  const link = challenge && inspection?.url ? pairingLink(inspection.url, challenge.challengeId, challenge.challengeCode) : null;
  const expired = challenge ? Date.parse(challenge.expiresAt) <= nowMs : false;
  const pairQr = link && !expired ? qr(link) : null;
  const appStoreQr = useMemo(() => qr(TAILSCALE_APP_STORE_URL), []);
  const googlePlayQr = useMemo(() => qr(TAILSCALE_GOOGLE_PLAY_URL), []);
  const stepperIndex = STEPPER.indexOf(step === "pc-tailscale" ? "start" : step);

  const copyLink = () => {
    if (!link) return;
    void navigator.clipboard?.writeText(shareableLink(link)).then(() => {
      setCopied(true);
      window.setTimeout(() => mounted.current && setCopied(false), 1600);
    }, () => {});
  };

  const later = (
    <button className="button secondary" type="button" onClick={() => onClose(false)}>{text("稍後", "Later")}</button>
  );

  return (
    <div className="phone-wizard-backdrop no-drag" role="presentation">
      <section className="phone-wizard" role="dialog" aria-modal="true" aria-label={text("連接手機", "Connect a phone")} data-step={step}>
        <header>
          <div>
            <h2>{text("連接手機", "Connect a phone")}</h2>
          </div>
          <button className="icon-button" type="button" aria-label={text("關閉", "Close")} onClick={() => onClose(false)}>×</button>
        </header>
        <ol className="phone-wizard-stepper" aria-hidden="true">
          {STEPPER.map((name, index) => (
            <li key={name} className={index < stepperIndex ? "is-done" : index === stepperIndex ? "is-current" : ""} />
          ))}
        </ol>

        {step === "start" && pairedPhones.length > 0 && (
          <div>
            <h3>{text(`已連接 ${pairedPhones.length} 支手機`, pairedPhones.length === 1 ? "1 phone connected" : `${pairedPhones.length} phones connected`)}</h3>
            <ul className="phone-wizard-checks" aria-label={text("已配對的手機", "Paired phones")}>
              {pairedPhones.map((phone) => (
                <li key={phone.id} className="is-done">
                  <span className="phone-wizard-check" aria-hidden="true">✓</span>
                  <span>{phone.deviceLabel}</span>
                </li>
              ))}
            </ul>
            <p>{text("手機已經可以看這個看板。要移除手機，請到「手機存取設定」。", "Your phone can already use this board. To remove a phone, open Mobile access settings.")}</p>
            <div className="phone-wizard-actions">
              {onOpenSettings && (
                <button className="button secondary" type="button" onClick={onOpenSettings}>{text("手機存取設定", "Mobile access settings")}</button>
              )}
              <span className="phone-wizard-spacer" />
              <button className="button secondary" type="button" onClick={start}>{text("再連接一支手機", "Connect another phone")}</button>
              <button className="button primary" type="button" onClick={() => onClose(true)}>{text("關閉", "Close")}</button>
            </div>
          </div>
        )}

        {step === "start" && pairedPhones.length === 0 && (
          <div>
            <h3>{text("用手機看看板", "Use the board on your phone")}</h3>
            <p>{text(
              "大約 3 分鐘，讓你在手機上隨時看任務進度。需要：你的手機，以及和這台電腦同一個 Tailscale 帳號。",
              "About 3 minutes to follow your tasks from your phone. You need your phone and the same Tailscale account as this PC.",
            )}</p>
            <div className="phone-wizard-actions">
              {later}
              <button className="button primary" type="button" disabled={!inspection} onClick={start}>{text("開始", "Start")}</button>
            </div>
          </div>
        )}

        {step === "pc-tailscale" && (
          <div>
            <h3>{text("先在這台電腦安裝 Tailscale", "Install Tailscale on this PC first")}</h3>
            <p>{text(
              "手機要透過 Tailscale 私人網路連到這台電腦。請先安裝並登入 Tailscale，裝好後這裡會自動繼續。",
              "Your phone reaches this PC through your private Tailscale network. Install Tailscale and sign in; this continues on its own.",
            )}</p>
            <p><a href={TAILSCALE_DOWNLOAD_URL} target="_blank" rel="noreferrer">{text("下載 Tailscale（官方網站）", "Download Tailscale (official site)")}</a></p>
            <p className="phone-wizard-callout" role="status">{text("正在等待 Tailscale…", "Waiting for Tailscale…")}</p>
            <div className="phone-wizard-actions">{later}</div>
          </div>
        )}

        {step === "phone-install" && (
          <div>
            <h3>{text("在手機安裝 Tailscale", "Install Tailscale on your phone")}</h3>
            <p>{text("用手機相機掃描對應的 QR 碼，安裝官方的 Tailscale App。", "Scan the matching QR code with your phone camera to install the official Tailscale app.")}</p>
            <div className="phone-wizard-qr-row">
              <figure>
                {appStoreQr && <img src={appStoreQr} alt={text("iPhone：App Store 的 Tailscale", "iPhone: Tailscale on the App Store")} />}
                <figcaption>{text("iPhone（App Store）", "iPhone (App Store)")}</figcaption>
              </figure>
              <figure>
                {googlePlayQr && <img src={googlePlayQr} alt={text("Android：Google Play 的 Tailscale", "Android: Tailscale on Google Play")} />}
                <figcaption>{text("Android（Google Play）", "Android (Google Play)")}</figcaption>
              </figure>
            </div>
            <p className="phone-wizard-callout">{text(
              "安裝後打開 Tailscale，按「Get Started」。畫面跳出「允許加入 VPN 設定」時，請按「允許」。",
              "Open Tailscale and tap “Get Started”. When asked to allow adding VPN configurations, tap “Allow”.",
            )}</p>
            <div className="phone-wizard-actions">
              {later}
              <button className="button primary" type="button" onClick={() => setStep("phone-signin")}>{text("手機已裝好，下一步", "Installed, next")}</button>
            </div>
          </div>
        )}

        {step === "phone-signin" && (
          <div>
            <h3>{text("手機用同一個帳號登入", "Sign in with the same account")}</h3>
            <p>{tailscale?.loginName
              ? text(`請在手機的 Tailscale 用和這台電腦相同的帳號登入：${tailscale.loginName}`, `Sign in to Tailscale on the phone with the same account as this PC: ${tailscale.loginName}`)
              : text("請在手機的 Tailscale 用和這台電腦相同的帳號登入。", "Sign in to Tailscale on the phone with the same account as this PC.")}</p>
            <p>{text("登入後，確認 Tailscale 的開關是開著的。", "After signing in, make sure the Tailscale switch is on.")}</p>
            <ul className="phone-wizard-checks">
              <li className={detectedPeer ? "is-done" : ""}>
                <span className="phone-wizard-check" aria-hidden="true">{detectedPeer ? "✓" : ""}</span>
                <span role="status">
                  {detectedPeer
                    ? text(`已偵測到你的手機：${detectedPeer.hostName || detectedPeer.os}`, `Found your phone: ${detectedPeer.hostName || detectedPeer.os}`)
                    : tailscaleUnavailable
                      ? text("無法自動偵測，登入好後請按「下一步」。", "Cannot detect automatically; press Next after signing in.")
                      : text("正在等待手機上線…", "Waiting for the phone to come online…")}
                </span>
              </li>
            </ul>
            {slowWait && !detectedPeer && !tailscaleUnavailable && (
              <p className="phone-wizard-callout">{text("如果手機已經登入，按「下一步」繼續。", "If the phone is already signed in, press Next to continue.")}</p>
            )}
            <div className="phone-wizard-actions">
              {later}
              <button className="button primary" type="button" onClick={() => setStep("consent")}>{text("下一步", "Next")}</button>
            </div>
          </div>
        )}

        {step === "consent" && (
          <div>
            <h3>{text("開啟手機存取", "Turn on phone access")}</h3>
            {inspection?.enabled ? (
              <p>{text("手機存取已經開啟。接著產生配對 QR 碼。", "Phone access is already on. Next, create a pairing QR code.")}</p>
            ) : (
              <p>{text(
                "開啟後，只有你配對過的手機能透過 Tailscale 私人網路看這個看板；隨時可以在「手機存取設定」關閉或撤銷手機。",
                "Once on, only phones you pair can open this board over your private Tailscale network. You can turn it off or revoke phones any time in Mobile access settings.",
              )}</p>
            )}
            {error && <p className="phone-wizard-error" role="alert">{error}</p>}
            <div className="phone-wizard-actions">
              {later}
              {inspection?.enabled ? (
                <button className="button primary" type="button" disabled={busy} onClick={() => void createPairingCode()}>{text("產生配對 QR 碼", "Create pairing QR code")}</button>
              ) : (
                <button className="button primary" type="button" disabled={busy} onClick={() => void consent()}>{text("同意開啟手機存取", "Agree and turn on phone access")}</button>
              )}
            </div>
          </div>
        )}

        {step === "pair" && (
          <div>
            <h3>{text("用手機相機掃描配對", "Scan with the phone camera to pair")}</h3>
            <p>{text("請用手機內建的相機 App 掃描，手機會自動完成配對。", "Scan with the phone's built-in Camera app; the phone pairs automatically.")}</p>
            {challenge && !expired && !progress.paired && (
              <div className="phone-wizard-qr-row">
                <figure className="phone-wizard-pair-qr">
                  {pairQr && <img src={pairQr} alt={text("配對 QR 碼", "Pairing QR code")} />}
                  <figcaption>{text(`剩下 ${remaining(challenge.expiresAt, nowMs)}`, `${remaining(challenge.expiresAt, nowMs)} left`)}</figcaption>
                </figure>
                <figure>
                  <figcaption>{text("無法掃描時，在手機輸入 6 位數配對碼", "Can't scan? Enter this 6-digit code on the phone")}</figcaption>
                  <code className="phone-wizard-short-code" aria-label={text("6 位數配對碼", "6-digit pairing code")}>{challenge.shortCode}</code>
                </figure>
              </div>
            )}
            {challenge && expired && !progress.paired && (
              <p className="phone-wizard-callout" role="status">{text("這組配對碼已過期，請產生新的配對碼。", "This pairing code expired; create a new one.")}</p>
            )}
            <ul className="phone-wizard-checks" aria-label={text("進度", "Progress")}>
              <li className={progress.paired ? "is-done" : ""}>
                <span className="phone-wizard-check" aria-hidden="true">{progress.paired ? "✓" : ""}</span>
                <span>{text("手機已配對", "Phone paired")}</span>
              </li>
              <li className={progress.homeScreen ? "is-done" : ""}>
                <span className="phone-wizard-check" aria-hidden="true">{progress.homeScreen ? "✓" : ""}</span>
                <span>{text("已加到主畫面", "Added to Home Screen")}</span>
              </li>
            </ul>
            {progress.paired && !progress.homeScreen && (
              <p>{text("手機上會出現「加入主畫面」的圖解，照著做即可。", "The phone shows how to add the board to its Home Screen.")}</p>
            )}
            {error && <p className="phone-wizard-error" role="alert">{error}</p>}
            <div className="phone-wizard-actions">
              {onOpenSettings && (
                <button className="button secondary" type="button" onClick={onOpenSettings}>{text("手機存取設定", "Mobile access settings")}</button>
              )}
              <span className="phone-wizard-spacer" />
              <button className="button secondary" type="button" disabled={!link || expired} onClick={copyLink}>
                {copied ? text("已複製", "Copied") : text("複製連結", "Copy link")}
              </button>
              <button className="button secondary" type="button" disabled={busy} onClick={() => void createPairingCode()}>{text("產生新配對碼", "New pairing code")}</button>
              <button className="button primary" type="button" onClick={() => onClose(true)}>{text("完成", "Done")}</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
