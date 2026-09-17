// Desktop header phone button (Amendment 15): shows whether a phone is connected to this PC.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTaskboardI18n } from "../i18n";
import { createMobileAccessApi, type MobileAccessApi, type PairedDeviceSession } from "../mobileAccessApi";
import { activePairedPhones } from "../phoneOnboarding";

const defaultApi = createMobileAccessApi();

export interface PairedPhonesState {
  /** null until the first inspection answered (or when mobile access is not reachable). */
  phones: PairedDeviceSession[] | null;
  refresh: () => Promise<PairedDeviceSession[] | null>;
}

/**
 * Paired phones of this PC, read from `GET /api/local/mobile-access` `sessions[]`. Re-read on `refresh()` (e.g. after
 * the wizard or the settings dialog closes) and whenever the window gets focus.
 */
export function usePairedPhones(enabled: boolean, api: MobileAccessApi = defaultApi): PairedPhonesState {
  const [phones, setPhones] = useState<PairedDeviceSession[] | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (!enabled) return null;
    try {
      const inspection = await api.inspect() as { sessions?: PairedDeviceSession[] };
      if (!Array.isArray(inspection.sessions)) return null;
      const next = activePairedPhones(inspection.sessions);
      if (mounted.current) setPhones(next);
      return next;
    } catch {
      // No mobile access backend (or not reachable): keep the last known state.
      return null;
    }
  }, [api, enabled]);
  useEffect(() => {
    mounted.current = true;
    if (!enabled) return undefined;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, refresh]);
  return { phones, refresh };
}

export function HeaderPhoneButton({ pairedCount, onClick }: { pairedCount: number; onClick: () => void }) {
  const { text } = useTaskboardI18n();
  const label = pairedCount > 0
    ? text(`已連接 ${pairedCount} 支手機`, pairedCount === 1 ? "1 phone connected" : `${pairedCount} phones connected`)
    : text("連接手機", "Connect a phone");
  return (
    <button
      className={`icon-button header-phone-button${pairedCount > 0 ? " is-paired" : ""}`}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M7 11.75h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      {pairedCount > 0 && <span className="header-phone-badge" aria-hidden="true" />}
    </button>
  );
}
