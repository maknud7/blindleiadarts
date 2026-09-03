(() => {
  const fallbackNotice = document.getElementById("scoliaFallbackNotice");
  if (!fallbackNotice || typeof isManual !== "function") return;

  const baseIsManual = isManual;
  isManual = function () {
    return baseIsManual() || !fallbackNotice.classList.contains("hidden");
  };
})();
