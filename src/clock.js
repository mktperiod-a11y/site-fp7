const el = document.querySelector("[data-next]");
if (el) {
  const HOUR = 36e5;
  const DAY = 24 * HOUR;
  const parts = (s) => {
    const d = Math.floor(s / 86400);
    const h = Math.floor(s / 3600) % 24;
    const m = Math.floor(s / 60) % 60;
    if (d) return h ? `${d}일 ${h}시간` : `${d}일`;
    if (h) return m ? `${h}시간 ${m}분` : `${h}시간`;
    return `${m}분 ${s % 60}초`;
  };
  const tick = () => {
    const now = Date.now() + 9 * HOUR;
    let next = Math.floor(now / DAY) * DAY + 10 * HOUR + ((8 - new Date(now).getUTCDay()) % 7) * DAY;
    if (next <= now) next += 7 * DAY;
    el.textContent = `${parts(Math.floor((next - now) / 1000))} 남음`;
  };
  tick();
  setInterval(tick, 1000);
}
