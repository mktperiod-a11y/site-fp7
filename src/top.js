const btn = document.querySelector("[data-top]");
if (btn) {
  const wide = matchMedia("(min-width: 621px)");
  // PC 순위표는 5위 줄이 화면 가운데를 지날 때, 탭 칩이 있는 페이지는 칩 줄이 위로 지나간 뒤, 그 밖에는 반 화면을 내린 뒤 보인다.
  // 어느 페이지든 맨 아래까지 내리면 보인다. 기준 위치는 불러올 때와 크기가 바뀔 때만 다시 잰다.
  const bottom = (el) => el.getBoundingClientRect().bottom + window.scrollY;
  let mark = 0;
  const measure = () => {
    const row = wide.matches && document.querySelectorAll(".board__list > .entry")[4];
    const chips = document.querySelector(".sheet__chips");
    mark = row ? row.getBoundingClientRect().top + window.scrollY - window.innerHeight / 2 : chips ? bottom(chips) : window.innerHeight / 2;
  };
  let queued = false;
  const show = () => {
    queued = false;
    const end = window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    btn.hidden = !end && window.scrollY < mark;
  };
  const schedule = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(show);
    }
  };
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", () => {
    measure();
    schedule();
  });
  addEventListener("load", () => {
    measure();
    schedule();
  });
  measure();
  show();
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollTo({ top: 0, behavior: calm ? "auto" : "smooth" });
    document.querySelector(".brand")?.focus({ preventScroll: true });
  });
}
