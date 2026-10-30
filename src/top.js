const btn = document.querySelector("[data-top]");
if (btn) {
  const wide = matchMedia("(min-width: 621px)");
  // PC 순위표에서는 5위 줄이 화면 위로 지나간 뒤부터, 그 밖에는 한 화면을 넘게 내린 뒤부터 보인다.
  const mark = () => {
    const row = wide.matches && document.querySelectorAll(".board__list > .entry")[4];
    return row ? row.getBoundingClientRect().bottom + window.scrollY : window.innerHeight;
  };
  const show = () => {
    btn.hidden = window.scrollY < mark();
  };
  addEventListener("scroll", show, { passive: true });
  addEventListener("resize", show);
  show();
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollTo({ top: 0, behavior: calm ? "auto" : "smooth" });
    document.querySelector(".pick")?.focus({ preventScroll: true });
  });
}
