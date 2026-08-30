function isCheckoutPercentageLabel(value) {
  const text = String(value || "").trim().toLocaleLowerCase("nb-NO").replace(/\s+/g, " ");
  return text === "checkout %" || text === "checkout%" || text === "checkout prosent" || text === "checkoutprosent" || text === "checkout percentage";
}

function removeCheckoutPercentage(root = document) {
  root.querySelectorAll?.(".stat-card, .home-stat-card, .mini-card, [data-stat], .match-stat-row, th, td").forEach((node) => {
    const labels = [
      node.matches?.("th,td") ? node : null,
      node.querySelector?.("small"),
      node.querySelector?.("span"),
      node.querySelector?.("label"),
    ].filter(Boolean);
    if (!labels.some((label) => isCheckoutPercentageLabel(label.textContent))) return;
    const row = node.closest?.(".stat-card, .home-stat-card, .mini-card, [data-stat], .match-stat-row, tr") || node;
    row.remove();
  });
}

removeCheckoutPercentage();

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;
      removeCheckoutPercentage(node);
      if (isCheckoutPercentageLabel(node.textContent) && node.matches(".stat-card, .home-stat-card, .mini-card, [data-stat], .match-stat-row")) node.remove();
    }
  }
});

observer.observe(document.documentElement, { childList: true, subtree: true });
