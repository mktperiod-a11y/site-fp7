import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, readdirSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const WIDTHS = [
  [360, 780],
  [768, 1024],
  [1024, 768],
  [1440, 900],
];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};
const SHOTS = ".frames";
const problems = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);

function serve(dir) {
  const server = createServer((req, res) => {
    let file = join(dir, decodeURIComponent(req.url.split("?")[0]));
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404, { "Content-Type": TYPES[".html"] });
      res.end(readFileSync(join(dir, "404.html")));
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

function pagesOf(dir) {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  return walk(dir)
    .filter((f) => f.endsWith(".html") && !f.includes("/go/"))
    .map((f) => "/" + f.slice(dir.length + 1).replace(/index\.html$/, ""));
}

const inPage = {
  layout() {
    const out = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) out.push(`가로 스크롤 ${document.documentElement.scrollWidth - vw}px`);
    const hidden = (el) => el.closest(".sr-only, .skip") || getComputedStyle(el).visibility === "hidden";
    const label = (el) => (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : el.tagName.toLowerCase());
    for (const el of document.body.querySelectorAll("*")) {
      if (hidden(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > vw + 1 || r.left < -1) out.push(`화면 밖으로 나감 ${label(el)}`);
      const cs = getComputedStyle(el);
      if ((cs.overflowX === "hidden" || cs.overflow === "hidden") && el.scrollWidth > el.clientWidth + 1 && el.tagName !== "svg") out.push(`글자 잘림 ${label(el)}`);
    }
    for (const img of document.images) {
      if (!img.hasAttribute("alt")) out.push(`alt 없음 ${img.getAttribute("src")}`);
      if (!img.complete || img.naturalWidth === 0) out.push(`깨진 이미지 ${img.getAttribute("src")}`);
    }
    return out;
  },
  lines() {
    const out = [];
    const singles =
      ".entry__go, .card__go, .move, .gauge__value, .entry__num, .topnav__link, .stats__value, .profile__big, .side__rank, .card__label, .facts__value, .peer__rank, .pick__name, .pick__tag, .stats__note, .facts-list__label, .facts-list__value, .chip";
    const textRects = (el) => {
      const rects = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.data.trim() || n.parentElement.closest(".sr-only")) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        rects.push(...[...range.getClientRects()].filter((r) => r.width > 0));
      }
      return rects;
    };
    const countLines = (el) => {
      const tops = [];
      for (const r of textRects(el)) if (!tops.some((t) => Math.abs(t - r.top) < r.height / 2)) tops.push(r.top);
      return tops.length;
    };
    for (const el of document.querySelectorAll(singles)) {
      if (el.closest(".sr-only") || el.offsetParent === null) continue;
      const visible = [...el.childNodes].filter((n) => !(n.nodeType === 1 && n.classList.contains("sr-only")));
      if (!visible.length) continue;
      if (countLines(el) > 1) out.push(`짧은 라벨이 두 줄 ${el.className.split(" ")[0]} "${el.textContent.trim().slice(0, 12)}"`);
    }
    const prose = "h1, h2, h3, p, dd, .basis__line, .steps__line, .faq__a, td, .pairs__value";
    const punct = /^[.,!?·:;)\]}”’」』%]/;
    for (const el of document.querySelectorAll(prose)) {
      if (el.closest(".sr-only") || el.offsetParent === null) continue;
      if (/flex|grid/.test(getComputedStyle(el).display)) continue;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const chars = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement.closest(".sr-only")) continue;
        for (let i = 0; i < n.length; i++) {
          if (/\s/.test(n.data[i])) continue;
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 1);
          const rect = r.getClientRects()[0];
          if (rect) chars.push([Math.round(rect.top), n.data[i]]);
        }
      }
      if (!chars.length) continue;
      const lines = [];
      for (const [top, ch] of chars) {
        const last = lines.at(-1);
        if (last && Math.abs(last.top - top) < 6) last.text += ch;
        else lines.push({ top, text: ch });
      }
      if (lines.length < 2) continue;
      const tail = lines.at(-1).text.replace(/[.,!?·:;)\]}”’]/g, "");
      if ([...tail].length <= 2) out.push(`마지막 줄이 너무 짧음 "${el.textContent.trim().slice(0, 16)}"`);
      for (const l of lines.slice(1)) if (punct.test(l.text)) out.push(`줄 첫머리 문장부호 "${el.textContent.trim().slice(0, 16)}"`);
    }
    for (const g of document.querySelectorAll(".gauge")) {
      const v = g.querySelector(".gauge__value");
      const w = textRects(v).reduce((a, r) => a + r.width, 0);
      if (w > g.getBoundingClientRect().width * 0.8) out.push(`게이지 숫자가 원을 넘음 "${v.textContent.trim()}"`);
    }
    return out;
  },
  contrast() {
    const out = [];
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const lum = ({ r, g, b }) => {
      const f = (x) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el) => {
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c.a > 0.5) return c;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    for (const el of document.body.querySelectorAll("*")) {
      if (el.closest(".sr-only, .skip") || el.offsetParent === null) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim());
      if (!own) continue;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      const bg = bgOf(el);
      const l1 = lum(fg);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700);
      const chroma = (Math.max(bg.r, bg.g, bg.b) - Math.min(bg.r, bg.g, bg.b)) / 255;
      const need = chroma > 0.25 ? 7 : large ? 3 : 4.5;
      if (ratio < need) out.push(`대비 ${ratio.toFixed(2)} < ${need} "${el.textContent.trim().slice(0, 14)}"`);
    }
    return out;
  },
  targets() {
    const out = [];
    for (const el of document.querySelectorAll("a[href], button")) {
      if (el.closest(".sr-only") || el.classList.contains("skip") || el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) out.push(`누르는 영역 ${Math.round(r.width)}×${Math.round(r.height)} "${el.textContent.trim().slice(0, 14)}"`);
    }
    return out;
  },
  firstView() {
    const out = [];
    const status = document.querySelector(".hero__date");
    const rows = [...document.querySelectorAll(".entry")].slice(0, 3);
    if (!status) return out;
    if (status.getBoundingClientRect().bottom > innerHeight) out.push("갱신일이 첫 화면 밖");
    rows.forEach((r, i) => {
      if (r.getBoundingClientRect().bottom > innerHeight + 1) out.push(`${i + 1}위가 첫 화면 밖`);
    });
    return out;
  },
  topRows() {
    const rows = [...document.querySelectorAll(".entry")];
    if (rows.length < 4) return [];
    const sig = (row) => {
      const q = (s) => row.querySelector(s);
      return [
        getComputedStyle(row).backgroundColor,
        getComputedStyle(row).paddingTop,
        getComputedStyle(q(".entry__num")).fontSize,
        getComputedStyle(q(".entry__num")).color,
        q(".entry__logo").getBoundingClientRect().width,
        q(".gauge").getBoundingClientRect().width,
      ];
    };
    const out = [];
    const rest = sig(rows[3]);
    for (let i = 0; i < 3; i++) {
      const diff = sig(rows[i]).filter((v, k) => v !== rest[k]).length;
      if (diff < 2) out.push(`${i + 1}위가 4위와 충분히 다르지 않음 (${diff}가지)`);
    }
    return out;
  },
  tints() {
    const seen = new Map();
    const out = [];
    for (const el of document.querySelectorAll("[class*='tint--']")) {
      const id = [...el.classList].find((c) => c.startsWith("tint--"));
      const bg = getComputedStyle(el).backgroundColor;
      for (const [other, color] of seen) if (other !== id && color === bg) out.push(`업체 색이 겹침 ${id} ${other}`);
      seen.set(id, bg);
    }
    return out;
  },
};

async function hoverCheck(page, where) {
  for (const sel of [".entry__go", ".topnav__link", ".side__link", ".card__go", ".entry__name", ".peer", ".guide__link", ".chip"]) {
    const el = page.locator(sel).first();
    if (!(await el.count()) || !(await el.isVisible())) continue;
    const snap = () =>
      el.evaluate((e) => {
        const cs = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        return JSON.stringify([Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), cs.color, cs.borderColor, cs.transform, cs.backgroundColor]);
      });
    await el.scrollIntoViewIfNeeded();
    const before = await snap();
    await el.hover();
    await page.waitForTimeout(120);
    const after = await snap();
    if (before !== after) fail(where, `가리킬 때 모양이 바뀜 ${sel}`);
    await page.mouse.move(0, 0);
  }
}

async function keyboardCheck(page, where) {
  const total = await page.evaluate(() => [...document.querySelectorAll("a[href], button")].filter((e) => e.offsetParent !== null || e.classList.contains("skip")).length);
  const seen = new Set();
  for (let i = 0; i < total + 2; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return null;
      const cs = getComputedStyle(e);
      const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
      return { key: e.outerHTML.slice(0, 80), ring };
    });
    if (!info) continue;
    seen.add(info.key);
    if (!info.ring) fail(where, `포커스 표시 없음 ${info.key.slice(0, 40)}`);
  }
  if (seen.size < Math.min(total, 3)) fail(where, "키보드로 이동할 수 없는 요소가 있음");
}

async function linksCheck(page, base, where) {
  const hrefs = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.href));
  for (const href of new Set(hrefs)) {
    if (!href.startsWith(base)) continue;
    const res = await fetch(href.split("#")[0]);
    if (res.status !== 200) fail(where, `깨진 링크 ${href.slice(base.length)}`);
  }
}

async function run(dir, tag) {
  const server = await serve(dir);
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch();
  mkdirSync(join(SHOTS, tag), { recursive: true });
  const pages = pagesOf(dir);
  for (const [w, h] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: "reduce" });
    await ctx.addInitScript(() => {
      window.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective));
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    for (const p of pages) {
      const where = `${tag} ${w}px ${p}`;
      errors.length = 0;
      await page.goto(base + p, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      for (const e of errors) fail(where, `콘솔 오류 ${e.slice(0, 80)}`);
      for (const v of await page.evaluate(() => window.__csp)) fail(where, `CSP 위반 ${v}`);
      for (const check of ["layout", "lines", "contrast", "targets", "tints"]) {
        for (const msg of await page.evaluate(inPage[check])) fail(where, msg);
      }
      if (p === "/") {
        for (const msg of await page.evaluate(inPage.firstView)) fail(where, msg);
        for (const msg of await page.evaluate(inPage.topRows)) fail(where, msg);
      }
      if (w === 1440 || w === 360) await linksCheck(page, base, where);
      if (w === 1440) await hoverCheck(page, where);
      if (w === 1024) await keyboardCheck(page, where);
      const name = (p.replace(/\//g, "_").replace(/^_|_$/g, "") || "home") + `-${w}`;
      await page.screenshot({ path: join(SHOTS, tag, `${name}.png`), fullPage: true });
    }
    await ctx.close();
  }

  const goPages = readdirSync(join(dir, "go")).map((id) => `/go/${id}/`);
  if (goPages.length) {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      window.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective));
    });
    const page = await ctx.newPage();
    let leaving = 0;
    await page.route("**/*", (route) => {
      if (route.request().url().startsWith(base)) return route.continue();
      leaving += 1;
      return route.abort();
    });
    for (const p of goPages) {
      const before = leaving;
      await page.goto(base + p, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(300);
      if (leaving === before) fail(`${tag} ${p}`, "이동하지 않음");
    }
    await ctx.close();
  }

  const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 360, height: 780 } });
  const page = await noJs.newPage();
  await page.goto(base + "/");
  const shown = await page.evaluate(() => ({
    rows: [...document.querySelectorAll(".entry")].filter((e) => e.offsetParent !== null).length,
    perks: [...document.querySelectorAll(".entry__benefit")].filter((e) => e.offsetParent !== null).length,
    go: [...document.querySelectorAll(".entry__go")].filter((e) => e.offsetParent !== null).length,
  }));
  if (shown.rows && (shown.perks !== shown.rows || shown.go !== shown.rows)) fail(`${tag} 스크립트 꺼짐`, "순위·혜택·링크 중 안 보이는 것이 있음");
  await noJs.close();

  await browser.close();
  server.close();
}

async function main() {
  const targets = [["_site", "real"]];
  if (!process.argv.includes("--real-only")) {
    execFileSync("node", ["bin/compose.mjs"], { env: { ...process.env, DATA_DIR: "test/fixtures/extreme", OUT_DIR: join(SHOTS, "extreme-site") }, stdio: "inherit" });
    targets.push([join(SHOTS, "extreme-site"), "extreme"]);
  }
  for (const [dir, tag] of targets) await run(dir, tag);
  const unique = [...new Set(problems)];
  if (unique.length) {
    console.log(`화면 검사 실패 ${unique.length}건:`);
    for (const p of unique) console.log(`  ${p}`);
    process.exit(1);
  }
  console.log(`화면 검사 통과 (${targets.map((t) => t[1]).join(", ")})`);
}

main();
