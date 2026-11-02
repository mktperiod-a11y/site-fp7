import { readJson, writeJson, kstDate } from "./tally.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const warn = (msg) => console.log(`::warning::${msg}`);

function koNumber(text) {
  const m = String(text).replace(/,/g, "").match(/([\d.]+)\s*(천|만|억)?/);
  if (!m) return null;
  const mul = { 천: 1e3, 만: 1e4, 억: 1e8 }[m[2]] ?? 1;
  return Math.round(parseFloat(m[1]) * mul);
}

export function parsePlay(html) {
  const out = {};
  const m = html.match(/AF_initDataCallback\(\{key: 'ds:5', hash: '[^']*', data:([\s\S]*?), sideChannel: \{\}\}\);/);
  if (m) {
    try {
      const info = JSON.parse(m[1])?.[1]?.[2];
      const inst = info?.[13];
      if (Array.isArray(inst)) {
        out.installs = Number.isFinite(inst[2]) ? inst[2] : Number.isFinite(inst[1]) ? inst[1] : undefined;
        if (typeof inst[3] === "string") out.installsText = inst[3];
        else if (typeof inst[0] === "string") out.installsText = inst[0];
      }
      const rate = info?.[51];
      if (Number.isFinite(rate?.[0]?.[1])) out.score = rate[0][1];
      if (Number.isFinite(rate?.[2]?.[1])) out.ratings = rate[2][1];
    } catch {
      /* fall through to text patterns */
    }
  }
  if (out.score === undefined) {
    const s = html.match(/별표 5개 만점에 ([\d.]+)개/);
    if (s) out.score = parseFloat(s[1]);
  }
  if (out.installs === undefined) {
    const d = html.match(/>([\d.,]+\s*(?:천|만|억)?\+)<\/div><div[^>]*>다운로드</);
    if (d) {
      out.installsText = d[1].replace(/\s/g, "");
      out.installs = koNumber(d[1]);
    }
  }
  if (out.ratings === undefined) {
    const r = html.match(/리뷰\s*([\d.,]+\s*(?:천|만|억)?)\s*개/);
    if (r) out.ratings = koNumber(r[1]);
  }
  for (const k of ["installs", "ratings"]) if (!(Number.isInteger(out[k]) && out[k] >= 0)) delete out[k];
  if (!(out.score >= 1 && out.score <= 5)) delete out.score;
  return out;
}

async function fetchPlay(appId) {
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(appId)}&hl=ko&gl=KR`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return parsePlay(await res.text());
}

// 웹 순위: 공개 웹사이트 인기 목록(Tranco)의 최근 순위와 4주 전 순위
const SECOND = new Set(["co", "or", "ne", "go", "re", "pe", "ac"]);
export function siteDomain(url) {
  const parts = new URL(url).hostname.replace(/^www\./, "").split(".");
  const keep = parts.length > 2 && SECOND.has(parts.at(-2)) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

export function webRanks(json, today) {
  const ranks = (json?.ranks ?? []).filter((r) => Number.isInteger(r.rank) && r.rank > 0 && r.date <= today).sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!ranks.length) return {};
  const cut = new Date(`${ranks[0].date}T00:00:00Z`);
  cut.setUTCDate(cut.getUTCDate() - 28);
  const prior = ranks.find((r) => r.date <= cut.toISOString().slice(0, 10)) ?? ranks.at(-1);
  return { web: ranks[0].rank, webPrior: prior.rank };
}

async function fetchWeb(url, today) {
  const res = await fetch(`https://tranco-list.eu/api/ranks/domain/${siteDomain(url)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return webRanks(await res.json(), today);
}

// 혜택 경쟁력: 확인된 가입 혜택의 크기와 이벤트 수
export function perkValues(benefits = []) {
  const ok = benefits.filter((b) => !b.unconfirmed);
  const join = ok.find((b) => b.kind === "join");
  return { perkJoin: join ? (koNumber(join.text) ?? 0) : 0, perkEvents: ok.filter((b) => b.kind === "event").length };
}

async function main() {
  const today = process.env.HARVEST_DATE || kstDate();
  const vendors = readJson("data/vendors.json", []).filter((v) => v.status !== "excluded");
  const metrics = readJson("data/metrics.json", { weeks: [] });
  const before = metrics.weeks.filter((w) => w.date < today).at(-1);
  const values = {};

  let playOk = 0;
  let playTried = 0;
  let webOk = 0;
  let webTried = 0;
  for (const v of vendors) {
    const row = perkValues(v.benefits);
    if (v.url) {
      webTried += 1;
      try {
        const got = await fetchWeb(v.url, today);
        Object.assign(row, got);
        if (got.web) webOk += 1;
      } catch {
        /* 이전 값을 쓴다 */
      }
      await sleep(1100);
    }
    if (v.playId) {
      playTried += 1;
      try {
        const got = await fetchPlay(v.playId);
        Object.assign(row, got);
        if (got.installs !== undefined || got.ratings !== undefined) playOk += 1;
        console.log(`${v.id}: ${["installs", "ratings", "score"].filter((k) => got[k] !== undefined).join(",") || "none"}`);
      } catch {
        console.log(`${v.id}: failed`);
      }
      await sleep(1200);
    }
    const old = before?.values?.[v.id] ?? {};
    const carried = [];
    if (row.web === undefined && old.web !== undefined) {
      row.web = old.web;
      row.webPrior = old.webPrior;
      carried.push("web");
    }
    for (const k of ["installs", "ratings", "score"]) {
      if (row[k] === undefined && old[k] !== undefined) {
        row[k] = old[k];
        if (k === "installs" && old.installsText) row.installsText = old.installsText;
        carried.push(k);
      }
    }
    if (carried.length) row.carried = carried;
    if (Object.keys(row).length) values[v.id] = row;
  }
  if (playTried && playOk === 0) warn("앱 지표를 하나도 받지 못했습니다. 이전 값을 사용합니다.");
  if (webTried && webOk === 0) warn("웹 순위를 하나도 받지 못했습니다. 이전 값을 사용합니다.");
  metrics.weeks = [...metrics.weeks.filter((w) => w.date < today), { date: today, values }].slice(-90);
  writeJson("data/metrics.json", metrics);
  console.log(`수집 완료: 웹 ${webOk}/${webTried}, 앱 ${playOk}/${playTried}`);
}

if (process.argv[1]?.endsWith("harvest.mjs")) main();
