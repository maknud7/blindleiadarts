const API_ROOT = "../api/v1";

function installPasswordReset() {
  const loginForm = document.getElementById("loginForm");
  if (!loginForm || document.getElementById("passwordResetPanel")) return;

  const resetToken = new URLSearchParams(window.location.search).get("reset_token") || "";
  const panel = document.createElement("section");
  panel.id = "passwordResetPanel";
  panel.className = `password-reset-panel${resetToken ? " active" : ""}`;
  panel.innerHTML = resetToken
    ? `
      <div class="password-reset-copy"><strong>Velg nytt passord</strong><span>Lenken er gyldig i 30 minutter og kan bare brukes én gang.</span></div>
      <form id="passwordResetConfirmForm" class="password-reset-form">
        <input id="passwordResetNew" type="password" autocomplete="new-password" minlength="8" placeholder="Nytt passord" required>
        <input id="passwordResetRepeat" type="password" autocomplete="new-password" minlength="8" placeholder="Gjenta nytt passord" required>
        <button type="submit">Lagre nytt passord</button>
      </form>
      <div id="passwordResetMessage" class="password-reset-message hidden"></div>`
    : `
      <button id="passwordResetOpen" type="button" class="password-reset-link">Glemt passord?</button>
      <div id="passwordResetBody" class="password-reset-body hidden">
        <div class="password-reset-copy"><strong>Få en lenke på e-post</strong><span>Skriv inn e-postadressen du bruker til Blindleia Darts.</span></div>
        <form id="passwordResetRequestForm" class="password-reset-form">
          <input id="passwordResetEmail" type="email" autocomplete="email" inputmode="email" placeholder="E-postadresse" required>
          <button type="submit">Send lenke</button>
        </form>
        <div id="passwordResetMessage" class="password-reset-message hidden"></div>
      </div>`;

  loginForm.insertAdjacentElement("afterend", panel);

  if (resetToken) {
    loginForm.classList.add("hidden");
    bindConfirm(panel, resetToken, loginForm);
  } else {
    bindRequest(panel);
  }
}

function bindRequest(panel) {
  const openButton = panel.querySelector("#passwordResetOpen");
  const body = panel.querySelector("#passwordResetBody");
  const form = panel.querySelector("#passwordResetRequestForm");
  const message = panel.querySelector("#passwordResetMessage");

  openButton?.addEventListener("click", () => {
    body?.classList.toggle("hidden");
    panel.classList.toggle("active", !body?.classList.contains("hidden"));
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    if (button) button.disabled = true;
    setMessage(message, "Sender …");
    try {
      const payload = await jsonRequest("/auth/password-reset/request", {
        email: panel.querySelector("#passwordResetEmail")?.value.trim() || "",
      });
      setMessage(message, payload.message || "Hvis e-postadressen er registrert, er en e-post sendt.", "success");
    } catch (error) {
      setMessage(message, error.message || "Kunne ikke sende lenke.", "error");
    } finally {
      if (button) button.disabled = false;
    }
  });
}

function bindConfirm(panel, token, loginForm) {
  const form = panel.querySelector("#passwordResetConfirmForm");
  const message = panel.querySelector("#passwordResetMessage");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = panel.querySelector("#passwordResetNew")?.value || "";
    const repeat = panel.querySelector("#passwordResetRepeat")?.value || "";
    if (password !== repeat) {
      setMessage(message, "Passordene er ikke like.", "error");
      return;
    }
    const button = form.querySelector("button");
    if (button) button.disabled = true;
    try {
      const payload = await jsonRequest("/auth/password-reset/confirm", { token, password });
      setMessage(message, payload.message || "Passordet er endret.", "success");
      form.classList.add("hidden");
      loginForm.classList.remove("hidden");
      const url = new URL(window.location.href);
      url.searchParams.delete("reset_token");
      window.history.replaceState({}, "", url.toString());
    } catch (error) {
      setMessage(message, error.message || "Kunne ikke endre passordet.", "error");
    } finally {
      if (button) button.disabled = false;
    }
  });
}

async function jsonRequest(path, body) {
  const response = await fetch(`${API_ROOT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || `Forespørselen feilet (${response.status})`);
  }
  return payload.data || {};
}

function setMessage(node, text, tone = "info") {
  if (!node) return;
  node.textContent = text;
  node.className = `password-reset-message ${tone}`;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installPasswordReset, { once: true });
} else {
  installPasswordReset();
}
