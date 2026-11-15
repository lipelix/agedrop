// agedrop.dev: the envelope flap opens as the back of the envelope scrolls into view.
(() => {
  const back = document.querySelector(".js-back");
  const scene = back && back.closest(".opening");
  if (!back || !scene) return;
  if (!window.matchMedia("(prefers-reduced-motion: no-preference)").matches) return;

  let ticking = false;
  const update = () => {
    ticking = false;
    const rect = back.getBoundingClientRect();
    const vh = window.innerHeight;
    const start = vh * 0.95;
    const end = vh * 0.35;
    const raw = (start - rect.top) / (start - end);
    const p = Math.min(1, Math.max(0, raw));
    const eased = 1 - Math.pow(1 - p, 3);
    scene.style.setProperty("--p", eased.toFixed(3));
    back.classList.toggle("is-closed", eased < 0.5);
  };
  const onScroll = () => {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(update);
    }
  };
  update();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
})();

// Theme switch: light and dark pin the scheme, auto follows the system.
(() => {
  const root = document.documentElement;
  const radios = document.querySelectorAll('input[name="theme"]');
  if (!radios.length) return;
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  const metaDefaults = [...metas].map((m) => m.getAttribute("media"));
  const current = root.dataset.theme || "auto";
  radios.forEach((r) => {
    r.checked = r.value === current;
    r.addEventListener("change", () => {
      if (!r.checked) return;
      const value = r.value;
      if (value === "auto") delete root.dataset.theme;
      else root.dataset.theme = value;
      try {
        if (value === "auto") localStorage.removeItem("agedrop-theme");
        else localStorage.setItem("agedrop-theme", value);
      } catch {
        /* storage blocked: the choice lasts for this page view */
      }
      metas.forEach((m, i) => {
        if (value === "auto") m.setAttribute("media", metaDefaults[i]);
        else m.setAttribute("media", metaDefaults[i].includes(value) ? "all" : "not all");
      });
    });
  });
})();
