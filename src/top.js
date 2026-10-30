const btn = document.querySelector("[data-top]");
if (btn) {
  const show = () => {
    btn.hidden = window.scrollY < window.innerHeight;
  };
  addEventListener("scroll", show, { passive: true });
  show();
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollTo({ top: 0, behavior: calm ? "auto" : "smooth" });
    document.querySelector(".pick")?.focus({ preventScroll: true });
  });
}
