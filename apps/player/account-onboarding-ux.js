const loginForm = document.getElementById("loginForm");

function installAccountStartUx() {
  if (!loginForm || document.getElementById("accountStartCard")) return;

  const card = document.createElement("div");
  card.id = "accountStartCard";
  card.className = "account-start-card";
  card.innerHTML = `
    <div class="account-start-head">
      <img src="../static/club-logos/blindleia-dartklubb-logo.png" alt="Blindleia Dartklubb">
      <div><p class="eyebrow">Første gang du logger inn?</p><h3>Én konto – samme spillerhistorikk</h3></div>
    </div>
    <p>Har du allerede spilt hos Blindleia, skal vi <strong>koble brukerkontoen til spilleren som finnes fra før</strong>. Vi lager ikke en ny statistikkhistorikk bare fordi du får innlogging.</p>
    <div class="account-start-paths">
      <article><strong>Jeg har spilt her før</strong><span>Klubbadmin sender en aktiveringslenke til riktig medlem. Kamper, ELO og statistikk blir liggende på samme spiller.</span></article>
      <article><strong>Jeg er ny</strong><span>Du får en registreringslenke, fyller inn navn, e-post og passord, og klubben godkjenner koblingen før kontoen blir aktiv.</span></article>
    </div>
    <details>
      <summary>Hvordan får jeg en konto?</summary>
      <p>Be turneringsleder eller klubbadmin om en registrerings- eller aktiveringslenke. Har du spilt hos oss tidligere, si gjerne fra om det – da kobles kontoen til den eksisterende spilleren i stedet for å opprette en ny.</p>
    </details>`;

  loginForm.insertAdjacentElement("afterend", card);
}

installAccountStartUx();
