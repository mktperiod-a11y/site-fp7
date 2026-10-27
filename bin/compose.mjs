import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PARTS, BONUS_LABEL, PUBLIC_COUNT, readJson } from "./tally.mjs";
import { blockedLines } from "./guard.mjs";

export const PLACEHOLDER = "https://e097fv9iz.invalid";
const BRAND = "파일픽";
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
  return { vendors, byId, ranking, week, prevWeek, entries, top, latest, faq };
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
    scripts.length ? `script-src ${scripts.map((s) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`).join(" ")}` : "script-src 'none'",
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
    ...(meta.style ?? []).map((t) => h("style", null, t)),
    ...(meta.ld ?? []).map((d) => h("script", { type: "application/ld+json", "data-block": true }, raw(jsonLines(d)))),
  ];
}

function mark() {
  return h(
    "svg",
    { class: "brand__mark", viewBox: "0 0 24 24", width: "24", height: "24", "aria-hidden": "true" },
    h("rect", { width: "24", height: "24", class: "brand__tile" }),
    h("rect", { x: "5", y: "13", width: "3", height: "6", class: "brand__bar" }),
    h("rect", { x: "10.5", y: "9", width: "3", height: "10", class: "brand__bar" }),
    h("rect", { x: "16", y: "5", width: "3", height: "14", class: "brand__bar" }),
  );
}

function header(page, current) {
  return h(
    "header",
    { class: "topbar" },
    h(
      "div",
      { class: "topbar__inner wrap" },
      h("a", { class: "brand", href: page.url("") }, mark(), h("span", { class: "brand__name" }, BRAND)),
      h(
        "nav",
        { class: "topnav", "aria-label": "주요 메뉴" },
        h("a", { class: "topnav__link", href: page.url(""), "aria-current": current === "home" ? "page" : null }, "웹하드 순위"),
        h(
          "a",
          { class: "topnav__link", href: page.url("criteria/"), "aria-current": current === "criteria" ? "page" : null },
          "순위 기준·FAQ",
        ),
      ),
    ),
  );
}

function footer(page) {
  return h(
    "footer",
    { class: "footer" },
    h(
      "div",
      { class: "footer__inner wrap" },
      h("p", { class: "footer__brand" }, BRAND),
      h("p", { class: "footer__note" }, "혜택과 이용 조건은 각 서비스의 공식 안내가 우선해요."),
      h(
        "p",
        { class: "footer__note" },
        "일부 업체 점수에는 운영 기준에 따른 가산이 들어갈 수 있으며, 들어간 경우 따로 표시해요.",
      ),
      h(
        "nav",
        { class: "footer__links", "aria-label": "바닥글 메뉴" },
        h("a", { class: "footer__link", href: page.url("") }, "웹하드 순위"),
        h("a", { class: "footer__link", href: page.url("criteria/") }, "순위 기준·FAQ"),
      ),
    ),
  );
}

function doc(page, meta, body, css, scripts) {
  const lines = ["<!doctype html>", '<html lang="ko">', ...render(h("head", null, headTags(page, meta, css, scripts)), 1)];
  lines.push(...render(h("body", { class: meta.bodyClass ?? null }, body), 1), "</html>");
  return lines.join("\n") + "\n";
}

function avatar(page, v, size, cls) {
  if (existsSync(`assets/icon/${v.id}.webp`))
    return h("img", { class: cls, src: page.url(`assets/icon/${v.id}.webp`), width: String(size), height: String(size), alt: "", decoding: "async" });
  return h("span", { class: `${cls} ${cls}--letter tint--${v.id}`, "aria-hidden": "true" }, [...v.name][0]);
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
    { class: "star", viewBox: "0 0 20 20", width: "14", height: "14", "aria-hidden": "true" },
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
  return h("span", { class: "move move--same" }, h("span", { class: "sr-only" }, same), h("span", { "aria-hidden": "true" }, "–"));
}

function perks(v, cls) {
  const items = (v.benefits ?? []).filter((b) => b.text);
  if (!items.length) return h("ul", { class: cls }, h("li", { class: "perk perk--none" }, "공식 사이트에서 확인하세요."));
  return h(
    "ul",
    { class: cls },
    items.map((b) => h("li", { class: `perk perk--${b.kind}` }, h("span", { class: "sr-only" }, b.kind === "join" ? "가입 혜택: " : "이벤트: "), b.text)),
  );
}

function goAttrs(v) {
  return { rel: v.affiliate ? "sponsored nofollow" : "nofollow" };
}

function withPrevPublic(ctx) {
  const prevTop = (ctx.prevWeek?.entries ?? []).filter((e) => ctx.byId[e.id]).slice(0, PUBLIC_COUNT);
  const prevRank = Object.fromEntries(prevTop.map((e, i) => [e.id, i + 1]));
  const first = !ctx.prevWeek;
  return ctx.top.map((e) => ({ ...e, first, prevPublic: first ? e.rank : (prevRank[e.id] ?? null) }));
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

  const entryRow = (e) => {
    const v = ctx.byId[e.id];
    const top = e.rank <= 3;
    const size = top ? 64 : 48;
    return h(
      "li",
      { class: `entry${top ? " entry--top" : ""}${e.rank === 1 ? " entry--first" : ""}` },
      h("div", { class: "entry__rank" }, h("span", { class: "entry__num" }, h("span", { class: "sr-only" }, "순위 "), String(e.rank)), move(e)),
      h("div", { class: "entry__who" }, avatar(page, v, top ? 48 : 40, "entry__icon"), h("a", { class: "entry__name", href: page.url(`webhard/${v.id}/`) }, v.name)),
      perks(v, "entry__perks"),
      h(
        "div",
        { class: "entry__score" },
        h(
          "div",
          { class: `gauge${top ? " gauge--lg" : ""}` },
          gauge(e, scale, size, "gauge"),
          h("span", { class: "gauge__value" }, h("span", { class: "sr-only" }, "총점 "), fmtPoints(e.total, decimals, false), h("span", { class: "sr-only" }, `점, ${scale}점 만점`)),
        ),
        e.bonus > 0 ? h("span", { class: "entry__bonus" }, BONUS_LABEL) : null,
      ),
      h("div", { class: "entry__star" }, star(), h("span", { class: "sr-only" }, "별점 "), e.star.toFixed(1)),
      h(
        "a",
        { class: "entry__go", href: page.url(`go/${v.id}/`), ...goAttrs(v) },
        h("span", { class: "entry__go-label" }, h("span", { class: "sr-only" }, `${v.name} `), h("span", { class: "entry__go-extra" }, "사이트 "), "바로가기"),
      ),
    );
  };

  const affiliate = rows.some((e) => ctx.byId[e.id].affiliate);
  const digest = [];
  if (rows[0]) digest.push(["이번 주 1위", ctx.byId[rows[0].id].name, `${fmtPoints(rows[0].total, decimals)}점`]);
  if (ctx.prevWeek) {
    const up = rows.filter((e) => e.prevPublic !== null && e.prevPublic > e.rank).sort((a, b) => b.prevPublic - b.rank - (a.prevPublic - a.rank))[0];
    digest.push(["가장 많이 오른 곳", up ? ctx.byId[up.id].name : "없음", up ? `▲${up.prevPublic - up.rank}` : ""]);
    const fresh = rows.filter((e) => e.prevPublic === null).map((e) => ctx.byId[e.id].name);
    digest.push(["새로 들어온 곳", fresh.length ? fresh.join(", ") : "없음", ""]);
  }
  if (rows.length) {
    const avg = rows.reduce((a, e) => a + e.star, 0) / rows.length;
    digest.push(["공개 10곳 평균 별점", avg.toFixed(1), ""]);
  }
  const keys = week?.keys ?? Object.keys(PARTS);

  const body = [
    h("a", { class: "skip", href: "#main" }, "본문 바로가기"),
    header(page, "home"),
    h(
      "main",
      { id: "main", class: "main" },
      h(
        "section",
        { class: "intro wrap" },
        h("h1", { class: "intro__title" }, date ? `${monthLabel(date)} 웹하드 순위` : "웹하드 순위"),
        h("p", { class: "intro__note" }, "순위는 공개 지표를 모아 정리한 참고 자료예요. 서비스 선택과 이용은 직접 판단해 주세요."),
      ),
      h(
        "section",
        { class: "board wrap", "aria-labelledby": "board-title" },
        h("h2", { id: "board-title", class: "sr-only" }, "이번 주 웹하드 순위 상위 10곳"),
        date
          ? h("p", { class: "board__status" }, h("span", { class: "board__dot", "aria-hidden": "true" }), h("time", { datetime: date }, `${dayLabel(date)} 갱신`))
          : null,
        rows.length
          ? [
              h(
                "div",
                { class: "board__head", "aria-hidden": "true" },
                ["순위", "웹하드", "가입 혜택·이벤트", "총점", "별점", "바로가기"].map((t) => h("span", { class: "board__col" }, t)),
              ),
              h("ol", { class: "board__list" }, rows.map(entryRow)),
            ]
          : h("p", { class: "board__empty" }, "이번 주 순위를 준비하고 있어요."),
        h(
          "p",
          { class: "board__foot" },
          `‘${BONUS_LABEL}’ 표시가 붙은 점수에는 운영 기준에 따른 가산점이 들어 있어요.`,
          affiliate ? " 일부 바로가기는 제휴 링크예요." : "",
        ),
      ),
      digest.length
        ? h(
            "section",
            { class: "digest wrap", "aria-labelledby": "digest-title" },
            h("h2", { id: "digest-title", class: "section-title" }, "이번 주 한눈에"),
            h(
              "dl",
              { class: "digest__grid" },
              digest.map(([k, v, x]) => h("div", { class: "digest__item" }, h("dt", { class: "digest__label" }, k), h("dd", { class: "digest__value" }, v, x ? h("span", { class: "digest__extra" }, x) : null))),
            ),
          )
        : null,
      h(
        "section",
        { class: "basis wrap", "aria-labelledby": "basis-title" },
        h("h2", { id: "basis-title", class: "section-title" }, "순위는 이렇게 매겨요"),
        h(
          "ul",
          { class: "basis__list" },
          keys.map((k) => h("li", { class: "basis__item" }, h("span", { class: "basis__name" }, PARTS[k].label), h("span", { class: "basis__line" }, PARTS[k].line))),
          h(
            "li",
            { class: "basis__item basis__item--extra" },
            h("span", { class: "basis__name" }, BONUS_LABEL),
            h("span", { class: "basis__line" }, "운영 기준에 따라 일부 업체에 더한 점수예요."),
          ),
        ),
        h("a", { class: "textlink", href: page.url("criteria/") }, "순위 기준 자세히 보기"),
      ),
      faqSection(ctx.faq.home, "faq-home"),
    ),
    footer(page),
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
    faqLd(ctx.faq.home),
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "웹하드 순위", item: page.abs("") }] },
  ];
  return [page, doc(page, { title, description, ld }, body, css)];
}

function faqSection(list, id) {
  return h(
    "section",
    { class: "faq wrap", "aria-labelledby": id },
    h("h2", { id, class: "section-title" }, "자주 묻는 질문"),
    h(
      "ol",
      { class: "faq__list" },
      list.map((f, i) =>
        h("li", { class: "faq__item" }, h("span", { class: "faq__no", "aria-hidden": "true" }, String(i + 1).padStart(2, "0")), h("h3", { class: "faq__q" }, f.q), h("p", { class: "faq__a" }, f.a)),
      ),
    ),
  );
}

function faqLd(list) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: list.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
}

function crumbs(page, name) {
  return h(
    "nav",
    { class: "crumbs wrap", "aria-label": "현재 위치" },
    h("ol", { class: "crumbs__list" }, h("li", { class: "crumbs__item" }, h("a", { class: "crumbs__link", href: page.url("") }, "웹하드 순위")), h("li", { class: "crumbs__item", "aria-current": "page" }, name)),
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
  const description = `${v.name}의 이번 주 웹하드 순위와 총점, 가입 혜택과 이벤트를 한곳에 정리했어요. 항목별 점수와 순위 변동, 함께 볼 만한 다른 웹하드도 확인해 보세요.`;

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
  if (m.installsText || m.installs) facts.push(["앱 다운로드", m.installsText ?? `${countLabel(m.installs)}+`]);
  if (m.ratings) facts.push(["앱 평가 수", `${countLabel(m.ratings)}개`]);
  if (m.score) facts.push(["앱 평점", m.score.toFixed(1)]);

  const others = pick(
    rows.filter((e) => e.id !== v.id),
    5,
    `${date}:${v.id}`,
  ).sort((a, b) => a.rank - b.rank);

  let summary;
  let breakdown = null;
  if (entry) {
    const items = Object.entries(entry.items);
    const maxOf = (k) => Math.max(...rows.map((r) => r.items[k] ?? 0), 0);
    const missing = (week?.keys ?? []).filter((k) => entry.items[k] === undefined);
    summary = [
      h(
        "dl",
        { class: "profile__stats" },
        h("div", { class: "stat" }, h("dt", { class: "stat__label" }, "이번 주 순위"), h("dd", { class: "stat__value" }, h("b", { class: "stat__big" }, `${entry.rank}위`), move(entry))),
        h(
          "div",
          { class: "stat stat--gauge" },
          h("dt", { class: "stat__label" }, "총점"),
          h(
            "dd",
            { class: "stat__value" },
            h("div", { class: "gauge gauge--xl" }, gauge(entry, scale, 88, "gauge"), h("span", { class: "gauge__value" }, fmtPoints(entry.total, decimals, false))),
            h("span", { class: "stat__unit" }, `/ ${fmtPoints(scale, 0)}점`),
          ),
        ),
        h("div", { class: "stat" }, h("dt", { class: "stat__label" }, "별점"), h("dd", { class: "stat__value" }, star(), h("b", { class: "stat__big" }, entry.star.toFixed(1)))),
      ),
      h("a", { class: "btn btn--fill", href: page.url(`go/${v.id}/`), ...goAttrs(v) }, `${v.name} 바로가기`),
    ];
    breakdown = h(
      "section",
      { class: "part wrap", "aria-labelledby": "part-score" },
      h("h2", { id: "part-score", class: "section-title" }, "항목별 점수"),
      h(
        "ul",
        { class: "bars" },
        items.map(([k, val]) => {
          const max = maxOf(k);
          const w = max > 0 ? Math.round((val / max) * 100) : 0;
          return h(
            "li",
            { class: "bars__row" },
            h("span", { class: "bars__label" }, PARTS[k]?.label ?? k),
            h(
              "svg",
              { class: "bars__svg", viewBox: "0 0 100 8", preserveAspectRatio: "none", "aria-hidden": "true" },
              h("rect", { class: "bars__track", width: "100", height: "8" }),
              h("rect", { class: "bars__fill", width: String(w), height: "8" }),
            ),
            h("span", { class: "bars__value" }, `${fmtPoints(val, decimals)}점`),
          );
        }),
        entry.bonus > 0
          ? h("li", { class: "bars__row bars__row--extra" }, h("span", { class: "bars__label" }, BONUS_LABEL), h("span", { class: "bars__note" }, "운영 기준에 따라 더한 점수"), h("span", { class: "bars__value" }, `+${fmtPoints(entry.bonus, decimals)}점`))
          : null,
        h("li", { class: "bars__row bars__row--sum" }, h("span", { class: "bars__label" }, "합계"), h("span", { class: "bars__note" }), h("span", { class: "bars__value" }, `${fmtPoints(entry.total, decimals)}점`)),
      ),
      missing.length ? h("p", { class: "part__note" }, "모으지 못한 항목은 이번 주 점수에서 빠졌어요.") : null,
    );
  } else {
    summary = [h("p", { class: "profile__notice" }, known ? "이번 주에는 공개 순위(10위) 밖이에요. 모든 후보가 매주 다시 겨뤄요." : "아직 순위를 매길 지표를 모으고 있어요.")];
  }

  const body = [
    h("a", { class: "skip", href: "#main" }, "본문 바로가기"),
    header(page, null),
    h(
      "main",
      { id: "main", class: "main" },
      crumbs(page, v.name),
      h(
        "section",
        { class: "profile wrap" },
        h(
          "div",
          { class: "profile__head" },
          avatar(page, v, 56, "profile__icon"),
          h("div", { class: "profile__titles" }, h("h1", { class: "profile__title" }, `${v.name} 순위\u2060·\u2060가입 혜택\u2060·\u2060이벤트`), date ? h("p", { class: "profile__date" }, h("time", { datetime: date }, `${dayLabel(date)} 갱신`)) : null),
        ),
        summary,
      ),
      entry ? breakdown : null,
      h(
        "section",
        { class: "part wrap", "aria-labelledby": "part-perks" },
        h("h2", { id: "part-perks", class: "section-title" }, "가입 혜택·이벤트"),
        h(
          "dl",
          { class: "pairs" },
          ["join", "event"].map((kind) => {
            const list = (v.benefits ?? []).filter((b) => b.kind === kind && b.text);
            return h(
              "div",
              { class: "pairs__row" },
              h("dt", { class: "pairs__key" }, kind === "join" ? "가입 혜택" : "이벤트"),
              h("dd", { class: "pairs__value" }, list.length ? list.map((b) => b.text).join(", ") : "공식 사이트에서 확인하세요."),
            );
          }),
        ),
      ),
      facts.length
        ? h(
            "section",
            { class: "part wrap", "aria-labelledby": "part-facts" },
            h("h2", { id: "part-facts", class: "section-title" }, "앱 지표"),
            h("dl", { class: "tiles" }, facts.map(([k, x]) => h("div", { class: "tiles__item" }, h("dt", { class: "tiles__label" }, k), h("dd", { class: "tiles__value" }, x)))),
          )
        : null,
      history.some((x) => x.rank)
        ? h(
            "section",
            { class: "part wrap", "aria-labelledby": "part-history" },
            h("h2", { id: "part-history", class: "section-title" }, "순위 변동"),
            h(
              "table",
              { class: "grid" },
              h("thead", null, h("tr", null, h("th", { scope: "col" }, "갱신일"), h("th", { scope: "col" }, "순위"), h("th", { scope: "col" }, "총점"))),
              h(
                "tbody",
                null,
                history.map((x) =>
                  h("tr", null, h("td", null, h("time", { datetime: x.date }, dayLabel(x.date))), h("td", null, x.rank ? `${x.rank}위` : "10위 밖"), h("td", null, x.total !== null ? `${fmtPoints(x.total, decimals)}점` : "–")),
                ),
              ),
            ),
          )
        : null,
      others.length
        ? h(
            "section",
            { class: "part wrap", "aria-labelledby": "part-others" },
            h("h2", { id: "part-others", class: "section-title" }, "다른 웹하드도 살펴보세요"),
            h(
              "ul",
              { class: "peers" },
              others.map((e) => {
                const o = ctx.byId[e.id];
                return h(
                  "li",
                  { class: "peers__item" },
                  h("a", { class: "peers__link", href: page.url(`webhard/${o.id}/`) }, avatar(page, o, 32, "peers__icon"), h("span", { class: "peers__name" }, o.name), h("span", { class: "peers__rank" }, `${e.rank}위`)),
                );
              }),
            ),
          )
        : null,
    ),
    footer(page),
  ];
  const ld = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "웹하드 순위", item: page.abs("") },
        { "@type": "ListItem", position: 2, name: v.name, item: page.abs(`webhard/${v.id}/`) },
      ],
    },
  ];
  return [page, doc(page, { title, description, ld }, body, css)];
}

function criteriaPage(ctx, css) {
  const page = new Page("criteria/index.html");
  const keys = ctx.week?.keys ?? Object.keys(PARTS);
  const title = `웹하드 순위 기준·읽는 법과 자주 묻는 질문 | ${BRAND}`;
  const description = "파일픽 웹하드 순위를 어떤 항목으로 매기는지, 순위표를 어떻게 읽는지 정리했어요. 웹하드를 고를 때 살펴볼 점과 자주 묻는 질문도 함께 확인해 보세요.";
  const advice = [
    ["요금", "정액제와 포인트 단가", "자주 받는다면 정액제가 나을 수 있어요."],
    ["콘텐츠", "제휴 표시가 있는 자료", "제휴 자료는 저작권 걱정을 덜 수 있어요."],
    ["앱", "모바일 앱과 최근 업데이트", "휴대폰으로 주로 본다면 앱부터 확인하세요."],
    ["혜택", "가입·이벤트 조건과 기간", "받기 조건을 공식 안내에서 먼저 읽어 보세요."],
    ["해지", "자동 결제 해지 방법", "결제 전에 해지 경로를 찾아 두면 편해요."],
  ];
  const steps = [
    ["총점", "게이지 속 숫자가 이번 주 총점이에요. 1~3위는 크게 보여 줘요."],
    ["변동", "▲▼는 지난주 순위와 비교한 칸 수예요. NEW는 새로 들어온 곳이에요."],
    ["별점", "총점을 5점 만점으로 바꾼 값이에요. 이용자 평점과는 달라요."],
  ];
  const body = [
    h("a", { class: "skip", href: "#main" }, "본문 바로가기"),
    header(page, "criteria"),
    h(
      "main",
      { id: "main", class: "main" },
      crumbs(page, "순위 기준·FAQ"),
      h("section", { class: "intro wrap" }, h("h1", { class: "intro__title" }, "웹하드 순위 기준과 자주 묻는 질문"), h("p", { class: "intro__note" }, "모든 후보 웹하드를 매주 같은 기준으로 다시 매겨요.")),
      h(
        "section",
        { class: "part wrap", "aria-labelledby": "c-items" },
        h("h2", { id: "c-items", class: "section-title" }, "순위 항목"),
        h(
          "ul",
          { class: "basis__list" },
          keys.map((k) => h("li", { class: "basis__item" }, h("span", { class: "basis__name" }, PARTS[k].label), h("span", { class: "basis__line" }, PARTS[k].line))),
          h(
            "li",
            { class: "basis__item basis__item--extra" },
            h("span", { class: "basis__name" }, BONUS_LABEL),
            h("span", { class: "basis__line" }, "운영 기준에 따라 일부 업체에 더한 점수예요. 더해진 업체는 순위표와 상세 페이지에 표시해요."),
          ),
        ),
      ),
      h(
        "section",
        { class: "part wrap", "aria-labelledby": "c-read" },
        h("h2", { id: "c-read", class: "section-title" }, "순위표 읽는 법"),
        h("ol", { class: "steps" }, steps.map(([k, x], i) => h("li", { class: "steps__item" }, h("span", { class: "steps__no", "aria-hidden": "true" }, String(i + 1)), h("span", { class: "steps__name" }, k), h("span", { class: "steps__line" }, x)))),
      ),
      h(
        "section",
        { class: "part wrap", "aria-labelledby": "c-pick" },
        h("h2", { id: "c-pick", class: "section-title" }, "웹하드 고를 때 볼 것"),
        h(
          "table",
          { class: "grid grid--advice" },
          h("thead", null, h("tr", null, h("th", { scope: "col" }, "항목"), h("th", { scope: "col" }, "볼 것"), h("th", { scope: "col" }, "판단"))),
          h("tbody", null, advice.map(([a, b, c]) => h("tr", null, h("th", { scope: "row" }, a), h("td", null, b), h("td", null, c)))),
        ),
      ),
      faqSection(ctx.faq.criteria, "faq-criteria"),
      h(
        "section",
        { class: "part wrap", "aria-labelledby": "c-list" },
        h("h2", { id: "c-list", class: "section-title" }, "다루는 웹하드"),
        h(
          "ul",
          { class: "peers peers--all" },
          [...ctx.vendors]
            .sort((a, b) => a.name.localeCompare(b.name, "ko"))
            .map((o) => h("li", { class: "peers__item" }, h("a", { class: "peers__link", href: page.url(`webhard/${o.id}/`) }, avatar(page, o, 32, "peers__icon"), h("span", { class: "peers__name" }, o.name)))),
        ),
      ),
    ),
    footer(page),
  ];
  const ld = [
    faqLd(ctx.faq.criteria),
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "웹하드 순위", item: page.abs("") },
        { "@type": "ListItem", position: 2, name: "순위 기준·FAQ", item: page.abs("criteria/") },
      ],
    },
  ];
  return [page, doc(page, { title, description, ld }, body, css)];
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

  const draft = [homePage(ctx, "x"), criteriaPage(ctx, "x"), ...ctx.vendors.map((v) => detailPage(ctx, v, "x"))];
  const textForFonts = draft.map(([, html]) => html.replace(/<[^>]+>/g, " ")).join("") + "0123456789▲▼–·";
  const fonts = fontFaces(textForFonts);
  const css = [fonts.css, stripComments(readFileSync("src/site.css", "utf8")).trim(), tintStyles(ctx.vendors)].join("\n\n") + "\n";
  const cssHash = hashOf(css).slice(0, 10);
  writeOut("assets/site.css", css);
  mkdirSync(join(OUT, "assets/fonts"), { recursive: true });
  for (const f of fonts.files) copyFileSync(`assets/fonts/${f}`, join(OUT, "assets/fonts", f));
  copyFileSync("assets/fonts/LICENSE.txt", join(OUT, "assets/fonts/LICENSE.txt"));
  for (const f of ["mark.svg", "share.png"]) if (existsSync(`assets/${f}`)) copyFileSync(`assets/${f}`, join(OUT, "assets", f));
  if (existsSync("assets/icon")) {
    mkdirSync(join(OUT, "assets/icon"), { recursive: true });
    for (const f of readdirSync("assets/icon")) if (ctx.byId[f.replace(/\.webp$/, "")]) copyFileSync(`assets/icon/${f}`, join(OUT, "assets/icon", f));
  }

  const pages = [homePage(ctx, cssHash), criteriaPage(ctx, cssHash), ...ctx.vendors.map((v) => detailPage(ctx, v, cssHash)), notFound(cssHash)];
  for (const e of ctx.top) pages.push(goPage(ctx.byId[e.id]));
  for (const [page, html] of pages) writeOut(page.path, html);

  const date = ctx.week?.date;
  const robots = ["User-agent: *", "Allow: /", "Disallow: /go/"];
  if (ABSOLUTE) robots.push(`Sitemap: ${SITE}/sitemap.xml`);
  writeOut("robots.txt", robots.join("\n") + "\n");
  if (ABSOLUTE) {
    const urls = [["", date], ["criteria/", null], ...ctx.vendors.map((v) => [`webhard/${v.id}/`, date])];
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
      "- [순위 기준·FAQ](criteria/): 순위 항목, 순위표 읽는 법, 자주 묻는 질문",
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
