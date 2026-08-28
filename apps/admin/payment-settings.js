const API_ROOT = "../api/v1";
const form = document.getElementById("paymentSettingsForm");
const status = document.getElementById("paymentSettingsStatus");
const effectiveStripeStart = document.getElementById("paymentStripeEffective");
const clubSelect = document.getElementById("clubSelect");

let loading = false;
let loadedClubId = 0;

function token() { return localStorage.getItem("bd:token") || ""; }
function clubId() { return Number(clubSelect?.value || localStorage.getItem("bd:selectedClubId") || 0); }
function safe(value) { return String(value ?? "").trim(); }

function setStatus(message, tone = "info") {
  if (!status) return;
  status.textContent = message;
  status.className = `message ${tone}`;
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const response = await fetch(`${API_ROOT}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  return payload.data || {};
}

function fill(settings = {}) {
  const map = {
    paymentStripeStartUrl: settings.stripe_start_url,
    paymentStripePortalUrl: settings.stripe_portal_url,
    paymentVippsName: settings.vipps_name,
    paymentVippsNumber: settings.vipps_number,
    paymentVippsUrl: settings.vipps_one_time_url,
    paymentContact: settings.payment_contact,
  };
  Object.entries(map).forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (node) node.value = value || "";
  });
  if (effectiveStripeStart) {
    const effective = safe(settings.stripe_start_url_effective);
    effectiveStripeStart.textContent = effective
      ? `Aktiv startside: ${effective}`
      : "Ingen startside for Stripe er konfigurert.";
  }
}

async function load(force = false) {
  if (!form || loading || !token()) return;
  const id = clubId();
  if (!id || (!force && id === loadedClubId)) return;
  loading = true;
  form.setAttribute("aria-busy", "true");
  try {
    const data = await request(`/clubs/${id}/payment-settings`);
    fill(data.settings || {});
    loadedClubId = id;
    setStatus("Betalingsoppsettet er hentet.", "success");
  } catch (error) {
    loadedClubId = 0;
    setStatus(error.message || "Kunne ikke hente betalingsinnstillinger.", "error");
  } finally {
    form.removeAttribute("aria-busy");
    loading = false;
  }
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (loading) return;
  const id = clubId();
  if (!id) return setStatus("Velg klubb først.", "error");
  const button = form.querySelector("button[type='submit']");
  if (button) button.disabled = true;
  try {
    const data = await request(`/clubs/${id}/payment-settings`, {
      method: "PATCH",
      body: {
        stripe_start_url: safe(document.getElementById("paymentStripeStartUrl")?.value),
        stripe_portal_url: safe(document.getElementById("paymentStripePortalUrl")?.value),
        vipps_name: safe(document.getElementById("paymentVippsName")?.value),
        vipps_number: safe(document.getElementById("paymentVippsNumber")?.value),
        vipps_one_time_url: safe(document.getElementById("paymentVippsUrl")?.value),
        payment_contact: safe(document.getElementById("paymentContact")?.value),
      },
    });
    fill(data.settings || {});
    loadedClubId = id;
    setStatus(data.message || "Betalingsinnstillingene er lagret.", "success");
  } catch (error) {
    setStatus(error.message || "Kunne ikke lagre betalingsinnstillingene.", "error");
  } finally {
    if (button) button.disabled = false;
  }
});

clubSelect?.addEventListener("change", () => {
  loadedClubId = 0;
  window.setTimeout(() => load(true), 0);
});
window.addEventListener("bd:portal-view", (event) => {
  if (event.detail?.target === "integrations") load(true);
});
window.addEventListener("bd:session", () => load(true));
window.addEventListener("storage", () => load(true));
window.setTimeout(() => load(true), 700);
