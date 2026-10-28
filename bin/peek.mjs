import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readJson } from "./tally.mjs";
import { blockedLines } from "./guard.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const LINK = /(event|evt|notice|board|price|charge|fixed|coupon|benefit|이벤트|공지|요금|충전|정액|혜택|쿠폰)/i;
const PERK = /(\d[\d,]*\s*(P|포인트|원|B|캐시|코인)(?![a-z])|무제한|정액제|자유이용권|페이백|\d+\s*%|\d+\s*배|무료|쿠폰)/i;

async function get(url) {
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
  return { status: res.status, url: res.url, charset, html };
}

function textOf(html) {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|td|tr|h\d|a|span|dd|dt)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#?\w+;/g, " ");
}

function perks(html) {
  const out = [];
  for (const raw of textOf(html).split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < 3 || line.length > 60 || !PERK.test(line)) continue;
    if (blockedLines(line).length) continue;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

function links(html, base) {
  const seen = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!LINK.test(m[1]) && !LINK.test(label)) continue;
    if (/^(javascript|mailto|tel):/i.test(m[1])) continue;
    let url;
    try {
      url = new URL(m[1], base);
    } catch {
      continue;
    }
    if (url.hostname !== new URL(base).hostname) continue;
    if (!seen.has(url.href)) seen.set(url.href, label.slice(0, 20));
  }
  return [...seen].slice(0, 4);
}

async function main() {
  const vendors = readJson("data/vendors.json", []).filter((v) => v.status !== "excluded" && v.url);
  const report = [];
  for (const v of vendors) {
    const row = { id: v.id, name: v.name, pages: [] };
    try {
      const home = await get(v.url);
      const text = textOf(home.html).replace(/\s+/g, "");
      row.status = home.status;
      row.charset = home.charset;
      row.textChars = text.length;
      row.login = /type=["']?password/i.test(home.html);
      row.bannerImages = [...home.html.matchAll(/<img\b[^>]*(event|banner|evt|bn_)[^>]*>/gi)].length;
      row.pages.push({ url: "(첫 화면)", perks: perks(home.html).slice(0, 8) });
      for (const [href, label] of links(home.html, home.url)) {
        try {
          const page = await get(href);
          row.pages.push({ url: new URL(href).pathname, label, status: page.status, login: /type=["']?password/i.test(page.html), perks: perks(page.html).slice(0, 8) });
        } catch (e) {
          row.pages.push({ url: new URL(href).pathname, label, error: e.message });
        }
      }
    } catch (e) {
      row.error = e.message;
    }
    report.push(row);
    const found = row.pages.reduce((a, p) => a + (p.perks?.length ?? 0), 0);
    console.log(`${v.id}: ${row.error ?? `상태 ${row.status}, ${row.charset}, 글자 ${row.textChars}, 로그인창 ${row.login ? "있음" : "없음"}, 배너 이미지 ${row.bannerImages}, 둘러본 페이지 ${row.pages.length}, 혜택 후보 ${found}`}`);
    for (const p of row.pages) for (const t of p.perks ?? []) console.log(`  [${p.url}] ${t}`);
  }
  mkdirSync(".peek", { recursive: true });
  writeFileSync(".peek/report.json", JSON.stringify(report, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ["| 업체 | 상태 | 글자 수 | 로그인창 | 배너 이미지 | 둘러본 페이지 | 혜택 후보 |", "|---|---|---|---|---|---|---|"];
    for (const r of report) {
      const found = r.pages.reduce((a, p) => a + (p.perks?.length ?? 0), 0);
      lines.push(r.error ? `| ${r.name} | 실패 | | | | | |` : `| ${r.name} | ${r.status} | ${r.textChars} | ${r.login ? "있음" : "없음"} | ${r.bannerImages} | ${r.pages.length} | ${found} |`);
    }
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }
}

main();
