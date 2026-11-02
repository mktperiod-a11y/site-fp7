const board = document.querySelector("[data-board]");
if (board) {
  board.classList.add("board--js");
  board.addEventListener("click", (e) => {
    if (e.target.closest("a, button, summary")) return;
    const link = e.target.closest(".entry")?.querySelector(".entry__more");
    if (!link || String(getSelection())) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) open(link.href, "_blank", "noopener");
    else location.href = link.href;
  });
  const more = board.querySelector(".board__more");
  if (more) {
    const key = "board-more-open";
    try { if (sessionStorage.getItem(key) === "1") more.open = true; } catch {}
    more.addEventListener("toggle", () => { try { sessionStorage.setItem(key, more.open ? "1" : "0"); } catch {} });
    const close = more.querySelector("[data-close]");
    if (close) {
      close.hidden = false;
      close.addEventListener("click", () => {
        more.open = false;
        const toggle = more.querySelector("summary");
        toggle.scrollIntoView({ block: "nearest" });
        toggle.focus({ preventScroll: true });
      });
    }
  }
}
