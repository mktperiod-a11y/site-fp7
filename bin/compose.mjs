import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PARTS, PUBLIC_COUNT, readJson } from "./tally.mjs";
import { blockedLines } from "./guard.mjs";

export const PLACEHOLDER = "https://e097fv9iz.invalid";
const BRAND = "파일픽";
const SCRIPTS = Object.fromEntries(
  ["clock", "rail"].map((name) => {
    const text = readFileSync(`src/${name}.js`, "utf8");
    return [name, { text, src: `assets/${name}.js?v=${createHash("sha256").update(text).digest("hex").slice(0, 10)}` }];
  }),
);
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
  {
    id: "points",
    label: "가입 포인트",
    title: "가입 포인트 높은 웹하드",
    order: "가입 포인트가 높은 순서",
    benefit: (b) => b.kind === "join" && /\d\s*[PB]$/.test(b.text),
    amount: (t) => Number(t.match(/([\d,]+)\s*[PB]$/)?.[1].replace(/,/g, "") ?? 0),
  },
  { id: "100won", label: "100원 이용권", title: "100원 이용권 주는 웹하드", benefit: (b) => /(^|[^\d,])100원/.test(b.text) },
  { id: "payback", label: "페이백 이벤트", title: "페이백 이벤트 하는 웹하드", benefit: (b) => /페이백/.test(b.text) },
  { id: "app", label: "앱 설치·리뷰 혜택", title: "앱 설치·리뷰 혜택 주는 웹하드", benefit: (b) => /앱/.test(b.text) },
  { id: "triple", label: "3배 혜택 행사", title: "3배 혜택 행사 하는 웹하드", benefit: (b) => /3배/.test(b.text) },
];

// 혜택별 추천 탭에 보이는 조건(전체 탭은 따로 있음)
const PICK_TABS = ["points", "100won", "payback"];

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
    .sort(
      (a, b) =>
        (p.amount ? p.amount(b.hit) - p.amount(a.hit) : 0) || (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.v.name.localeCompare(b.v.name, "ko"),
    );
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
  ctx.picks = PICKS.filter((p) => PICK_TABS.includes(p.id))
    .map((p) => ({ ...p, list: pickList(ctx, p) }))
    .filter((p) => p.list.length >= 2);
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
  "body{margin:0;padding:48px 16px;background:#f7f5f2;color:#221d1a;font-family:system-ui,sans-serif;line-height:1.6}",
  "a{display:inline-flex;align-items:center;min-height:44px;color:#c73d00;font-weight:600}",
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
    { class: "pick__symbol", viewBox: "0 0 40 40", "aria-hidden": "true" },
    h(
      "defs",
      null,
      h(
        "linearGradient",
        { id: "pick-tone", x1: "0", y1: "0", x2: "0", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#ff9050" }),
        h("stop", { offset: "1", "stop-color": "#ff5a1f" }),
      ),
    ),
    h("path", { d: "M3 13a3 3 0 0 1 3-3h8l3 3h17a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Z", fill: "#221e1b" }),
    h(
      "g",
      { transform: "translate(14 3) rotate(12 10 12.5)" },
      h("path", { d: "M3 0h10l7 7v15a3 3 0 0 1-3 3H3a3 3 0 0 1-3-3V3a3 3 0 0 1 3-3Z", fill: "url(#pick-tone)" }),
      h("path", { d: "M13 0v4a3 3 0 0 0 3 3h4Z", fill: "#d84000" }),
    ),
    h("path", { d: "M3 20a3 3 0 0 1 3-3h28a3 3 0 0 1 3 3v13a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Z", fill: "#3a332e" }),
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
        h("span", { class: "pick__word" }, h("b", { class: "pick__name" }, "파일", h("span", { class: "pick__accent" }, "픽")), h("small", { class: "pick__tag" }, "웹하드 순위·혜택 비교")),
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

const LOGO_AREA = 3100;
const LOGO_INK = readJson("assets/logo/ink.json", {});

function webpSize(file) {
  const b = readFileSync(file);
  const kind = b.toString("ascii", 12, 16);
  if (kind === "VP8X") return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (kind === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  const n = b.readUInt32LE(21);
  return [1 + (n & 0x3fff), 1 + ((n >> 14) & 0x3fff)];
}

// 게시 파일 이름은 내용 해시라 원래 이름이 남지 않는다.
const logoName = (id) => `${hashOf(readFileSync(`assets/logo/${id}.webp`)).slice(0, 12)}.webp`;

function logo(page, v, cls) {
  const file = `assets/logo/${v.id}.webp`;
  if (existsSync(file)) {
    const [w, h0] = webpSize(file);
    const ratio = w / h0;
    // 업체 페이지 머리 로고는 원본보다 키우지 않는다(높이 64px까지).
    const area = LOGO_AREA * Math.min(1.35, Math.max(0.8, Math.sqrt(0.45 / (LOGO_INK[v.id] ?? 0.45))));
    // 아주 긴 글씨 로고는 넓이를 맞춰도 커 보여서 가로 126px에서 멈춘다.
    const height = cls === "vhead__logo" ? Math.min(h0, 64) : Math.round(Math.min(Math.sqrt(area * ratio), 126) / ratio);
    const width = Math.round(height * ratio);
    return h(
      "span",
      { class: `logo ${cls}` },
      h("img", { class: "logo__img", src: page.url(`assets/logo/${logoName(v.id)}`), width: String(width), height: String(height), alt: `${v.name} 로고`, decoding: "async" }),
    );
  }
  return h("span", { class: `logo logo--empty ${cls}`, "aria-hidden": "true" });
}

let gaugeCount = 0;

// 호를 따라 밝은 주황에서 짙은 주황으로 이어지게, 짧은 조각을 이어 그리고 점수만큼만 보이게 가린다.
const GAUGE_TONE = [
  [255, 176, 112],
  [255, 74, 10],
];

function gauge(entry, scale, size, cls) {
  const p = Math.max(0, Math.min(1, entry.total / scale));
  const c = size / 2;
  const r = c - 5;
  const id = `gauge-mask-${++gaugeCount}`;
  const pieces = 30;
  const at = (deg) => [c + r * Math.cos((deg * Math.PI) / 180), c + r * Math.sin((deg * Math.PI) / 180)].map((n) => n.toFixed(2));
  const tone = (t) => `rgb(${GAUGE_TONE[0].map((a, i) => Math.round(a + (GAUGE_TONE[1][i] - a) * t)).join(" ")})`;
  const arc = (from, to) => {
    const [x1, y1] = at(from);
    const [x2, y2] = at(to);
    return `M${x1} ${y1}A${r} ${r} 0 0 1 ${x2} ${y2}`;
  };
  const step = 270 / pieces;
  const segments = Array.from({ length: pieces }, (_, i) =>
    h("path", { d: arc(135 + i * step - (i ? 0.6 : 8), 135 + (i + 1) * step), stroke: tone(i / (pieces - 1)) }),
  );
  return h(
    "svg",
    { class: `${cls}__svg`, viewBox: `0 0 ${size} ${size}`, width: String(size), height: String(size), "aria-hidden": "true" },
    h(
      "defs",
      null,
      h(
        "mask",
        { id, maskUnits: "userSpaceOnUse", x: "0", y: "0", width: String(size), height: String(size) },
        h("circle", {
          class: `${cls}__fill`,
          cx: String(c),
          cy: String(c),
          r: String(r),
          pathLength: "100",
          "stroke-dasharray": `${(75 * p).toFixed(2)} 100`,
          transform: `rotate(135 ${c} ${c})`,
        }),
      ),
    ),
    h("circle", {
      class: `${cls}__track`,
      cx: String(c),
      cy: String(c),
      r: String(r),
      pathLength: "100",
      "stroke-dasharray": "75 100",
      transform: `rotate(135 ${c} ${c})`,
    }),
    h("g", { class: `${cls}__tone`, mask: `url(#${id})` }, segments),
  );
}

function move(entry) {
  if (entry.prevPublic === null || entry.prevPublic === undefined)
    return h("span", { class: "move move--new" }, h("span", { class: "sr-only" }, "새로 들어옴 "), "NEW");
  const d = entry.prevPublic - entry.rank;
  if (d > 0) return h("span", { class: "move move--up" }, h("span", { class: "sr-only" }, "지난주보다 "), `▲${d}`);
  if (d < 0) return h("span", { class: "move move--down" }, h("span", { class: "sr-only" }, "지난주보다 "), `▼${-d}`);
  const same = entry.first ? "첫 집계" : "지난주와 같음";
  return h("span", { class: "move move--same sr-only" }, same);
}

function giftIcon() {
  return h(
    "svg",
    { class: "perk-rows__icon", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linejoin": "round", "aria-hidden": "true" },
    h("rect", { x: "2.5", y: "7", width: "11", height: "7", rx: "1.5" }),
    h("path", { d: "M1.8 4.5h12.4V7H1.8ZM8 4.5V14M8 4.5C6.4 1.6 3.6 2.4 5.2 4.5M8 4.5c1.6-2.9 4.4-2.1 2.8 0" }),
  );
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

function bigCount(n) {
  return n >= 1e6 ? `${Math.round(n / 1e4).toLocaleString("ko-KR")}만` : countLabel(n);
}

function chips(page, ctx, current) {
  const all = ctx.vendors.filter((v) => perkTexts(v).all.length).length;
  return h(
    "ul",
    { class: "chips" },
    h(
      "li",
      null,
      h(
        "a",
        { class: "chip", href: page.url("benefits/"), "aria-current": current === "all" ? "page" : null },
        "전체",
        h("span", { class: "chip__count" }, String(all), h("span", { class: "sr-only" }, "곳")),
      ),
    ),
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

function sideExtras(page, ctx) {
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
        h("h2", { id: "data-title", class: "side__title" }, "집계에 쓴 데이터"),
        h("dl", { class: "facts-list" }, tiles.map(([k, x]) => h("div", { class: "facts-list__row" }, h("dt", { class: "facts-list__label" }, k), h("dd", { class: "facts-list__value" }, x)))),
        notes.length ? h("p", { class: "side__note" }, notes.join(" ")) : null,
      )
    : null;

  const picks = ctx.picks.length
    ? h(
        "section",
        { class: "picks", "aria-labelledby": "pick-title" },
        h("div", { class: "picks__head" }, h("h2", { id: "pick-title", class: "picks__title" }, "혜택 조건으로 찾기"), h("span", { class: "picks__basis" }, "이번 주 혜택·앱 정보 기준")),
        chips(page, ctx, null),
      )
    : null;
  return { data, picks };
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

  const arrow = (d) => h("svg", { class: "entry__icon", viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true" }, h("path", { d, fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" }));
  const entryRow = (e) => {
    const v = ctx.byId[e.id];
    const top = e.rank <= 3;
    const perks = perkTexts(v);
    const perkRows = [
      ["join", "가입 혜택", perks.join[0]],
      ["event", "기타 혜택", perks.event[0]],
    ].filter(([, , t]) => t);
    return h(
      "li",
      { class: `entry${top ? " entry--top" : ""}${[...v.name].length > 8 ? " entry--long" : ""}` },
      h("div", { class: "entry__rank" }, h("span", { class: "entry__num" }, h("span", { class: "sr-only" }, "순위 "), String(e.rank)), move(e)),
      logo(page, v, "entry__logo"),
      h(
        "div",
        { class: "entry__info" },
        h("a", { class: "entry__name", href: page.url(`webhard/${v.id}/`) }, v.name),
        v.summary ? h("p", { class: "entry__summary" }, v.summary) : null,
      ),
      h(
        "div",
        { class: "entry__foot" },
        h(
          "div",
          { class: "entry__benefit" },
          perkRows.length
            ? h(
                "dl",
                { class: "perk-rows" },
                perkRows.map(([kind, label, t]) =>
                  h("div", { class: `perk-rows__row perk-rows__row--${kind}` }, h("dt", { class: "perk-rows__label sr-only" }, label), h("dd", { class: `perk-rows__value perk-rows__value--${kind}` }, h("span", { class: `perk-chip perk-chip--${kind}` }, giftIcon(), h("span", { class: "perk-chip__text" }, t)))),
                ),
              )
            : h("span", { class: "entry__none" }, "공식 사이트에서 확인하세요."),
        ),
        h(
          "div",
          { class: "entry__actions" },
          h(
            "a",
            { class: "entry__go", href: page.url(`go/${v.id}/`), ...goAttrs(v) },
            h("span", { class: "sr-only" }, `${v.name} `),
            h("span", { class: "entry__face" }, "사이트 확인", arrow("M6 4l4 4-4 4")),
          ),
          h(
            "a",
            { class: "entry__more", href: page.url(`webhard/${v.id}/`) },
            h("span", { class: "sr-only" }, `${v.name} `),
            h("span", { class: "entry__face" }, "상세 정보", arrow("M6 4l4 4-4 4")),
          ),
        ),
      ),
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
    );
  };

  const changed = ctx.prevWeek ? rows.filter((e) => e.prevPublic !== e.rank).length : null;
  const stats = [
    ["실측 기준", `웹하드 TOP ${rows.length || PUBLIC_COUNT}`],
    [
      "다음 정기 갱신",
      [
        date ? (() => { const n = nextMonday(date); return `${+n.slice(5, 7)}월 ${+n.slice(8, 10)}일(월)`; })() : "매주 월요일",
        h("span", { class: "stats__note", "data-next": true }),
        h("span", { class: "stats__note stats__note--short", "data-next-short": true }),
      ],
    ],
    ["비교 업체", `${ctx.vendors.length}곳`],
    ["이번 주 변동", changed === null ? "첫 집계" : `${changed}건`],
  ];
  const affiliate = rows.some((e) => ctx.byId[e.id].affiliate);
  const extras = sideExtras(page, ctx);
  const moved = rows.filter((e) => !e.first && e.prevPublic !== e.rank).slice(0, 5);

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
        h("div", { class: "panel__head" }, h("h2", { id: "board-title", class: "panel__title" }, `웹하드 TOP ${rows.length || PUBLIC_COUNT}`)),
        rows.length
          ? h(
              "div",
              { class: "board__body" },
              h(
                "div",
                { class: "entry entry--head", "aria-hidden": "true" },
                h("span", { class: "entry__rank" }, "순위"),
                h("span", { class: "entry__logo" }, "웹하드"),
                h("span", { class: "entry__benefit" }, "혜택"),
                h("span", { class: "entry__score" }, "총점"),
              ),
              h("ol", { class: "board__list" }, rows.map(entryRow)),
            )
          : h("p", { class: "board__empty" }, "이번 주 순위를 준비하고 있어요."),
      ),
      extras.picks,
      h(
        "aside",
        { class: "side" },
        h(
          "section",
          { class: "side__box", "aria-labelledby": "side-title" },
          h("div", { class: "side__head" }, h("h2", { id: "side-title", class: "side__title" }, "이번 주 순위 변동"), h("span", { class: "side__basis" }, "총점 높은 순")),
          moved.length
            ? h(
                "ol",
                { class: "side__list" },
                moved.map((e) =>
                  h(
                    "li",
                    { class: "side__item" },
                    h("a", { class: "side__link", href: page.url(`webhard/${e.id}/`) }, h("b", { class: "side__rank" }, String(e.rank)), h("span", null, ctx.byId[e.id].name), move(e)),
                  ),
                ),
              )
            : h("p", { class: "side__empty" }, "이번 주 순위 변동이 없어요."),
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
  return [page, doc(page, { title, description, ld, js: [SCRIPTS.clock.src] }, body, css)];
}

function sheet(page, current, eyebrow, titleText, sub, content, meta, css) {
  const body = [
    h("a", { class: "skip", href: "#main" }, "본문 바로가기"),
    header(page, current),
    h(
      "main",
      { id: "main", class: "sheet wrap" },
      meta.crumbs ?? null,
      meta.hero ?? [h("span", { class: "sheet__eyebrow" }, eyebrow), h("h1", { class: "sheet__title" }, titleText), sub ? h("p", { class: "sheet__sub" }, sub) : null],
      content,
    ),
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
  const order = new Map(ctx.entries.map((e) => [e.id, e.rank]));
  const top = new Set(ctx.top.map((e) => e.id));
  const list = ctx.vendors
    .filter((v) => perkTexts(v).all.length)
    .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || a.name.localeCompare(b.name, "ko"));
  const date = ctx.week?.date ?? null;
  const title = `웹하드 가입 혜택·이벤트 전체 모음${date ? ` (${dotMonth(date)})` : ""} | ${BRAND}`;
  const description = `웹하드 ${list.length}곳의 가입 포인트, 100원 이용권 같은 가입 혜택과 이벤트를 이번 주 순위 순서로 한눈에 모았어요. 혜택은 바뀔 수 있으니 방문 전에 공식 사이트에서 조건을 꼭 확인해 주세요.`;
  const place = (id) => (top.has(id) ? `이번 주 ${order.get(id)}위` : null);
  const cards = list.map((v) => {
    const perks = perkTexts(v);
    const label = perks.join[0] ?? perks.event[0] ?? "혜택 확인";
    const rest = perks.all.filter((t) => t !== label);
    return h(
      "li",
      { class: "card card--pick" },
      h("b", { class: "card__label" }, label),
      h(
        "div",
        { class: "card__head" },
        h("h2", { class: "card__title" }, h("a", { class: "card__title-link", href: page.url(`webhard/${v.id}/`) }, v.name)),
        place(v.id) ? h("span", { class: "card__place" }, place(v.id)) : null,
      ),
      rest.length ? h("p", { class: "card__text" }, `함께 진행 중인 혜택: ${rest.join(", ")}`) : h("p", { class: "card__text card__text--none" }, "다른 혜택은 공식 사이트에서 확인하세요."),
      v.url ? h("a", { class: "card__go", href: page.url(`go/${v.id}/`), ...goAttrs(v) }, h("span", { class: "sr-only" }, `${v.name} `), "공식 사이트") : null,
    );
  });
  const content = [
    h("nav", { class: "sheet__chips", "aria-label": "조건별 웹하드" }, chips(page, ctx, "all")),
    list.length ? h("ul", { class: "cards" }, cards) : h("p", { class: "sheet__sub" }, "이번 주 혜택 정보를 준비하고 있어요."),
  ];
  return sheet(page, "benefits", "BENEFIT GUIDE", "혜택별 추천", "이번 주 순위 순서로 혜택이 있는 웹하드를 모두 모았어요. 혜택은 바뀔 수 있으니 공식 조건을 확인하세요.", content, { title, description, ld: [crumbLd(page, [["혜택별 추천", "benefits/"]])] }, css);
}

function pickPage(ctx, p, css) {
  const page = new Page(`benefits/${p.id}/index.html`);
  const date = ctx.week?.date ?? null;
  const title = `${p.title} ${p.list.length}곳 모음${date ? ` (${dotMonth(date)})` : ""} | ${BRAND}`;
  const description = `${p.title} ${p.list.length}곳을 ${p.order ?? "이번 주 순위 순서"}로 모았어요. 혜택과 조건은 업체 사정에 따라 바뀔 수 있으니 방문 전에 공식 사이트에서 꼭 확인해 주세요.`;
  const place = (rank) => (rank !== null && rank <= PUBLIC_COUNT ? `이번 주 ${rank}위` : null);
  const cards = p.list.map(({ v, hit, rest, rank }) =>
    h(
      "li",
      { class: "card card--pick" },
      h("b", { class: "card__label" }, hit),
      h(
        "div",
        { class: "card__head" },
        h("h2", { class: "card__title" }, h("a", { class: "card__title-link", href: page.url(`webhard/${v.id}/`) }, v.name)),
        place(rank) ? h("span", { class: "card__place" }, place(rank)) : null,
      ),
      rest.length ? h("p", { class: "card__text" }, `함께 진행 중인 혜택: ${rest.join(", ")}`) : h("p", { class: "card__text card__text--none" }, "다른 혜택은 공식 사이트에서 확인하세요."),
      v.url ? h("a", { class: "card__go", href: page.url(`go/${v.id}/`), ...goAttrs(v) }, h("span", { class: "sr-only" }, `${v.name} `), "공식 사이트") : null,
    ),
  );
  const content = [h("nav", { class: "sheet__chips", "aria-label": "조건별 웹하드" }, chips(page, ctx, p.id)), h("ul", { class: "cards" }, cards)];
  return sheet(
    page,
    "benefits",
    "BENEFIT GUIDE",
    p.title,
    `조건에 맞는 업체를 ${p.order ?? "이번 주 순위 순서"}로 모았어요. 혜택은 바뀔 수 있으니 공식 조건을 확인하세요.`,
    content,
    { title, description, ld: [crumbLd(page, [["혜택별 추천", "benefits/"], [p.title, `benefits/${p.id}/`]])] },
    css,
  );
}

function rail(page, ctx, id, heading, sub, skip = null) {
  const order = new Map(ctx.entries.map((e) => [e.id, e.rank]));
  const list = ctx.vendors.filter((o) => o.id !== skip).sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || a.name.localeCompare(b.name, "ko"));
  const place = (r) => (r !== undefined && r <= PUBLIC_COUNT ? `이번 주 ${r}위` : null);
  return h(
    "section",
    { class: "rail", "aria-labelledby": id, "data-rail": true },
    h(
      "div",
      { class: "rail__head" },
      h("div", null, h("h2", { id, class: "rail__title" }, heading), h("p", { class: "rail__sub" }, sub)),
      h(
        "div",
        { class: "rail__nav" },
        h("button", { class: "rail__btn", type: "button", "data-dir": "-1", "aria-label": "이전 웹하드", hidden: true }, "‹"),
        h("button", { class: "rail__btn", type: "button", "data-dir": "1", "aria-label": "다음 웹하드", hidden: true }, "›"),
      ),
    ),
    h(
      "ul",
      { class: "rail__list" },
      list.map((o) =>
        h(
          "li",
          { class: "rail__item" },
          h("a", { class: "rail__card", href: page.url(`webhard/${o.id}/`) }, logo(page, o, "rail__logo"), h("b", { class: "rail__name" }, o.name), place(order.get(o.id)) ? h("span", { class: "card__place rail__place" }, place(order.get(o.id))) : null),
        ),
      ),
    ),
  );
}

function criteriaPage(ctx, css) {
  const page = new Page("criteria/index.html");
  const keys = ctx.week?.keys ?? Object.keys(PARTS);
  const faq = [...ctx.faq.home, ...ctx.faq.criteria];
  const title = `웹하드 순위 검증 가이드: 순위 기준과 자주 묻는 질문 | ${BRAND}`;
  const description = "파일픽 웹하드 순위를 어떤 공개 지표로 매기는지 정리한 순위 검증 가이드예요. 항목별 기준과 자주 묻는 질문, 다루는 웹하드 목록을 함께 확인해 보세요.";
  const items = [...keys.map((k) => [PARTS[k].label, PARTS[k].line]), ["운영 기준", "운영 기준에 따라 일부 업체 점수에 가산이 더해질 수 있어요."]];
  const toc = [
    ["평가 항목", items.length, "#rules"],
    ["자주 묻는 질문", faq.length, "#faq-title"],
    ["다른 웹하드", ctx.vendors.length, "#list-title"],
  ];
  const content = [
    h(
      "nav",
      { class: "sheet__chips", "aria-label": "가이드 목차" },
      h(
        "ul",
        { class: "chips" },
        toc.map(([label, n, href]) => h("li", null, h("a", { class: "chip", href }, label, h("span", { class: "chip__count" }, String(n), h("span", { class: "sr-only" }, "개"))))),
      ),
    ),
    h("ol", { class: "cards", id: "rules" }, items.map(([name, line], i) => h("li", { class: "card" }, h("b", { class: "card__label" }, String(i + 1).padStart(2, "0")), h("h2", { class: "card__title" }, name), h("p", { class: "card__text" }, line)))),
    h(
      "section",
      { class: "sheet__section", "aria-labelledby": "faq-title" },
      h("h2", { id: "faq-title", class: "sheet__heading" }, "자주 묻는 질문"),
      h("ol", { class: "cards" }, faq.map((f) => h("li", { class: "card" }, h("b", { class: "card__label" }, "Q"), h("h3", { class: "card__title" }, f.q), h("p", { class: "card__text" }, f.a)))),
    ),
    rail(page, ctx, "list-title", "다른 웹하드 보러 가기", "이번 주 순위 순서예요. 옆으로 넘겨 보세요."),
  ];
  return sheet(
    page,
    "criteria",
    "RANKING STANDARD",
    "순위 검증 가이드",
    "순위는 절대적인 평가가 아닌 서비스 선택을 돕는 참고 자료입니다.",
    content,
    { title, description, js: [SCRIPTS.rail.src], ld: [faqLd(faq), crumbLd(page, [["순위 검증 가이드", "criteria/"]])] },
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
  const title = `${v.name} 순위·가입 혜택·이벤트${date ? ` (${dotMonth(date)})` : ""} | ${BRAND}`;
  const description = `${v.name}의 이번 주 웹하드 순위와 총점, 가입 혜택과 이벤트를 한곳에 정리했어요. 순위 변동과 앱 지표, 함께 볼 만한 다른 웹하드도 확인해 보세요.`;
  const perks = perkTexts(v);
  const m = ctx.latest[v.id] ?? {};
  const none = "확인되지 않았어요";


  const tags = [v.company?.kcc ? "부가통신사업자 등록" : null].filter(Boolean);

  const top = h(
    "div",
    { class: "vlayout vtop" },
    h(
      "section",
      { class: "vinfo", "aria-label": `${v.name} 소개` },
      h("b", { class: "vinfo__label" }, "서비스 소개"),
      h("p", { class: "vinfo__summary" }, v.summary ?? `${v.name}의 순위와 혜택, 앱 지표를 한곳에 모았어요.`),
      tags.length ? h("ul", { class: "profile__tags" }, tags.map((t) => h("li", { class: "profile__tag" }, t))) : null,
      h(
        "dl",
        { class: "vinfo__facts" },
        [
          ["가입 혜택", perks.join[0] ? h("span", { class: "perk-chip perk-chip--join" }, giftIcon(), h("span", { class: "perk-chip__text" }, perks.join[0])) : null],
          ["기타 혜택", perks.event[0] ? h("span", { class: "perk-chip perk-chip--event" }, giftIcon(), h("span", { class: "perk-chip__text" }, perks.event[0])) : null],
          ["도메인 등록", v.domainYear ? `${v.domainYear}년` : null],
        ].map(([k, val]) => h("div", { class: "vinfo__fact" }, h("dt", { class: "vinfo__fact-label" }, k), h("dd", { class: "vinfo__fact-value" }, val ?? "-"))),
      ),
    ),
    h(
      "section",
      { class: "vstat", "aria-label": `${v.name} 이번 주 순위` },
      entry
        ? h(
            "dl",
            { class: "vstat__list" },
            h("div", { class: "vstat__item" }, h("dt", { class: "vstat__label" }, "이번 주 순위"), h("dd", { class: "vstat__value" }, h("b", { class: "vstat__big" }, `${entry.rank}위`), move(entry))),
            h(
              "div",
              { class: "vstat__item" },
              h("dt", { class: "vstat__label" }, "총점"),
              h(
                "dd",
                { class: "vstat__value" },
                h("div", { class: "gauge gauge--lg" }, gauge(entry, scale, 62, "gauge"), h("span", { class: "gauge__value" }, fmtPoints(entry.total, decimals, false))),
              ),
            ),
          )
        : h("p", { class: "profile__notice" }, "순위는 매주 공개 지표로 다시 매겨요. 혜택과 이용 조건은 공식 사이트에서 확인해 주세요."),
      entry ? h("a", { class: "card__go vstat__go", href: page.url(`go/${v.id}/`), ...goAttrs(v) }, h("span", { class: "sr-only" }, `${v.name} `), "사이트 확인") : null,
    ),
  );

  const section = (id, heading, ...body) => h("section", { class: "vsec", "aria-labelledby": id }, h("h2", { id, class: "vsec__title" }, heading), ...body);

  const perkBox = (label, list) =>
    h(
      "div",
      { class: "perk" },
      h("b", { class: "perk__label" }, label),
      list.length ? h("ul", { class: "perk__list" }, list.map((t) => h("li", { class: "perk__item" }, t))) : h("p", { class: "perk__empty" }, "공식 사이트에서 확인하세요."),
    );
  const perkNote = v.checked ? "공식 사이트의 가입·이벤트 안내 기준이에요. 자세한 조건은 공식 사이트에서 확인해 주세요." : "혜택은 업체 사정에 따라 바뀔 수 있어요. 가입 전에 공식 사이트에서 조건을 확인하세요.";

  const glance = [
    ["앱 다운로드", m.installsText ?? (m.installs ? `${countLabel(m.installs)}+` : null)],
    ["앱 평점", m.score ? `${m.score.toFixed(1)} / 5` : null],
    ["앱 평가 수", m.ratings ? `${countLabel(m.ratings)}개` : null],
    ...(entry ? [["비교 순위", `${ctx.entries.length}곳 중 ${entry.rank}위`]] : []),
    ["혜택 갱신", v.checked ? dayLabel(v.checked) : null],
    ["부가통신사업자", v.company?.kcc ? "등록 확인" : null],
  ];

  const info = [
    ["서비스", v.name],
    ["운영사", v.company?.name],
    ["사업자등록번호", v.company?.bizNo],
    ["부가통신사업자 등록", v.company?.kcc],
  ];

  const topic = (word) => {
    const code = word.charCodeAt(word.length - 1) - 0xac00;
    return code >= 0 && code <= 11171 ? (code % 28 ? "은" : "는") : "은(는)";
  };
  const about = [
    v.summary ? `${v.name}${topic(v.name)} ${v.summary}예요.` : null,
    entry ? `이번 주 ${BRAND} 웹하드 순위는 ${entry.rank}위, 총점은 ${fmtPoints(entry.total, decimals)}점이에요.` : null,
    m.installsText ? `Google Play 다운로드는 ${m.installsText}${m.score ? `, 앱 평점은 ${m.score.toFixed(1)}점` : ""}이에요.` : null,
    perks.all.length ? `지금 확인된 혜택은 ${perks.all.join(", ")}이고, 조건은 공식 사이트에서 다시 확인하세요.` : "확인된 혜택이 없어 공식 사이트에서 직접 확인해 주세요.",
  ].filter(Boolean);

  const main = h(
    "div",
    { class: "vmain" },
    section(
      "info-title",
      "기본 정보",
      h("dl", { class: "info" }, info.map(([k, x]) => h("div", { class: "info__row" }, h("dt", { class: "info__label" }, k), h("dd", { class: x ? "info__value" : "info__value info__value--none" }, x ?? none)))),
      h(
        "p",
        { class: "vsec__note" },
        v.company?.src
          ? "운영사와 등록번호는 공개된 사업자 정보(공식 사이트·앱 등록정보 등)를 확인해 옮긴 거예요. 확인되지 않은 항목은 비워 둬요."
          : "운영사와 등록번호는 공식 사이트에 공개된 사업자 정보를 옮긴 거예요. 못 읽은 항목은 비워 둬요.",
      ),
    ),
    section("perk-title", "혜택 정보", h("div", { class: "perks" }, perkBox("가입 혜택", perks.join), perkBox("이벤트", perks.event)), h("p", { class: "vsec__note" }, perkNote)),
    section(
      "glance-title",
      "요약 지표",
      h("dl", { class: "glance" }, glance.map(([k, x]) => h("div", { class: "glance__item" }, h("dt", { class: "glance__label" }, k), h("dd", { class: x ? "glance__value" : "glance__value glance__value--none" }, x ?? "-")))),
    ),
    section("about-title", "업체 설명", ...about.map((t) => h("p", { class: "vsec__text" }, t))),
  );

  const side = h(
    "aside",
    { class: "side side--page" },
    h(
      "section",
      { class: "guide", "aria-labelledby": "guide-title" },
      h("h2", { id: "guide-title", class: "guide__title" }, "순위는 어떻게 정하나요?"),
      h("p", { class: "guide__text" }, "검색 관심도와 앱 이용 지표 같은 공개 지표를 매주 모아 다시 매기고, 운영 기준을 일부 더해 참고용 순위를 구성해요."),
      h("a", { class: "guide__link", href: page.url("criteria/") }, "검증 기준 자세히 보기 →"),
    ),
  );

  const crumbs = h(
    "nav",
    { class: "crumbs", "aria-label": "현재 위치" },
    h("a", { class: "crumbs__link", href: page.url("") }, "웹하드 순위"),
    h("span", { class: "crumbs__sep", "aria-hidden": "true" }, "›"),
    h("span", { class: "crumbs__here", "aria-current": "page" }, v.name),
  );
  const content = [
    top,
    h("div", { class: "vlayout" }, main, side),
    rail(page, ctx, "others-title", "다른 웹하드 보러 가기", "이번 주 순위 순서예요. 옆으로 넘겨 보세요.", v.id),
  ];
  const sub = date ? `${dayLabel(date)} 갱신 · 순위는 서비스 선택을 돕는 참고 자료예요.` : "순위는 서비스 선택을 돕는 참고 자료예요.";
  return sheet(
    page,
    null,
    "WEBHARD PROFILE",
    `${v.name} 순위⁠·⁠가입 혜택⁠·⁠이벤트`,
    sub,
    content,
    {
      title,
      description,
      crumbs,
      hero: h(
        "div",
        { class: "vhead" },
        logo(page, v, "vhead__logo"),
        h("div", null, h("h1", { class: "vhead__name" }, v.name, h("span", { class: "sr-only" }, " 순위·가입 혜택·이벤트")), h("p", { class: "vhead__sub" }, sub)),
      ),
      js: [SCRIPTS.rail.src],
      bodyClass: "page--detail",
      ld: [crumbLd(page, [[v.name, `webhard/${v.id}/`]])],
    },
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
  for (const [name, { text }] of Object.entries(SCRIPTS)) writeOut(`assets/${name}.js`, text);
  mkdirSync(join(OUT, "assets/fonts"), { recursive: true });
  for (const f of fonts.files) copyFileSync(`assets/fonts/${f}`, join(OUT, "assets/fonts", f));
  copyFileSync("assets/fonts/LICENSE.txt", join(OUT, "assets/fonts/LICENSE.txt"));
  for (const f of ["mark.svg", "share.png"]) if (existsSync(`assets/${f}`)) copyFileSync(`assets/${f}`, join(OUT, "assets", f));
  if (existsSync("assets/logo")) {
    mkdirSync(join(OUT, "assets/logo"), { recursive: true });
    for (const f of readdirSync("assets/logo")) {
      const id = f.replace(/\.webp$/, "");
      if (ctx.byId[id]) copyFileSync(`assets/logo/${f}`, join(OUT, "assets/logo", logoName(id)));
    }
  }

  const pages = [
    homePage(ctx, cssHash),
    benefitsPage(ctx, cssHash),
    ...ctx.picks.map((p) => pickPage(ctx, p, cssHash)),
    criteriaPage(ctx, cssHash),
    ...ctx.vendors.map((v) => detailPage(ctx, v, cssHash)),
    notFound(cssHash),
  ];
  for (const v of ctx.vendors.filter((x) => x.url)) pages.push(goPage(v));
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
