import { api } from "../shared/api";
import { clearKioskRuntime, clearTestLeaseMarkers, read, STORAGE_EVENT, write } from "../shared/storage";

const TEST_SESSION_AUTH_KEY = "bd:kioskTestLaunchAuthorized";

type StorageEventDetail = { key?: string; value?: string };

function isTestHost(): boolean {
  return /(^|[.-])test([.-]|$)/i.test(window.location.hostname) || /\/test(?:\/|$)/i.test(window.location.pathname);
}

function prodKioskUrl(): string {
  const url = new URL(window.location.href);
  url.hostname = url.hostname.replace(/^test\./i, "");
  url.pathname = "/kiosk/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function safeProdReturnUrl(raw: string): string {
  if (!raw) return "";
  try {
    const candidate = new URL(raw);
    const expectedProdHost = window.location.hostname.replace(/^test\./i, "");
    if (candidate.protocol !== window.location.protocol || candidate.hostname !== expectedProdHost) return "";
    if (!candidate.pathname.startsWith("/kiosk")) return "";
    return candidate.toString();
  } catch {
    return "";
  }
}

function cleanLaunchUrl(): void {
  const url = new URL(window.location.href);
  ["testmode", "return_url", "embedded"].forEach((key) => url.searchParams.delete(key));
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function clearTestSessionMarkers(): void {
  clearKioskRuntime();
  clearTestLeaseMarkers();
  write("testMode", null);
  write("testReturnUrl", null);
  write("testEmbedded", null);
  sessionStorage.removeItem(TEST_SESSION_AUTH_KEY);
}

function redirectToProd(): false {
  clearTestSessionMarkers();
  document.documentElement.style.visibility = "hidden";
  window.location.replace(prodKioskUrl());
  return false;
}

export function initializeTestHandoff(): boolean {
  if (!isTestHost()) return true;

  const params = new URLSearchParams(window.location.search);
  const returnUrl = safeProdReturnUrl(params.get("return_url") || "");
  const embeddedLaunch = params.get("embedded") === "1" && window.parent !== window;
  const freshLaunch = params.get("testmode") === "1" && Boolean(returnUrl) && embeddedLaunch;
  const storedReturnUrl = safeProdReturnUrl(read("testReturnUrl"));
  const activeSession = read("testMode") === "1"
    && sessionStorage.getItem(TEST_SESSION_AUTH_KEY) === "1"
    && Boolean(storedReturnUrl);

  if (!freshLaunch && !activeSession) return redirectToProd();

  if (freshLaunch) {
    clearKioskRuntime();
    clearTestLeaseMarkers();
    write("testReturnUrl", returnUrl);
    write("testEmbedded", "1");
    write("testMode", "1");
    sessionStorage.setItem(TEST_SESSION_AUTH_KEY, "1");

    // The launch parameters are one-shot authorization data. Leaving them in the
    // address bar made every refresh look like a brand-new test launch and reset
    // the selected physical board back to the chooser. v1 already treated them as
    // one-shot; v2 must preserve the same behaviour.
    cleanLaunchUrl();
  }

  let lastKioskCode = read("kioskCode");
  let exiting = false;

  async function finishExit(): Promise<void> {
    if (exiting) return;
    exiting = true;
    const target = safeProdReturnUrl(read("testReturnUrl")) || prodKioskUrl();
    const embedded = read("testEmbedded") === "1" && window.parent !== window;
    const kioskToken = read("kioskToken");

    if (lastKioskCode && kioskToken) {
      await api(`/kiosks/${encodeURIComponent(lastKioskCode)}/unpair`, {
        method: "POST",
        kioskToken,
      }).catch(() => undefined);
    }

    clearKioskRuntime();
    clearTestLeaseMarkers();
    write("testReturnUrl", null);
    write("testEmbedded", null);
    sessionStorage.removeItem(TEST_SESSION_AUTH_KEY);

    if (embedded) {
      window.parent.postMessage({ type: "bd:kiosk-test-exit" }, new URL(target).origin);
      return;
    }
    window.location.replace(target);
  }

  window.addEventListener(STORAGE_EVENT, (event) => {
    const detail = (event as CustomEvent<StorageEventDetail>).detail || {};
    if (detail.key === "kioskCode" && detail.value) lastKioskCode = detail.value;
    if (detail.key === "testMode" && !detail.value && sessionStorage.getItem(TEST_SESSION_AUTH_KEY) === "1") {
      void finishExit();
    }
  });

  return true;
}
