const API_URL = "../api/member-onboarding.php";

const params = new URLSearchParams(window.location.search);
const token = (params.get("token") || "").trim();
let inviteType = "member";

const el = {
  title: document.getElementById("title"),
  intro: document.getElementById("intro"),
  message: document.getElementById("message"),
  form: document.getElementById("onboardingForm"),
  nameFields: document.getElementById("nameFields"),
  firstName: document.getElementById("firstName"),
  lastName: document.getElementById("lastName"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  passwordConfirm: document.getElementById("passwordConfirm"),
  passwordLengthCheck: document.getElementById("passwordLengthCheck"),
  passwordMatchCheck: document.getElementById("passwordMatchCheck"),
  submitButton: document.getElementById("submitButton"),
  formNote: document.getElementById("formNote"),
  success: document.getElementById("success"),
  successTitle: document.getElementById("successTitle"),
  successText: document.getElementById("successText"),
  successLink: document.getElementById("successLink"),
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
  if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || "Forespørselen feilet.");
  return payload.data;
}

function showPendingSuccess(name = "") {
  el.form.classList.add("hidden");
  el.success.classList.remove("hidden");
  el.title.textContent = name ? `Takk, ${name}` : "Takk";
  el.intro.textContent = "Opplysningene dine er sendt inn.";
  el.successTitle.textContent = "Registreringen venter på godkjenning";
  el.successText.textContent = "Klubben kobler registreringen til riktig medlemskap. Deretter kan du logge inn med e-postadressen og passordet du valgte.";
  el.successLink.textContent = "Til spillerportalen";
  el.successLink.href = "../player/";
  el.success.focus({ preventScroll: true });
}

async function inspect() {
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    showMessage("Invitasjonslenken er ugyldig eller mangler token.");
    el.intro.textContent = "Be en administrator sende deg en ny invitasjonslenke.";
    return;
  }

  try {
    const url = new URL(API_URL, window.location.href);
    url.searchParams.set("action", "inspect");
    url.searchParams.set("token", token);
    const data = await request(url);
    inviteType = data?.type || "member";

    if (inviteType === "self_registration") {
      const clubName = String(data?.club?.name || "Blindleia Dartklubb");
      if (data.approved) {
        el.title.textContent = "Kontoen er klar";
        el.intro.textContent = `Registreringen hos ${clubName} er godkjent. Du kan logge inn i spillerportalen.`;
        el.success.classList.remove("hidden");
        el.successTitle.textContent = "Kontoen er aktivert";
        el.successText.textContent = "Logg inn med e-postadressen og passordet du valgte.";
        return;
      }
      if (data.submitted) {
        showPendingSuccess();
        return;
      }
      el.title.textContent = "Opprett spillerkonto";
      el.intro.textContent = `Du er invitert til ${clubName}. Fyll inn opplysningene dine, så kobler klubben kontoen til riktig medlemskap.`;
      el.nameFields.classList.remove("hidden");
      el.firstName.required = true;
      el.lastName.required = true;
      el.formNote.textContent = "Du trenger ikke være opprettet i spillerportalen på forhånd.";
      el.form.classList.remove("hidden");
      el.firstName.focus({ preventScroll: true });
      return;
    }

    const memberName = String(data?.member?.name || "").trim();
    el.title.textContent = memberName ? `Velkommen, ${memberName}` : "Aktiver kontoen din";
    el.intro.textContent = "Du er allerede registrert som medlem. Bekreft e-postadressen din og velg et passord for å aktivere innloggingen.";
    el.email.value = data.account?.email || "";
    el.formNote.textContent = "Når du aktiverer kontoen, kobles innloggingen til medlemskapet ditt i Blindleia Dartklubb.";
    el.submitButton.textContent = "Aktiver konto";
    el.form.classList.remove("hidden");
    if (!el.email.value) el.email.focus({ preventScroll: true });
  } catch (error) {
    showMessage(error.message);
    el.intro.textContent = "Be en administrator sende deg en ny invitasjonslenke.";
  }
}

[el.firstName, el.lastName, el.email].forEach((input) => input?.addEventListener("input", () => {
  input.removeAttribute("aria-invalid");
  hideMessage();
}));
el.password.addEventListener("input", () => { updatePasswordFeedback(); hideMessage(); });
el.passwordConfirm.addEventListener("input", () => { updatePasswordFeedback(); hideMessage(); });

el.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessage();

  if (inviteType === "self_registration") {
    el.firstName.value = el.firstName.value.trim();
    el.lastName.value = el.lastName.value.trim();
    if (el.firstName.value.length < 2) {
      el.firstName.setAttribute("aria-invalid", "true");
      showMessage("Fyll inn fornavnet ditt.");
      el.firstName.focus();
      return;
    }
    if (el.lastName.value.length < 2) {
      el.lastName.setAttribute("aria-invalid", "true");
      showMessage("Fyll inn etternavnet ditt.");
      el.lastName.focus();
      return;
    }
  }

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
  el.submitButton.textContent = inviteType === "self_registration" ? "Sender inn …" : "Aktiverer konto …";
  try {
    const url = new URL(API_URL, window.location.href);
    url.searchParams.set("action", "complete");
    const data = await request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        first_name: el.firstName.value,
        last_name: el.lastName.value,
        email: el.email.value,
        password: el.password.value,
      }),
    });
    history.replaceState({}, document.title, window.location.pathname);
    if (data?.type === "self_registration") {
      showPendingSuccess(data.name || `${el.firstName.value} ${el.lastName.value}`.trim());
    } else {
      el.form.classList.add("hidden");
      el.success.classList.remove("hidden");
      el.title.textContent = "Velkommen til Blindleia Darts";
      el.intro.textContent = "Kontoen din er klar.";
      el.successTitle.textContent = "Kontoen er aktivert";
      el.successText.textContent = "Du kan nå logge inn og bruke medlemsprofilen din.";
      el.successLink.textContent = "Gå til Min side";
      el.successLink.href = "../player/#profile";
      el.success.focus({ preventScroll: true });
    }
    el.success.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    showMessage(error.message);
  } finally {
    el.submitButton.disabled = false;
    el.submitButton.textContent = inviteType === "self_registration" ? "Send inn" : "Aktiver konto";
  }
});

bindPasswordVisibility();
updatePasswordFeedback();
inspect();
