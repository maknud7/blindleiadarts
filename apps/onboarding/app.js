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
  passwordLengthCheck: document.getElementById("passwordLengthCheck"),
  passwordMatchCheck: document.getElementById("passwordMatchCheck"),
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

function updatePasswordFeedback() {
  const password = el.password.value;
  const confirmation = el.passwordConfirm.value;
  const lengthValid = password.length >= 10;
  const matchValid = confirmation.length > 0 && password === confirmation;

  el.passwordLengthCheck.classList.toggle("valid", lengthValid);
  el.passwordMatchCheck.classList.toggle("valid", matchValid);
  el.password.setAttribute("aria-invalid", password.length > 0 && !lengthValid ? "true" : "false");
  el.passwordConfirm.setAttribute("aria-invalid", confirmation.length > 0 && !matchValid ? "true" : "false");

  return { lengthValid, matchValid };
}

function bindPasswordVisibility() {
  document.querySelectorAll("[data-toggle-password]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.togglePassword || "");
      if (!(input instanceof HTMLInputElement)) return;
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      button.textContent = reveal ? "Skjul" : "Vis";
      button.setAttribute("aria-pressed", reveal ? "true" : "false");
      button.setAttribute("aria-label", reveal ? "Skjul passord" : "Vis passord");
      input.focus({ preventScroll: true });
    });
  });
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
    showMessage("Aktiveringslenken er ugyldig eller mangler token.");
    el.intro.textContent = "Be en administrator sende deg en ny aktiveringslenke.";
    return;
  }

  try {
    const url = new URL(API_URL, window.location.href);
    url.searchParams.set("action", "inspect");
    url.searchParams.set("token", token);
    const data = await request(url);
    const memberName = String(data?.member?.name || "").trim();
    el.title.textContent = memberName ? `Velkommen, ${memberName}` : "Aktiver kontoen din";
    el.intro.textContent = "Du er allerede registrert som medlem. Bekreft e-postadressen din og velg et passord for å aktivere innloggingen.";
    el.email.value = data.account?.email || "";
    el.form.classList.remove("hidden");
    if (!el.email.value) el.email.focus({ preventScroll: true });
  } catch (error) {
    showMessage(error.message);
    el.intro.textContent = "Be en administrator sende deg en ny aktiveringslenke.";
  }
}

el.email.addEventListener("input", () => {
  el.email.removeAttribute("aria-invalid");
  hideMessage();
});
el.password.addEventListener("input", () => {
  updatePasswordFeedback();
  hideMessage();
});
el.passwordConfirm.addEventListener("input", () => {
  updatePasswordFeedback();
  hideMessage();
});

el.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessage();

  el.email.value = el.email.value.trim();
  if (!el.email.checkValidity()) {
    el.email.setAttribute("aria-invalid", "true");
    showMessage("Skriv inn en gyldig e-postadresse.");
    el.email.focus();
    return;
  }

  const { lengthValid, matchValid } = updatePasswordFeedback();
  if (!lengthValid) {
    showMessage("Passordet må være minst 10 tegn.");
    el.password.focus();
    return;
  }
  if (!matchValid) {
    showMessage("Passordene er ikke like.");
    el.passwordConfirm.focus();
    return;
  }

  el.submitButton.disabled = true;
  el.submitButton.textContent = "Aktiverer konto …";
  try {
    const url = new URL(API_URL, window.location.href);
    url.searchParams.set("action", "complete");
    await request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, email: el.email.value, password: el.password.value }),
    });
    el.form.classList.add("hidden");
    el.success.classList.remove("hidden");
    el.title.textContent = "Velkommen til Blindleia Darts";
    el.intro.textContent = "Kontoen din er klar.";
    history.replaceState({}, document.title, window.location.pathname);
    el.success.focus({ preventScroll: true });
    el.success.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    showMessage(error.message);
  } finally {
    el.submitButton.disabled = false;
    el.submitButton.textContent = "Aktiver konto";
  }
});

bindPasswordVisibility();
updatePasswordFeedback();
inspect();
