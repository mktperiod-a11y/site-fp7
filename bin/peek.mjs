import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readJson } from "./tally.mjs";
import { blockedLines } from "./guard.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const JOIN_LINK = /(join|signup|register|member_?reg|가입)/i;
const EVENT_LINK = /(event|evt|benefit|coupon|promotion|이벤트|혜택|쿠폰|프로모션)/i;
const NOISE = /(\b(360|450|480|720|1080|2160)p\b|\.E\d+|\bE\d{2}\b|자막|WANNA|WEB|시즌\s*\d|\d{6}\.|성인|19금|고수위|AV\b|수수료|환불|교환|약관|0P\s*\/)/i;
const MAX_TEXT = 16;

const num = (s) => s.replace(/\s+/g, "");
const unit = (u) => (/포인트/.test(u) ? "P" : u.toUpperCase());

const RULES = [
  [/첫\s*(달|결제)[^0-9]{0,12}([\d,]+)\s*원/, (m) => ["event", `첫 ${m[1]} ${num(m[2])}원`]],
  [/(\d+)\s*일\s*(무제한|자유\s*이용권)[^0-9]{0,8}([\d,]+)\s*원/, (m) => ["event", `${m[1]}일 ${m[2].replace(/\s+/g, "")} ${num(m[3])}원`]],
  [/(본인\s*인증)[^0-9]{0,12}([\d,]+)\s*(P|B|포인트)(?![a-z])/i, (m) => ["join", `본인인증 ${num(m[2])}${unit(m[3])}`]],
  [/가입[^0-9]{0,14}([\d,]+)\s*(P|B|포인트)(?![a-z])/i, (m) => ["join", `가입 ${num(m[1])}${unit(m[2])}`]],
  [/(앱|어플)[^.!]{0,16}?(설치|리뷰)[^0-9]{0,16}(쿠폰\s*\d+\s*장|[\d,]+\s*(P|B|포인트))/i, (m) => ["event", `앱 ${m[2]} ${/쿠폰/.test(m[3]) ? m[3].replace(/\s+/g, "").replace("쿠폰", "쿠폰 ") : num(m[3]).replace(/포인트$/, "P")}`]],
  [/(정액권|정액제|야간|결제)?\s*(\d+)\s*%\s*페이백/, (m) => ["event", `${m[1] ? `${m[1]} ` : ""}${m[2]}% 페이백`]],
  [/페이백\s*(이벤트|행사)/, () => ["event", "페이백 이벤트"]],
  [/결제\s*금액의?\s*(\d+)\s*배/, (m) => ["event", `결제 ${m[1]}배 적립`]],
  [/포인트\s*(\d+)\s*배/, (m) => ["event", `포인트 ${m[1]}배 적립`]],
  [/(방송|종편|케이블)[^0-9]{0,12}100\s*원/, () => ["event", "방송 100원 이용"]],
  [/(정액제|정액권|자유\s*이용권)[^0-9]{0,8}100\s*원/, (m) => ["event", `${m[1].replace(/\s+/g, "")} 100원`]],
  [/(콘텐츠|컨텐츠)\s*(\d+)\s*%\s*(할인|반값)/, (m) => ["event", `콘텐츠 ${m[2]}% 할인`]],
  [/생일[^0-9]{0,10}([\d,]+)\s*(P|포인트)/, (m) => ["event", `생일 ${num(m[1])}P`]],
  [/친구[^0-9]{0,20}([\d,]+)\s*(P|포인트)/, (m) => ["event", `친구 초대 ${num(m[1])}P`]],
  [/출석[^0-9]{0,20}?(최대\s*)?([\d,]+)\s*(P|포인트)/, (m) => ["event", `출석 ${m[1] ? "최대 " : ""}${num(m[2])}P`]],
  [/리뷰[^0-9]{0,16}([\d,]+)\s*(P|포인트)/i, (m) => ["event", `리뷰 작성 ${num(m[1])}P`]],
];

export function tidy(line) {
  const clean = line.replace(/\s+/g, " ").trim();
  if (clean.length < 4 || clean.length > 80 || NOISE.test(clean) || blockedLines(clean).length) return null;
  for (const [re, make] of RULES) {
    const m = clean.match(re);
    if (!m) continue;
    const [kind, text] = make(m);
    if (text.length <= MAX_TEXT) return { kind, text };
  }
  return null;
}

function decodeEntities(s) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#?\w+;/g, " ");
}

export function readPage(html, base) {
  const lines = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    for (const a of m[0].matchAll(/\s(?:alt|title)=["']([^"']+)["']/gi)) lines.push(decodeEntities(a[1]));
  }
  const body = html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|td|tr|h\d|a|dd|dt|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  lines.push(...decodeEntities(body).split("\n"));
  const links = { join: [], event: [] };
  const host = new URL(base).hostname;
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (/^(javascript|mailto|tel):/i.test(m[1])) continue;
    let url;
    try {
      url = new URL(decodeEntities(m[1]), base);
    } catch {
      continue;
    }
    if (url.hostname !== host) continue;
    const label = decodeEntities(m[2].replace(/<[^>]+>/g, " ")) + " " + (m[2].match(/alt=["']([^"']+)/i)?.[1] ?? "");
    const key = url.pathname + " " + label;
    if (JOIN_LINK.test(key) && !links.join.includes(url.href)) links.join.push(url.href);
    else if (EVENT_LINK.test(key) && !links.event.includes(url.href)) links.event.push(url.href);
  }
  return { lines: lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean), links };
}

export function company(lines) {
  const text = lines.join(" | ").replace(/\s+/g, " ");
  const name = text.match(/(?:상호명?|회사명|법인명)\s*[:：]\s*((?:\(주\)|주식회사\s)?[가-힣A-Za-z0-9&.\s]{2,24}?(?:\(주\)|주식회사)?)\s*(?=[|/,·]|대표|사업자|주소|전화|TEL|통신|$)/i)?.[1]?.trim();
  const bizNo = text.match(/사업자\s*등록\s*번호\s*[:：]?\s*(\d{3}-\d{2}-\d{5})/)?.[1];
  const kcc = text.match(/부가\s*통신\s*사업자?\s*(?:신고|등록)\s*(?:번호)?\s*[:：]?\s*(제?\s*[\d-]{3,}\s*호?)/)?.[1]?.replace(/\s+/g, "");
  const out = {};
  if (name && !blockedLines(name).length) out.name = name;
  if (bizNo) out.bizNo = bizNo;
  if (kcc) out.kcc = kcc;
  return Object.keys(out).length ? out : null;
}

export function choose(found) {
  const join = [];
  const event = [];
  for (const f of found) {
    if (join.some((x) => x.text === f.text) || event.some((x) => x.text === f.text)) continue;
    if (f.kind === "join") join.push(f);
    else event.push(f);
  }
  join.sort((a, b) => (a.text.startsWith("가입") ? 0 : 1) - (b.text.startsWith("가입") ? 0 : 1));
  return [...join.slice(0, 1), ...event.slice(0, 2)].map(({ kind, text }) => ({ kind, text }));
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" }, signal: AbortSignal.timeout(20000) });
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.subarray(0, 4096).toString("latin1");
  const charset = (res.headers.get("content-type")?.match(/charset=([\w-]+)/i)?.[1] ?? head.match(/charset=["']?([\w-]+)/i)?.[1] ?? "utf-8").toLowerCase();
  let html;
  try {
    html = new TextDecoder(charset).decode(buf);
  } catch {
    html = buf.toString("utf8");
  }
  return { ok: res.ok, url: res.url, html };
}

let browser = null;
async function renderHtml(url) {
  if (!browser) {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  }
  const page = await browser.newPage({ userAgent: UA, locale: "ko-KR" });
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    return { ok: true, url: page.url(), html: await page.content() };
  } finally {
    await page.close();
  }
}

async function load(url) {
  const got = await fetchHtml(url);
  const text = got.html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, "").replace(/\s+/g, "");
  if (text.length >= 300) return got;
  try {
    return await renderHtml(url);
  } catch {
    return got;
  }
}

async function collect(v) {
  const result = { id: v.id, pages: 0, found: [], error: null };
  try {
    const home = await load(v.url);
    if (!home.ok) throw new Error("응답 오류");
    const first = readPage(home.html, home.url);
    const queue = [...first.links.join.slice(0, 1), ...first.links.event.slice(0, 3)];
    const sources = [];
    for (const href of queue) {
      try {
        const page = await load(href);
        if (page.ok) sources.push({ url: href, lines: readPage(page.html, page.url).lines });
      } catch {
        /* 못 읽은 페이지는 건너뛴다 */
      }
    }
    sources.push({ url: home.url, lines: first.lines });
    result.company = company(first.lines);
    result.pages = sources.length;
    for (const s of sources) {
      for (const line of s.lines) {
        const t = tidy(line);
        if (t && !result.found.some((f) => f.text === t.text)) result.found.push({ ...t, source: s.url, line });
      }
    }
  } catch (e) {
    result.error = e.message || "접속 실패";
  }
  result.benefits = choose(result.found);
  return result;
}

const same = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

async function main() {
  const apply = process.argv.includes("--apply");
  const file = "data/vendors.json";
  const vendors = readJson(file, []);
  const report = [];
  for (const v of vendors.filter((x) => x.status !== "excluded" && x.url)) {
    const r = await collect(v);
    r.before = (v.benefits ?? []).map(({ kind, text }) => ({ kind, text }));
    r.companyBefore = v.company ?? null;
    report.push(r);
    console.log(`${v.id}: ${r.error ? `실패(${r.error})` : `페이지 ${r.pages}, 후보 ${r.found.length}, 반영 ${r.benefits.length}`}`);
  }
  if (browser) await browser.close();

  mkdirSync(".peek", { recursive: true });
  writeFileSync(".peek/report.json", JSON.stringify(report, null, 2) + "\n");

  const changed = report.filter((r) => !same(r.before, r.benefits) || JSON.stringify(r.companyBefore) !== JSON.stringify(r.company ?? null));
  const today = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);
  const byId = Object.fromEntries(vendors.map((v) => [v.id, v]));
  const show = (list) => (list.length ? list.map((b) => `${b.kind === "join" ? "가입" : "이벤트"}: ${b.text}`).join("<br>") : "(빈값)");
  const md = [
    "매주 업체 공개 페이지(가입·이벤트 페이지, 배너 문구)에서 홍보 중인 혜택을 모은 결과예요. 이용권 가격은 모으지 않아요.",
    "못 읽은 업체는 빈값으로 두고, 화면에는 \"공식 사이트에서 확인하세요.\"가 나와요. 합치면 확인한 것으로 보고 사이트에 반영돼요.",
    "",
    "| 업체 | 지금 | 바뀔 값 | 근거 | 업체 정보 |",
    "|---|---|---|---|---|",
    ...changed.map((r) => {
      const why = r.error ? `읽지 못함(${r.error})` : r.benefits.map((b) => r.found.find((f) => f.text === b.text)).map((f) => `${new URL(f.source).pathname}: ${f.line.slice(0, 40)}`).join("<br>") || "혜택 문구 없음";
      const co = r.company ? [r.company.name, r.company.bizNo, r.company.kcc].filter(Boolean).join("<br>") : "(빈값)";
      return `| ${byId[r.id].name} | ${show(r.before)} | ${show(r.benefits)} | ${why.replace(/\|/g, "/")} | ${co.replace(/\|/g, "/")} |`;
    }),
  ];
  writeFileSync(".peek/pr.md", md.join("\n") + "\n");

  if (apply && changed.length) {
    const text = readFileSync(file, "utf8");
    const data = JSON.parse(text);
    for (const r of changed) {
      const v = data.find((x) => x.id === r.id);
      v.benefits = r.benefits;
      if (r.company) v.company = r.company;
      else delete v.company;
      if (!r.error) v.checked = today;
    }
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  }
  console.log(`바뀐 업체 ${changed.length}곳${apply ? " (vendors.json에 반영)" : ""}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `바뀐 업체 ${changed.length}곳\n`);
}

if (process.argv[1]?.endsWith("peek.mjs")) main();
