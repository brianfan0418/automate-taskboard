import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import {
  canRenderWithoutClientStorage,
  isLoopbackHostname,
  markPhoneHandoffFailed,
  markPhoneAccessPaused,
  markPhonePairingRequired,
  markPhonePendingHandoff,
} from "./components/MobileAccessSettings";
import { createMobileAccessApi, getRelayCsrfToken } from "./mobileAccessApi";
import { isStandaloneDisplay, replaceLocationHref, resolvePhoneSession } from "./phoneOnboarding";
import { initializeTaskboardStorage } from "./storage";
import { taskboardPageHostname } from "./hostEmbedding";
import "./styles.css";
import { applyTextSize, readStoredTextSize } from "./textSize";

// W12-B: apply the per-device 文字大小 before the first paint.
applyTextSize(readStoredTextSize());

async function main() {
  let storageError: unknown = null;
  try {
    await initializeTaskboardStorage();
    // Without localStorage the 文字大小 choice lives in client storage, which is only readable now.
    applyTextSize(readStoredTextSize());
  } catch (error) {
    storageError = error;
  }
  const hostname = taskboardPageHostname();
  if (!isLoopbackHostname(hostname) && (storageError === null || canRenderWithoutClientStorage(storageError, hostname))) {
    // Amendment 13: CSRF recovery from the cookie, home-screen handoff redemption (phoneOnboarding.ts).
    const api = createMobileAccessApi();
    const outcome = await resolvePhoneSession({
      href: window.location.href,
      standalone: isStandaloneDisplay(),
      storageFailed: storageError !== null,
      hasCsrfToken: () => Boolean(getRelayCsrfToken()),
      refreshCsrf: () => api.refreshCsrf(),
      redeemHandoff: (token, standalone) => api.redeemHandoff(token, standalone),
      replaceHref: (next) => replaceLocationHref(next),
      availability: () => api.availability(),
    });
    if (outcome.redeemed && storageError !== null) {
      try {
        await initializeTaskboardStorage();
        storageError = null;
      } catch (error) {
        storageError = error;
      }
    }
    if (outcome.handoffFailed) markPhoneHandoffFailed(outcome.handoffFailed);
    if (outcome.pendingHandoff) markPhonePendingHandoff(outcome.pendingHandoff);
    if (outcome.paused) markPhoneAccessPaused();
    if (outcome.pairingRequired) markPhonePairingRequired();
  }
  if (storageError !== null) {
    // v2 mobile access: a phone that is not paired yet gets 401 PAIRING_REQUIRED for /api/client-storage.
    // Render anyway so App can show the pairing page (PairingCompletion) instead of a blank screen.
    // Everything else (including any failure on this PC) stays fatal as before.
    if (!canRenderWithoutClientStorage(storageError, taskboardPageHostname())) throw storageError;
    markPhonePairingRequired();
    console.error(storageError);
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main();
