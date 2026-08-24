const API_URL = "../api/member-onboarding.php";

const params = new URLSearchParams(window.location.search);
const token = (params.get("token") || "").trim();

const el = {
  title: document.getElementById("title"),
  intro: document.getElementById("intro"),
  message: document.getElementById("message"),
  form: document.getElementById("onboardingForm"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  passwordConfirm: document.getElementById("passwordConfirm"),
  submitButton: document.getElementById("submitButton"),
  success: document.getElementById("success"),
};

function showMessage(text, tone = "error") {
  el.message.textContent = text;
  el.message.className = `message ${tone}`;
}

function hideMessage() {
  el.message.textContent = "";
  el.message.className = "message hidden";
}

async function request(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Forespørselen feilet.");
  }
  return payload.data;
}

async function inspect() {
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    showMessage("Invitasjonslenken er ugyldig eller mangler token.");
    el.intro.textContent = "Be en administrator lage en ny invitasjonslenke.";
    return;
  }

  try {
    const url = new URL(API_URL, window.location.href);
    url.searchParams.set("action", "inspect");
    url.searchParams.set("token", token);
    const data = await request(url);
    el.title.textContent = `Velkommen, ${data.member.name}`;
    el.intro.textContent = "Du er allerede registrert som medlem i Blindleia Dartklubb. Velg e-post og passord for å aktivere innloggingen.";
    el.email.value = data.account?.email || "";
    el.form.classList.remove("hidden");
  } catch (error) {
    showMessage(error.message);
    el.intro.textContent = "Be en administrator lage en ny invitasjonslenke.";
  }
}

el.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessage();

  if (el.password.value !== el.passwordConfirm.value) {
    showMessage("Passordene er ikke like.");
    return;
  }
  if (el.password.value.length < 10) {
    showMessage("Passordet må være minst 10 tegn.");
    return;
  }

  el.submitButton.disabled = true;
  el.submitButton.textContent = "Aktiverer …";
  try {
    const url = new URL(API_URL, window.location.href);
    url.searchParams.set("action", "complete");
    await request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, email: el.email.value.trim(), password: el.password.value }),
    });
    el.form.classList.add("hidden");
    el.success.classList.remove("hidden");
    el.intro.textContent = "Ferdig.";
    history.replaceState({}, document.title, window.location.pathname);
  } catch (error) {
    showMessage(error.message);
  } finally {
    el.submitButton.disabled = false;
    el.submitButton.textContent = "Aktiver konto";
  }
});

inspect();
