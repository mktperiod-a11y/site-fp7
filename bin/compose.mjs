import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PARTS, PUBLIC_COUNT, readJson } from "./tally.mjs";
import { blockedLines } from "./guard.mjs";

export const PLACEHOLDER = "https://e097fv9iz.invalid";
const BRAND = "파일픽";
const CLOCK_JS = readFileSync("src/clock.js", "utf8");
const CLOCK_HASH = createHash("sha256").update(CLOCK_JS).digest("hex").slice(0, 10);
const WIDTH = 140;

const DATA = process.env.DATA_DIR || "data";
const OUT = process.env.OUT_DIR || "_site";
const SITE = (process.env.SITE_URL || PLACEHOLDER).replace(/\/+$/, "");
const ABSOLUTE = !/\.github\.io$/i.test(new URL(SITE).hostname);

export function cols(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) ? 2 : 1;
  }
  return n;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");

const VOID = new Set(["meta", "link", "img", "br", "input", "source"]);
const SVG_LEAF = new Set(["circle", "path", "rect", "line", "polyline"]);
const RAW = Symbol("raw");

export function h(tag, attrs, ...children) {
  return { tag, attrs: attrs ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== "") };
}
const raw = (lines) => ({ [RAW]: lines });

function wrapWords(text, avail) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && cols(next) > avail) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

function attrParts(attrs) {
  return Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? k : `${k}="${escAttr(v)}"`));
}

function openTag(node, pad) {
  const parts = attrParts(node.attrs);
  const close = VOID.has(node.tag) || SVG_LEAF.has(node.tag) ? " />" : ">";
  const one = `<${node.tag}${parts.length ? " " + parts.join(" ") : ""}${close}`;
  if (cols(pad + one) <= WIDTH) return [pad + one];
  const lines = [`${pad}<${node.tag}`];
  for (const p of parts) {
    if (cols(pad + "  " + p) <= WIDTH) {
      lines.push(`${pad}  ${p}`);
      continue;
    }
    const eq = p.indexOf("=");
    const name = p.slice(0, eq);
    const value = p.slice(eq + 2, -1);
    const chunks = wrapWords(value, WIDTH - cols(pad) - name.length - 6);
    lines.push(`${pad}  ${name}="${chunks[0]}`);
    for (const c of chunks.slice(1, -1)) lines.push(`${pad}    ${c}`);
    if (chunks.length > 1) lines.push(`${pad}    ${chunks.at(-1)}"`);
    else lines[lines.length - 1] += '"';
  }
  lines.push(pad + close.trim());
  return lines;
}

function inline(node) {
  if (typeof node === "string") return esc(node);
  if (node[RAW]) return null;
  const parts = attrParts(node.attrs);
  const open = `<${node.tag}${parts.length ? " " + parts.join(" ") : ""}`;
  if (VOID.has(node.tag) || SVG_LEAF.has(node.tag)) return `${open} />`;
  const inner = node.children.map(inline);
  if (inner.some((x) => x === null)) return null;
  return `${open}>${inner.join("")}</${node.tag}>`;
}

function render(node, depth = 0) {
  const pad = "  ".repeat(depth);
  if (typeof node === "string") return wrapWords(esc(node), WIDTH - cols(pad)).map((l) => pad + l);
  if (node[RAW]) return node[RAW].map((l) => pad + l);
  const one = inline(node);
  if (one !== null && cols(pad + one) <= WIDTH && !node.attrs["data-block"]) return [pad + one];
  const lines = openTag(node, pad);
  if (VOID.has(node.tag) || SVG_LEAF.has(node.tag)) return lines;
  for (const c of node.children) lines.push(...render(c, depth + 1));
  lines.push(`${pad}</${node.tag}>`);
  return lines;
}

export function jsonLines(value, depth = 0) {
  const pad = "  ".repeat(depth);
  const inner = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (!value.length) return ["[]"];
    const items = value.map((v) => jsonLines(v, depth + 1));
    return ["[", ...items.flatMap((ls, i) => [inner + ls[0], ...ls.slice(1)].map((l, j, a) => (j === a.length - 1 && i < items.length - 1 ? l + "," : l))), pad + "]"];
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    const out = ["{"];
    keys.forEach((k, i) => {
      const comma = i < keys.length - 1 ? "," : "";
      const v = value[k];
      if (v && typeof v === "object") {
        const ls = jsonLines(v, depth + 1);
        out.push(`${inner}${JSON.stringify(k)}: ${ls[0]}`, ...ls.slice(1, -1), ls.at(-1) + comma);
      } else {
        const s = JSON.stringify(v);
        const line = `${inner}${JSON.stringify(k)}: ${s}${comma}`;
        if (cols(line) <= WIDTH - 6) out.push(line);
        else out.push(`${inner}${JSON.stringify(k)}:`, `${inner}  ${s}${comma}`);
      }
    });
    out.push(pad + "}");
    return out;
  }
  return [JSON.stringify(value)];
}

function hashOf(text) {
  return createHash("sha256").update(text).digest("hex");
}

const monthLabel = (d) => `${d.slice(0, 4)}년 ${+d.slice(5, 7)}월`;
const dotMonth = (d) => `${d.slice(0, 4)}.${d.slice(5, 7)}`;
const dayLabel = (d) => `${+d.slice(5, 7)}월 ${+d.slice(8, 10)}일`;

function fmtPoints(n, decimals, grouping = true) {
  return n.toLocaleString("ko-KR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouping });
}

function countLabel(n) {
  if (n >= 1e8) return `${+(n / 1e8).toFixed(1)}억`;
  if (n >= 1e4) return `${+(n / 1e4).toFixed(1)}만`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}천`;
  return String(n);
}

function pick(list, count, seed) {
  return [...list]
    .map((x) => [hashOf(seed + ":" + x.id), x])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(0, count)
    .map((p) => p[1]);
}

function tintStyles(vendors) {
  return vendors
    .map((v, i) => {
      const hue = Math.round((i * 137.508) % 360);
      return [`.tint--${v.id} {`, `  background: hsl(${hue} 55% 91%);`, `  color: hsl(${hue} 70% 22%);`, "}"].join("\n");
    })
    .join("\n");
}

function fontFaces(usedText) {
  const manifest = JSON.parse(readFileSync("src/fonts.json", "utf8"));
  const used = new Set([...usedText].map((c) => c.codePointAt(0)));
  const files = [];
  const rules = [];
  for (const f of manifest) {
    const hit = [...used].some((c) => f.ranges.some(([a, b]) => c >= a && c <= b));
    if (!hit) continue;
    files.push(f.file);
    const ranges = f.ranges.map(([a, b]) => (a === b ? `U+${a.toString(16)}` : `U+${a.toString(16)}-${b.toString(16)}`));
    const rangeLines = wrapWords(ranges.join(", "), WIDTH - 20);
    rules.push(
      [
        "@font-face {",
        '  font-family: "Pretendard";',
        "  font-style: normal;",
        `  font-weight: ${f.weight};`,
        "  font-display: swap;",
        `  src: url("fonts/${f.file}") format("woff2");`,
        `  unicode-range: ${rangeLines[0]}`,
        ...rangeLines.slice(1).map((l) => `    ${l}`),
        "  ;",
        "}",
      ].join("\n"),
    );
  }
  return { files, css: rules.join("\n") };
}

const PICKS = [
  { id: "points", label: "가입 포인트", title: "가입 포인트 주는 웹하드", benefit: (b) => b.kind === "join" && /\d\s*[PB]$/.test(b.text) },
  { id: "100won", label: "100원 이용권", title: "100원 이용권 주는 웹하드", benefit: (b) => /(^|[^\d,])100원/.test(b.text) },
  { id: "payback", label: "페이백 이벤트", title: "페이백 이벤트 하는 웹하드", benefit: (b) => /페이백/.test(b.text) },
  { id: "app", label: "앱 설치·리뷰 혜택", title: "앱 설치·리뷰 혜택 주는 웹하드", benefit: (b) => /앱/.test(b.text) },
  { id: "triple", label: "3배 혜택 행사", title: "3배 혜택 행사 하는 웹하드", benefit: (b) => /3배/.test(b.text) },
  { id: "iphone", label: "아이폰 앱", title: "아이폰 앱이 있는 웹하드", vendor: (v) => Boolean(v.iosId), note: "아이폰 앱 제공" },
];

function pickList(ctx, p) {
  const order = new Map(ctx.entries.map((e) => [e.id, e.rank]));
  return ctx.vendors
    .map((v) => {
      const sure = (v.benefits ?? []).filter((b) => b.text && !b.unconfirmed);
      const hit = p.vendor ? (p.vendor(v) ? p.note : null) : sure.find(p.benefit)?.text;
      if (!hit) return null;
      return { v, hit, rest: sure.map((b) => b.text).filter((t) => t !== hit), rank: order.get(v.id) ?? null };
    })
    .filter(Boolean)
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.v.name.localeCompare(b.v.name, "ko"));
}

function load() {
  const vendors = readJson(join(DATA, "vendors.json"), []).filter((v) => v.status !== "excluded");
  const ranking = readJson(join(DATA, "ranking.json"), { weeks: [] });
  const metrics = readJson(join(DATA, "metrics.json"), { weeks: [] });
  const faq = readJson(join(DATA, "faq.json"), { home: [], criteria: [] });
  const week = ranking.weeks.at(-1) ?? null;
  const prevWeek = ranking.weeks.at(-2) ?? null;
  const byId = Object.fromEntries(vendors.map((v) => [v.id, v]));
  const entries = (week?.entries ?? []).filter((e) => byId[e.id]).map((e, i) => ({ ...e, rank: i + 1 }));
  const top = entries.slice(0, PUBLIC_COUNT);
  const latest = metrics.weeks.at(-1)?.values ?? {};
  const ctx = { vendors, byId, ranking, week, prevWeek, entries, top, latest, faq };
  ctx.picks = PICKS.map((p) => ({ ...p, list: pickList(ctx, p) })).filter((p) => p.list.length >= 2);
  return ctx;
}

class Page {
  constructor(path) {
    this.path = path;
    const depth = path.split("/").length - 1;
    this.root = "../".repeat(depth) || "./";
  }
  url(target) {
    return target === "" ? this.root : this.root === "./" ? target : this.root + target;
  }
  abs(target) {
    return ABSOLUTE ? `${SITE}/${target}` : this.url(target);
  }
}

const LOST_STYLE = [
  "body{margin:0;padding:48px 16px;background:#f7fafc;color:#181c1e;font-family:system-ui,sans-serif;line-height:1.6}",
  "a{display:inline-flex;align-items:center;min-height:44px;color:#005268;font-weight:600}",
  "h1{font-size:24px;line-height:1.3}h1,p{word-break:keep-all}",
];

function headTags(page, meta, css, scripts = []) {
  const csp = [
    "default-src 'none'",
    "img-src 'self'",
    meta.style
      ? `style-src 'self' ${meta.style.map((t) => `'sha256-${createHash("sha256").update(t).digest("base64")}'`).join(" ")}`
      : "style-src 'self'",
    "font-src 'self'",
    scripts.length || meta.js
      ? `script-src ${[...(meta.js ? ["'self'"] : []), ...scripts.map((s) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`)].join(" ")}`
      : "script-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
  const canonicalTarget = page.path.replace(/index\.html$/, "");
  return [
    h("meta", { charset: "utf-8" }),
    h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
    h("meta", { "http-equiv": "Content-Security-Policy", content: csp }),
    h("meta", { name: "referrer", content: "no-referrer" }),
    h("title", null, meta.title),
    meta.description && h("meta", { name: "description", content: meta.description }),
    h("meta", { name: "robots", content: meta.robots ?? "index,follow,max-image-preview:large" }),
    meta.robots ? null : h("link", { rel: "canonical", href: ABSOLUTE ? page.abs(canonicalTarget) : "./" }),
    ...(meta.robots
      ? []
      : [
          h("meta", { property: "og:type", content: "website" }),
          h("meta", { property: "og:locale", content: "ko_KR" }),
          h("meta", { property: "og:site_name", content: BRAND }),
          h("meta", { property: "og:title", content: meta.title }),
          h("meta", { property: "og:description", content: meta.description }),
          ABSOLUTE ? h("meta", { property: "og:url", content: page.abs(canonicalTarget) }) : null,
          h("meta", { property: "og:image", content: page.abs("assets/share.png") }),
          h("meta", { property: "og:image:width", content: "1200" }),
          h("meta", { property: "og:image:height", content: "630" }),
          h("meta", { name: "twitter:card", content: "summary_large_image" }),
        ]),
    h("meta", { name: "theme-color", content: "#ffffff" }),
    meta.style ? null : h("link", { rel: "icon", href: page.url("assets/mark.svg"), type: "image/svg+xml" }),
    css && h("link", { rel: "stylesheet", href: page.url(`assets/site.css?v=${css}`) }),
    ...(meta.js ?? []).map((src) => h("script", { src: page.url(src), defer: true })),
    ...(meta.style ?? []).map((t) => h("style", null, t)),
    ...(meta.ld ?? []).map((d) => h("script", { type: "application/ld+json", "data-block": true }, raw(jsonLines(d)))),
  ];
}

function pickMark() {
  return h(
    "svg",
    { class: "pick__symbol", viewBox: "0 0 52 40", "aria-hidden": "true" },
    h("path", { d: "M4 4h27l11 16-11 16H4l10-16Z", fill: "currentColor" }),
    h("path", { d: "m17 20 6 6 12-14", fill: "none", stroke: "#fff", "stroke-width": "4", "stroke-linecap": "round", "stroke-linejoin": "round" }),
    h("circle", { cx: "46", cy: "20", r: "4", fill: "#22c7cf" }),
  );
}

const NAV = [
  ["home", "", "웹하드 순위"],
  ["benefits", "benefits/", "혜택별 추천"],
  ["criteria", "criteria/", "순위 검증 가이드"],
];

function header(page, current) {
  return h(
    "header",
    { class: "topbar" },
    h(
      "div",
      { class: "topbar__inner wrap" },
      h(
        "a",
        { class: "pick", href: page.url("") },
        pickMark(),
        h("span", { class: "pick__word" }, h("b", { class: "pick__name" }, "파일", h("span", { class: "pick__accent" }, "픽")), h("small", { class: "pick__tag" }, "SELECTED FOR YOU")),
      ),
      h(
        "nav",
        { class: "topnav", "aria-label": "주요 메뉴" },
        NAV.map(([key, path, label]) => h("a", { class: "topnav__link", href: page.url(path), "aria-current": current === key ? "page" : null }, label)),
      ),
    ),
  );
}

function footer() {
  return h(
    "footer",
    { class: "footer" },
    h("div", { class: "footer__inner wrap" }, h("span", null, "© 2026 FILEPICK. All rights reserved."), h("span", null, "웹하드 선택을 위한 데이터 가이드")),
  );
}

function doc(page, meta, body, css, scripts) {
  const lines = ["<!doctype html>", '<html lang="ko">', ...render(h("head", null, headTags(page, meta, css, scripts)), 1)];
  lines.push(...render(h("body", { class: meta.bodyClass ?? null }, body), 1), "</html>");
  return lines.join("\n") + "\n";
}

function logo(page, v, cls) {
  if (existsSync(`assets/logo/${v.id}.webp`))
    return h(
      "span",
      { class: `logo ${cls}` },
      h("img", { class: "logo__img", src: page.url(`assets/logo/${v.id}.webp`), width: "160", height: "56", alt: `${v.name} 로고`, decoding: "async" }),
    );
  return h("span", { class: `logo logo--letter ${cls} tint--${v.id}`, "aria-hidden": "true" }, [...v.name][0]);
}

function gauge(entry, scale, size, cls) {
  const p = Math.max(0, Math.min(1, entry.total / scale));
  const r = size / 2 - 5;
  return h(
    "svg",
    { class: `${cls}__svg`, viewBox: `0 0 ${size} ${size}`, width: String(size), height: String(size), "aria-hidden": "true" },
    h("circle", {
      class: `${cls}__track`,
      cx: String(size / 2),
      cy: String(size / 2),
      r: String(r),
      pathLength: "100",
      "stroke-dasharray": "75 100",
      transform: `rotate(135 ${size / 2} ${size / 2})`,
    }),
    h("circle", {
      class: `${cls}__fill`,
      cx: String(size / 2),
      cy: String(size / 2),
      r: String(r),
      pathLength: "100",
      "stroke-dasharray": `${(75 * p).toFixed(2)} 100`,
      transform: `rotate(135 ${size / 2} ${size / 2})`,
    }),
  );
}

function star() {
  return h(
    "svg",
    { class: "star", viewBox: "0 0 20 20", width: "16", height: "16", "aria-hidden": "true" },
    h("path", { d: "M10 1.5l2.6 5.5 6 .8-4.4 4.1 1.1 5.9L10 15l-5.3 2.8 1.1-5.9L1.4 7.8l6-.8z" }),
  );
}

function move(entry) {
  if (entry.prevPublic === null || entry.prevPublic === undefined)
    return h("span", { class: "move move--new" }, h("span", { class: "sr-only" }, "새로 들어옴 "), "NEW");
  const d = entry.prevPublic - entry.rank;
  if (d > 0) return h("span", { class: "move move--up" }, h("span", { class: "sr-only" }, "지난주보다 "), `▲${d}`);
  if (d < 0) return h("span", { class: "move move--down" }, h("span", { class: "sr-only" }, "지난주보다 "), `▼${-d}`);
  const same = entry.first ? "첫 집계" : "지난주와 같음";
  return h("span", { class: "move move--same" }, h("span", { class: "sr-only" }, same), h("span", { "aria-hidden": "true" }, "-"));
}

function perkTexts(v) {
  const list = (v.benefits ?? []).filter((b) => b.text);
  const join = list.filter((b) => b.kind === "join").map((b) => b.text);
  const event = list.filter((b) => b.kind === "event").map((b) => b.text);
  return { join, event, all: list.map((b) => b.text) };
}

function goAttrs(v) {
  return { target: "_blank", rel: v.affiliate ? "noopener noreferrer sponsored nofollow" : "noopener noreferrer nofollow" };
}

function withPrevPublic(ctx) {
  const prevTop = (ctx.prevWeek?.entries ?? []).filter((e) => ctx.byId[e.id]).slice(0, PUBLIC_COUNT);
  const prevRank = Object.fromEntries(prevTop.map((e, i) => [e.id, i + 1]));
  const first = !ctx.prevWeek;
  return ctx.top.map((e) => ({ ...e, first, prevPublic: first ? e.rank : (prevRank[e.id] ?? null) }));
}

function nextMonday(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

const fullDate = (d) => `${d.slice(0, 4)}년 ${d.slice(5, 7)}월 ${d.slice(8, 10)}일`;

function basisLine(keys) {
  const labels = keys.map((k) => PARTS[k].label);
  return `${labels.filter((x) => !labels.some((y) => y !== x && x.startsWith(y))).join(" · ")} 기준`;
}

function bigCount(n) {
  return n >= 1e6 ? `${Math.round(n / 1e4).toLocaleString("ko-KR")}만` : countLabel(n);
}

function chips(page, ctx, current) {
  return h(
    "ul",
    { class: "chips" },
    ctx.picks.map((p) =>
      h(
        "li",
        null,
        h(
          "a",
          { class: "chip", href: page.url(`benefits/${p.id}/`), "aria-current": p.id === current ? "page" : null },
          p.label,
          h("span", { class: "chip__count" }, String(p.list.length), h("span", { class: "sr-only" }, "곳")),
        ),
      ),
    ),
  );
}

function clockIcon() {
  return h(
    "svg",
    { class: "clock__icon", viewBox: "0 0 16 16", width: "15", height: "15", "aria-hidden": "true" },
    h("circle", { cx: "8", cy: "8", r: "6.5", fill: "none", stroke: "currentColor", "stroke-width": "1.6" }),
    h("path", { d: "M8 4.5V8l2.4 1.6", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round" }),
  );
}

function sideExtras(page, ctx) {
  const date = ctx.week?.date ?? null;
  const next = date ? nextMonday(date) : null;
  const clock = h(
    "section",
    { class: "clock", "aria-labelledby": "clock-title" },
    h("h2", { id: "clock-title", class: "clock__label" }, clockIcon(), "다음 순위 갱신까지"),
    h(
      "p",
      { class: "clock__time" },
      h("time", { "data-next": true, datetime: next ? `${next}T10:00+09:00` : null }, next ? `${+next.slice(5, 7)}월 ${+next.slice(8, 10)}일(월) 오전` : "매주 월요일 오전"),
    ),
    h("p", { class: "clock__note" }, "매주 월요일 오전에 새로 매겨요"),
  );

  const ids = Object.keys(ctx.latest).filter((id) => ctx.byId[id]);
  const sum = (k) => ids.reduce((a, id) => a + (ctx.latest[id][k] ?? 0), 0);
  const apps = ids.filter((id) => ctx.latest[id].installs || ctx.latest[id].ratings).length;
  const weeks = ctx.ranking.weeks;
  const tiles = [
    apps ? ["앱 지표 수집", `${apps}곳`] : null,
    sum("ratings") ? ["앱 평가 수", `${bigCount(sum("ratings"))} 건`] : null,
    sum("installs") ? ["앱 설치 수", `${bigCount(sum("installs"))} 회`] : null,
    weeks.length ? ["누적 집계", `${weeks.length}주`] : null,
  ].filter(Boolean);
  const notes = [
    apps ? "앱 수치는 Google Play 공개 정보를 합친 값이에요." : null,
    weeks.length ? `${dayLabel(weeks[0].date).replace(" ", "\u00a0")}부터 매주 모아요.` : null,
  ].filter(Boolean);
  const data = tiles.length
    ? h(
        "section",
        { class: "side__box", "aria-labelledby": "data-title" },
        h("h2", { id: "data-title", class: "side__title" }, "이번 주 반영 데이터"),
        h("dl", { class: "tiles" }, tiles.map(([k, x]) => h("div", { class: "tiles__item" }, h("dt", { class: "tiles__label" }, k), h("dd", { class: "tiles__value" }, x)))),
        notes.length ? h("p", { class: "side__note" }, notes.join(" ")) : null,
      )
    : null;

  const picks = ctx.picks.length
    ? h(
        "section",
        { class: "picks", "aria-labelledby": "pick-title" },
        h("div", { class: "picks__head" }, h("h2", { id: "pick-title", class: "picks__title" }, "조건별 웹하드"), h("span", { class: "picks__basis" }, "이번 주 혜택·앱 정보 기준")),
        chips(page, ctx, null),
      )
    : null;
  return { clock, data, picks };
}

function homePage(ctx, css) {
  const page = new Page("index.html");
  const week = ctx.week;
  const scale = week?.scale ?? 1000;
  const decimals = week?.decimals ?? 0;
  const rows = withPrevPublic(ctx);
  const date = week?.date ?? null;
  const names = rows.slice(0, 3).map((e) => ctx.byId[e.id].name);
  const title = date ? `${monthLabel(date)} 웹하드 순위 TOP 10과 가입 혜택 비교 | ${BRAND}` : `웹하드 순위와 가입 혜택 비교 | ${BRAND}`;
  const description = date
    ? `${monthLabel(date)} 웹하드 순위를 공개 지표로 매주 새로 매겼어요. ${names.join(", ")} 등 상위 10곳의 총점과 가입 혜택, 이벤트를 한눈에 비교해 보세요.`
    : "웹하드 순위를 공개 지표로 매주 새로 매겨요. 상위 10곳의 총점과 가입 혜택, 이벤트를 한눈에 비교해 보세요.";
  const keys = week?.keys ?? Object.keys(PARTS);

  const entryRow = (e) => {
    const v = ctx.byId[e.id];
    const top = e.rank <= 3;
    const m = ctx.latest[v.id] ?? {};
    const tag = m.installsText ? `앱 다운로드 ${m.installsText}` : null;
    const perks = perkTexts(v);
    const main = perks.join[0] ?? perks.event[0] ?? "공식 사이트에서 확인하세요.";
    const sub = perks.join.length && perks.event.length ? perks.event.join(", ") : "상세 조건은 공식 안내 확인";
    return h(
      "li",
      { class: `entry${top ? " entry--top" : ""}` },
      h("div", { class: "entry__rank" }, h("span", { class: "entry__num" }, h("span", { class: "sr-only" }, "순위 "), String(e.rank)), move(e)),
      logo(page, v, "entry__logo"),
      h(
        "div",
        { class: "entry__info" },
        h("a", { class: "entry__name", href: page.url(`webhard/${v.id}/`) }, v.name),
        tag ? h("small", { class: "entry__tag" }, tag) : null,
        v.summary ? h("p", { class: "entry__summary" }, v.summary) : null,
      ),
      h("p", { class: "entry__benefit" }, h("span", { class: "sr-only" }, "혜택: "), main, h("small", { class: "entry__benefit-sub" }, sub)),
      h(
        "div",
        { class: "entry__score" },
        h(
          "div",
          { class: `gauge${top ? " gauge--lg" : ""}` },
          gauge(e, scale, top ? 62 : 52, "gauge"),
          h("span", { class: "gauge__value" }, h("span", { class: "sr-only" }, "총점 "), fmtPoints(e.total, decimals, false), h("span", { class: "sr-only" }, `점, ${scale}점 만점`)),
        ),
      ),
      h("a", { class: "entry__go", href: page.url(`go/${v.id}/`), ...goAttrs(v) }, h("span", { class: "sr-only" }, `${v.name} `), "사이트 확인"),
    );
  };

  const changed = ctx.prevWeek ? rows.filter((e) => e.prevPublic !== e.rank).length : null;
  const stats = [
    ["실측 기준", `웹하드 TOP ${rows.length || PUBLIC_COUNT}`],
    ["다음 정기 측정일", date ? (() => { const n = nextMonday(date); return `${+n.slice(5, 7)}월 ${+n.slice(8, 10)}일(월)`; })() : "매주 월요일"],
    ["비교 업체", `${ctx.vendors.length}곳`],
    ["이번 주 변동", changed === null ? "첫 집계" : `${changed}건`],
  ];
  const affiliate = rows.some((e) => ctx.byId[e.id].affiliate);
  const extras = sideExtras(page, ctx);

  const body = [
    h("a", { class: "skip", href: "#main" }, "본문 바로가기"),
    header(page, "home"),
    h(
      "section",
      { class: "hero wrap" },
      date ? h("p", { class: "hero__date" }, "순위 업데이트 일자 ", h("time", { datetime: date }, fullDate(date))) : null,
      h("h1", { class: "hero__title" }, date ? `${monthLabel(date)} 웹하드 순위` : "웹하드 순위"),
      h("dl", { class: "stats" }, stats.map(([k, x]) => h("div", { class: "stats__item" }, h("dt", { class: "stats__label" }, k), h("dd", { class: "stats__value" }, x)))),
    ),
    h(
      "main",
      { id: "main", class: "layout wrap" },
      h(
        "section",
        { class: "panel", "aria-labelledby": "board-title" },
        h("div", { class: "panel__head" }, h("h2", { id: "board-title", class: "panel__title" }, `웹하드 TOP ${rows.length || PUBLIC_COUNT}`), h("span", { class: "panel__basis" }, basisLine(keys))),
        rows.length ? h("ol", { class: "board__list" }, rows.map(entryRow)) : h("p", { class: "board__empty" }, "이번 주 순위를 준비하고 있어요."),
      ),
      extras.picks,
      h(
        "aside",
        { class: "side" },
        extras.clock,
        h(
          "section",
          { class: "side__box", "aria-labelledby": "side-title" },
          h("h2", { id: "side-title", class: "side__title" }, "이번 주 순위 변동"),
          h(
            "ol",
            { class: "side__list" },
            rows.slice(0, 5).map((e) =>
              h("li", { class: "side__item" }, h("a", { class: "side__link", href: page.url(`webhard/${e.id}/`) }, h("b", { class: "side__rank" }, String(e.rank)), h("span", null, ctx.byId[e.id].name), move(e))),
            ),
          ),
        ),
        extras.data,
        h(
          "section",
          { class: "guide", "aria-labelledby": "guide-title" },
          h("h2", { id: "guide-title", class: "guide__title" }, "순위는 어떻게 정하나요?"),
          h("p", { class: "guide__text" }, "검색 관심도와 앱 이용 지표 같은 공개 지표를 매주 모아 다시 매기고, 운영 기준을 일부 더해 참고용 순위를 구성해요."),
          h("a", { class: "guide__link", href: page.url("criteria/") }, "검증 기준 자세히 보기 →"),
        ),
      ),
      h(
        "p",
        { class: "notice" },
        "※ 순위는 공개 지표에 운영 기준을 일부 더한 참고 자료예요. 서비스 선택과 이용은 직접 판단하시고, 혜택과 이용 조건은 각 업체 공식 사이트에서 다시 확인해 주세요.",
        affiliate ? " 일부 바로가기는 제휴 링크예요." : "",
      ),
    ),
    footer(),
  ];

  const ld = [
    { "@context": "https://schema.org", "@type": "WebSite", name: BRAND, url: page.abs(""), inLanguage: "ko-KR" },
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: date ? `${monthLabel(date)} 웹하드 순위` : "웹하드 순위",
      ...(date ? { dateModified: date } : {}),
      itemListElement: rows.map((e) => ({ "@type": "ListItem", position: e.rank, name: ctx.byId[e.id].name, url: page.abs(`webhard/${e.id}/`) })),
    },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "웹하드 순위", item: page.abs("") }] },
  ];
  return [page, doc(page, { title, description, ld, js: [`assets/clock.js?v=${CLOCK_HASH}`] }, body, css)];
}

function sheet(page, current, eyebrow, titleText, sub, content, meta, css) {
  const body = [
    h("a", { class: "skip", href: "#main" }, "본문 바로가기"),
    header(page, current),
    h("main", { id: "main", class: "sheet wrap" }, h("span", { class: "sheet__eyebrow" }, eyebrow), h("h1", { class: "sheet__title" }, titleText), sub ? h("p", { class: "sheet__sub" }, sub) : null, content),
    footer(),
  ];
  return [page, doc(page, meta, body, css)];
}

function faqLd(list) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: list.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
}

function crumbLd(page, items) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [["웹하드 순위", ""], ...items].map(([name, path], i) => ({ "@type": "ListItem", position: i + 1, name, item: page.abs(path) })),
  };
}

function benefitsPage(ctx, css) {
  const page = new Page("benefits/index.html");
  const rows = withPrevPublic(ctx);
  const date = ctx.week?.date ?? null;
  const title = `웹하드 가입 혜택·이벤트 추천 모음${date ? ` (${dotMonth(date)})` : ""} | ${BRAND}`;
  const description = "이번 주 웹하드 순위 상위 10곳의 가입 혜택과 이벤트를 한눈에 모았어요. 혜택은 바뀔 수 있으니 방문 전에 공식 사이트에서 조건을 꼭 확인해 주세요.";
  const cards = rows.map((e) => {
    const v = ctx.byId[e.id];
    const perks = perkTexts(v);
    const label = perks.join[0] ?? perks.event[0] ?? "혜택 확인";
    const rest = perks.all.filter((t) => t !== label);
    return h(
      "li",
      { class: "card" },
      h("b", { class: "card__label" }, label),
      h("h2", { class: "card__title" }, h("a", { class: "card__title-link", href: page.url(`webhard/${v.id}/`) }, v.name)),
      h("p", { class: "card__text" }, rest.length ? `함께 진행 중인 혜택: ${rest.join(", ")}` : v.summary ?? "자세한 조건은 공식 사이트에서 확인하세요."),
      h("a", { class: "card__go", href: page.url(`go/${v.id}/`), ...goAttrs(v) }, h("span", { class: "sr-only" }, `${v.name} `), "공식 사이트"),
    );
  });
  const content = [
    ctx.picks.length ? h("nav", { class: "sheet__chips", "aria-label": "조건별 웹하드" }, chips(page, ctx, null)) : null,
    rows.length ? h("ul", { class: "cards" }, cards) : h("p", { class: "sheet__sub" }, "이번 주 혜택 정보를 준비하고 있어요."),
  ];
  return sheet(page, "benefits", "BENEFIT GUIDE", "혜택별 추천", "혜택은 변경될 수 있으므로 방문 후 공식 조건을 확인하세요.", content, { title, description, ld: [crumbLd(page, [["혜택별 추천", "benefits/"]])] }, css);
}

function pickPage(ctx, p, css) {
  const page = new Page(`benefits/${p.id}/index.html`);
  const date = ctx.week?.date ?? null;
  const top = new Set(ctx.top.map((e) => e.id));
  const title = `${p.title} ${p.list.length}곳 모음${date ? ` (${dotMonth(date)})` : ""} | ${BRAND}`;
  const description = `${p.title} ${p.list.length}곳을 이번 주 순위 순서로 모았어요. 혜택과 조건은 업체 사정에 따라 바뀔 수 있으니 방문 전에 공식 사이트에서 꼭 확인해 주세요.`;
  const place = (rank) => (rank === null ? "순위 집계 전" : rank <= PUBLIC_COUNT ? `이번 주 ${rank}위` : "이번 주 10위 밖");
  const cards = p.list.map(({ v, hit, rest, rank }) =>
    h(
      "li",
      { class: "card" },
      h("b", { class: "card__label" }, hit),
      h("h2", { class: "card__title" }, h("a", { class: "card__title-link", href: page.url(`webhard/${v.id}/`) }, v.name)),
      h("p", { class: "card__place" }, place(rank)),
      rest.length ? h("p", { class: "card__text" }, `함께 진행 중인 혜택: ${rest.join(", ")}`) : null,
      top.has(v.id) ? h("a", { class: "card__go", href: page.url(`go/${v.id}/`), ...goAttrs(v) }, h("span", { class: "sr-only" }, `${v.name} `), "공식 사이트") : null,
    ),
  );
  const content = [h("nav", { class: "sheet__chips", "aria-label": "조건별 웹하드" }, chips(page, ctx, p.id)), h("ul", { class: "cards" }, cards)];
  return sheet(
    page,
    "benefits",
    "BENEFIT GUIDE",
    p.title,
    "조건에 맞는 업체를 이번 주 순위 순서로 모았어요. 혜택은 바뀔 수 있으니 공식 조건을 확인하세요.",
    content,
    { title, description, ld: [crumbLd(page, [["혜택별 추천", "benefits/"], [p.title, `benefits/${p.id}/`]])] },
    css,
  );
}

function criteriaPage(ctx, css) {
  const page = new Page("criteria/index.html");
  const keys = ctx.week?.keys ?? Object.keys(PARTS);
  const faq = [...ctx.faq.home, ...ctx.faq.criteria];
  const title = `웹하드 순위 검증 가이드: 순위 기준과 자주 묻는 질문 | ${BRAND}`;
  const description = "파일픽 웹하드 순위를 어떤 공개 지표로 매기는지 정리한 순위 검증 가이드예요. 항목별 기준과 자주 묻는 질문, 다루는 웹하드 목록을 함께 확인해 보세요.";
  const items = [...keys.map((k) => [PARTS[k].label, PARTS[k].line]), ["운영 기준", "운영 기준에 따라 일부 업체 점수에 가산이 더해질 수 있어요."]];
  const content = [
    h("ol", { class: "cards" }, items.map(([name, line], i) => h("li", { class: "card" }, h("b", { class: "card__label" }, String(i + 1).padStart(2, "0")), h("h2", { class: "card__title" }, name), h("p", { class: "card__text" }, line)))),
    h(
      "section",
      { class: "sheet__section", "aria-labelledby": "faq-title" },
      h("h2", { id: "faq-title", class: "sheet__heading" }, "자주 묻는 질문"),
      h("ol", { class: "cards" }, faq.map((f) => h("li", { class: "card" }, h("b", { class: "card__label" }, "Q"), h("h3", { class: "card__title" }, f.q), h("p", { class: "card__text" }, f.a)))),
    ),
    h(
      "section",
      { class: "sheet__section", "aria-labelledby": "list-title" },
      h("h2", { id: "list-title", class: "sheet__heading" }, "다루는 웹하드"),
      h(
        "ul",
        { class: "peers" },
        [...ctx.vendors].sort((a, b) => a.name.localeCompare(b.name, "ko")).map((o) => h("li", null, h("a", { class: "peer", href: page.url(`webhard/${o.id}/`) }, o.name))),
      ),
    ),
  ];
  return sheet(
    page,
    "criteria",
    "RANKING STANDARD",
    "순위 검증 가이드",
    "순위는 절대적인 평가가 아닌 서비스 선택을 돕는 참고 자료입니다.",
    content,
    { title, description, ld: [faqLd(faq), crumbLd(page, [["순위 검증 가이드", "criteria/"]])] },
    css,
  );
}

function detailPage(ctx, v, css) {
  const page = new Page(`webhard/${v.id}/index.html`);
  const week = ctx.week;
  const scale = week?.scale ?? 1000;
  const decimals = week?.decimals ?? 0;
  const date = week?.date ?? null;
  const rows = withPrevPublic(ctx);
  const entry = rows.find((e) => e.id === v.id) ?? null;
  const known = ctx.entries.some((e) => e.id === v.id);
  const title = `${v.name} 순위·가입 혜택·이벤트${date ? ` (${dotMonth(date)})` : ""} | ${BRAND}`;
  const description = `${v.name}의 이번 주 웹하드 순위와 총점, 가입 혜택과 이벤트를 한곳에 정리했어요. 순위 변동과 앱 지표, 함께 볼 만한 다른 웹하드도 확인해 보세요.`;
  const perks = perkTexts(v);

  const history = ctx.ranking.weeks
    .slice(-8)
    .map((w) => {
      const list = w.entries.filter((e) => ctx.byId[e.id]);
      const at = list.findIndex((e) => e.id === v.id);
      return { date: w.date, rank: at >= 0 && at < PUBLIC_COUNT ? at + 1 : null, total: at >= 0 && at < PUBLIC_COUNT ? list[at].total : null };
    })
    .reverse();

  const facts = [];
  const m = ctx.latest[v.id] ?? {};
  if (m.installsText || m.installs) facts.push(["다운로드", m.installsText ?? `${countLabel(m.installs)}+`]);
  if (m.ratings) facts.push(["평가 수", `${countLabel(m.ratings)}개`]);
  if (m.score) facts.push(["평점", m.score.toFixed(1)]);

  const others = pick(
    rows.filter((e) => e.id !== v.id),
    5,
    `${date}:${v.id}`,
  ).sort((a, b) => a.rank - b.rank);

  const profile = h(
    "section",
    { class: "profile", "aria-label": `${v.name} 요약` },
    logo(page, v, "profile__logo"),
    entry
      ? h(
          "dl",
          { class: "profile__stats" },
          h("div", { class: "profile__stat" }, h("dt", { class: "profile__label" }, "이번 주 순위"), h("dd", { class: "profile__value" }, h("b", { class: "profile__big" }, `${entry.rank}위`), move(entry))),
          h(
            "div",
            { class: "profile__stat" },
            h("dt", { class: "profile__label" }, "총점"),
            h(
              "dd",
              { class: "profile__value" },
              h("div", { class: "gauge gauge--xl" }, gauge(entry, scale, 92, "gauge"), h("span", { class: "gauge__value" }, fmtPoints(entry.total, decimals, false))),
              h("span", { class: "profile__unit" }, `/ ${fmtPoints(scale, 0)}점`),
            ),
          ),
          h("div", { class: "profile__stat" }, h("dt", { class: "profile__label" }, "별점"), h("dd", { class: "profile__value" }, star(), h("b", { class: "profile__big" }, entry.star.toFixed(1)))),
        )
      : h("p", { class: "profile__notice" }, known ? "이번 주에는 공개 순위(10위) 밖이에요. 모든 후보가 매주 다시 겨뤄요." : "아직 순위를 매길 지표를 모으고 있어요."),
    entry ? h("a", { class: "card__go", href: page.url(`go/${v.id}/`), ...goAttrs(v) }, h("span", { class: "sr-only" }, `${v.name} `), "사이트 확인") : null,
  );

  const cards = [
    h("li", { class: "card" }, h("b", { class: "card__label" }, "가입 혜택"), h("h2", { class: "card__title" }, perks.join.join(", ") || "공식 사이트에서 확인하세요.")),
    h("li", { class: "card" }, h("b", { class: "card__label" }, "이벤트"), h("h2", { class: "card__title" }, perks.event.join(", ") || "공식 사이트에서 확인하세요.")),
    facts.length
      ? h(
          "li",
          { class: "card" },
          h("b", { class: "card__label" }, "앱 지표"),
          h("dl", { class: "facts" }, facts.map(([k, x]) => h("div", null, h("dt", { class: "facts__label" }, k), h("dd", { class: "facts__value" }, x)))),
        )
      : null,
    history.some((x) => x.rank)
      ? h(
          "li",
          { class: "card" },
          h("b", { class: "card__label" }, "순위 변동"),
          h(
            "table",
            { class: "history" },
            h("thead", null, h("tr", null, h("th", { scope: "col" }, "갱신일"), h("th", { scope: "col" }, "순위"), h("th", { scope: "col" }, "총점"))),
            h(
              "tbody",
              null,
              history.map((x) =>
                h("tr", null, h("td", null, h("time", { datetime: x.date }, dayLabel(x.date))), h("td", null, x.rank ? `${x.rank}위` : "10위 밖"), h("td", null, x.total !== null ? `${fmtPoints(x.total, decimals)}점` : "-")),
              ),
            ),
          ),
        )
      : null,
  ];

  const content = [
    profile,
    h("ul", { class: "cards" }, cards),
    others.length
      ? h(
          "section",
          { class: "sheet__section", "aria-labelledby": "others-title" },
          h("h2", { id: "others-title", class: "sheet__heading" }, "다른 웹하드도 살펴보세요"),
          h(
            "ul",
            { class: "peers" },
            others.map((e) => h("li", null, h("a", { class: "peer", href: page.url(`webhard/${e.id}/`) }, ctx.byId[e.id].name, h("span", { class: "peer__rank" }, `${e.rank}위`)))),
          ),
        )
      : null,
  ];
  const sub = date ? `${dayLabel(date)} 갱신 · 순위는 서비스 선택을 돕는 참고 자료예요.` : "순위는 서비스 선택을 돕는 참고 자료예요.";
  return sheet(
    page,
    null,
    "WEBHARD PROFILE",
    `${v.name} 순위⁠·⁠가입 혜택⁠·⁠이벤트`,
    sub,
    content,
    { title, description, ld: [crumbLd(page, [[v.name, `webhard/${v.id}/`]])] },
    css,
  );
}

function goPage(v) {
  const page = new Page(`go/${v.id}/index.html`);
  const code = Buffer.from(v.url).toString("base64").split("").reverse().join("");
  const script = `location.replace(atob("${code}".split("").reverse().join("")));`;
  const body = [
    h("main", { class: "jump" }, h("p", { class: "jump__text" }, `${v.name}로 이동하고 있어요.`), h("noscript", null, h("p", { class: "jump__text" }, "자바스크립트를 켜면 바로 이동해요."))),
    h("script", null, script),
  ];
  return [page, doc(page, { title: `${v.name}로 이동 | ${BRAND}`, robots: "noindex,nofollow" }, body, null, [script])];
}

function notFound(css) {
  const page = new Page("404.html");
  const home = ABSOLUTE ? h("a", { class: "textlink", href: `${SITE}/` }, "웹하드 순위로 가기") : null;
  const body = [h("main", { class: "lost" }, h("h1", { class: "lost__title" }, "페이지를 찾을 수 없어요"), h("p", { class: "lost__text" }, "주소가 바뀌었거나 없어진 페이지예요."), home)];
  return [page, doc(page, { title: `페이지를 찾을 수 없어요 | ${BRAND}`, robots: "noindex", style: LOST_STYLE }, body, null)];
}

function writeOut(path, text) {
  const full = join(OUT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\n{3,}/g, "\n\n");
}

export function build() {
  const ctx = load();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const draft = [
    homePage(ctx, "x"),
    benefitsPage(ctx, "x"),
    ...ctx.picks.map((p) => pickPage(ctx, p, "x")),
    criteriaPage(ctx, "x"),
    ...ctx.vendors.map((v) => detailPage(ctx, v, "x")),
  ];
  const textForFonts = draft.map(([, html]) => html.replace(/<[^>]+>/g, " ")).join("") + "0123456789▲▼-·→©";
  const fonts = fontFaces(textForFonts);
  const css = [fonts.css, stripComments(readFileSync("src/site.css", "utf8")).trim(), tintStyles(ctx.vendors)].join("\n\n") + "\n";
  const cssHash = hashOf(css).slice(0, 10);
  writeOut("assets/site.css", css);
  writeOut("assets/clock.js", CLOCK_JS);
  mkdirSync(join(OUT, "assets/fonts"), { recursive: true });
  for (const f of fonts.files) copyFileSync(`assets/fonts/${f}`, join(OUT, "assets/fonts", f));
  copyFileSync("assets/fonts/LICENSE.txt", join(OUT, "assets/fonts/LICENSE.txt"));
  for (const f of ["mark.svg", "share.png"]) if (existsSync(`assets/${f}`)) copyFileSync(`assets/${f}`, join(OUT, "assets", f));
  if (existsSync("assets/logo")) {
    mkdirSync(join(OUT, "assets/logo"), { recursive: true });
    for (const f of readdirSync("assets/logo")) if (ctx.byId[f.replace(/\.webp$/, "")]) copyFileSync(`assets/logo/${f}`, join(OUT, "assets/logo", f));
  }

  const pages = [
    homePage(ctx, cssHash),
    benefitsPage(ctx, cssHash),
    ...ctx.picks.map((p) => pickPage(ctx, p, cssHash)),
    criteriaPage(ctx, cssHash),
    ...ctx.vendors.map((v) => detailPage(ctx, v, cssHash)),
    notFound(cssHash),
  ];
  for (const e of ctx.top) pages.push(goPage(ctx.byId[e.id]));
  for (const [page, html] of pages) writeOut(page.path, html);

  const date = ctx.week?.date;
  const robots = ["User-agent: *", "Allow: /", "Disallow: /go/"];
  if (ABSOLUTE) robots.push(`Sitemap: ${SITE}/sitemap.xml`);
  writeOut("robots.txt", robots.join("\n") + "\n");
  if (ABSOLUTE) {
    const urls = [
      ["", date],
      ["benefits/", date],
      ...ctx.picks.map((p) => [`benefits/${p.id}/`, date]),
      ["criteria/", null],
      ...ctx.vendors.map((v) => [`webhard/${v.id}/`, date]),
    ];
    writeOut(
      "sitemap.xml",
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...urls.flatMap(([u, d]) => ["  <url>", `    <loc>${SITE}/${u}</loc>`, ...(d ? [`    <lastmod>${d}</lastmod>`] : []), "  </url>"]),
        "</urlset>",
      ].join("\n") + "\n",
    );
  }
  const scale = ctx.week?.scale ?? 1000;
  const decimals = ctx.week?.decimals ?? 0;
  writeOut(
    "llms.txt",
    [
      `# ${BRAND}`,
      "",
      "> 국내 웹하드 순위를 매주 공개 지표로 다시 매기는 한국어 정보 사이트예요.",
      "",
      "## 페이지",
      "",
      "- [웹하드 순위](./): 이번 주 상위 10곳과 가입 혜택",
      "- [혜택별 추천](benefits/): 상위 10곳의 가입 혜택과 이벤트",
      ...ctx.picks.map((p) => `- [${p.title}](benefits/${p.id}/): 조건에 맞는 ${p.list.length}곳`),
      "- [순위 검증 가이드](criteria/): 순위 항목과 자주 묻는 질문",
      ...ctx.vendors.map((v) => `- [${v.name}](webhard/${v.id}/): ${v.name} 순위와 가입 혜택`),
      ...(date
        ? ["", `## 이번 주 순위 (${date})`, "", ...ctx.top.map((e, i) => `${i + 1}. ${ctx.byId[e.id].name}: ${fmtPoints(e.total, decimals)}점 / ${fmtPoints(scale, 0)}점`)]
        : []),
    ].join("\n") + "\n",
  );

  const problems = [];
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
  for (const file of [...walk(OUT), ...walk(DATA)]) {
    if (!/\.(html|css|txt|xml|json|svg)$/.test(file)) continue;
    const hits = blockedLines(readFileSync(file, "utf8"));
    for (const line of hits) problems.push(`${file}:${line}`);
  }
  if (problems.length) {
    console.error("다루지 않는 업체가 들어 있어 빌드를 멈춥니다:");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`빌드 완료: 페이지 ${pages.length}개, 글꼴 ${fonts.files.length}개${ABSOLUTE ? "" : " (상대 주소)"}`);
}

if (process.argv[1]?.endsWith("compose.mjs")) build();
