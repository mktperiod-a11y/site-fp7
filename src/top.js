const btn = document.querySelector("[data-top]");
if (btn) {
  const wide = matchMedia("(min-width: 621px)");
  // PC 순위표는 5위 줄이 화면 가운데를 지날 때, 탭 칩이 있는 페이지는 칩 줄이 위로 지나간 뒤, 그 밖에는 반 화면을 내린 뒤 보인다.
  // 어느 페이지든 맨 아래까지 내리면 보인다.
  const bottom = (el) => el.getBoundingClientRect().bottom + window.scrollY;
  const mark = () => {
    const row = wide.matches && document.querySelectorAll(".board__list > .entry")[4];
    if (row) return row.getBoundingClientRect().top + window.scrollY - window.innerHeight / 2;
    const chips = document.querySelector(".sheet__chips");
    if (chips) return bottom(chips);
    return window.innerHeight / 2;
  };
  const show = () => {
    const end = window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    btn.hidden = !end && window.scrollY < mark();
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
