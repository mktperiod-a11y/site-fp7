for (const rail of document.querySelectorAll("[data-rail]")) {
  const list = rail.querySelector(".rail__list");
  for (const btn of rail.querySelectorAll("[data-dir]")) {
    btn.hidden = false;
    btn.addEventListener("click", () => list.scrollBy({ left: Number(btn.dataset.dir) * list.clientWidth * 0.8, behavior: "smooth" }));
  }
}
