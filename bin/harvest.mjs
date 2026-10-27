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
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" } });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return parsePlay(await res.text());
}

function lastSunday(today) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 7) % 7 || 7));
  return d;
}

const iso = (d) => d.toISOString().slice(0, 10);

async function trendRequest(endpoint, groups, startDate, endDate) {
  const res = await fetch(endpoint.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...endpoint.headers },
    body: JSON.stringify({ startDate, endDate, timeUnit: "week", keywordGroups: groups }),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const json = await res.json();
  return Object.fromEntries((json.results ?? []).map((r) => [r.title, (r.data ?? []).map((p) => p.ratio)]));
}

export async function naverTrend(vendors, env, today) {
  const id = env.NAVER_CLIENT_ID;
  const secret = env.NAVER_CLIENT_SECRET;
  if (!id || !secret) return null;
  const endpoints = [
    {
      url: env.NAVER_TREND_URL || "https://naverapihub.apigw.ntruss.com/datalab/v1/search",
      headers: { "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": secret },
    },
    { url: "https://openapi.naver.com/v1/datalab/search", headers: { "X-Naver-Client-Id": id, "X-Naver-Client-Secret": secret } },
  ];
  const end = lastSunday(today);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7 * 8 + 1);
  const group = (v) => ({ groupName: v.id, keywords: v.keywords ?? [v.name] });
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  let endpoint = null;
  let first = null;
  for (const ep of endpoints) {
    try {
      first = await trendRequest(ep, vendors.slice(0, 5).map(group), iso(start), iso(end));
      endpoint = ep;
      break;
    } catch {
      /* try the next endpoint */
    }
  }
  if (!endpoint) {
    warn("검색 지표를 받지 못했습니다.");
    return null;
  }
  const series = { ...first };
  const head = vendors.slice(0, 5);
  const anchor = head.reduce((a, v) => ((mean(first[v.id] ?? []) ?? 0) > (mean(first[a.id] ?? []) ?? 0) ? v : a), head[0]);
  const anchorBase = mean(first[anchor.id] ?? []);
  for (let i = 5; i < vendors.length; i += 4) {
    const chunk = vendors.slice(i, i + 4);
    await sleep(500);
    try {
      const got = await trendRequest(endpoint, [group(anchor), ...chunk.map(group)], iso(start), iso(end));
      const a = mean(got[anchor.id] ?? []);
      if (!(a > 0) || !(anchorBase > 0)) continue;
      for (const v of chunk) if (got[v.id]) series[v.id] = got[v.id].map((x) => (x * anchorBase) / a);
    } catch {
      warn("검색 지표 일부를 받지 못했습니다.");
    }
  }
  const out = {};
  for (const v of vendors) {
    const s = series[v.id];
    if (!s || s.length < 8) continue;
    const last = s.slice(-8);
    out[v.id] = { search: mean(last.slice(4)), searchPrior: mean(last.slice(0, 4)) };
  }
  return out;
}

async function main() {
  const today = process.env.HARVEST_DATE || kstDate();
  const vendors = readJson("data/vendors.json", []).filter((v) => v.status !== "excluded");
  const metrics = readJson("data/metrics.json", { weeks: [] });
  const before = metrics.weeks.filter((w) => w.date < today).at(-1);
  const values = {};

  const trend = await naverTrend(vendors, process.env, today);
  let playOk = 0;
  let playTried = 0;
  for (const v of vendors) {
    const row = {};
    if (trend?.[v.id]) Object.assign(row, trend[v.id]);
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
    if (row.search === undefined && old.search !== undefined) {
      row.search = old.search;
      row.searchPrior = old.searchPrior;
      carried.push("search");
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
  metrics.weeks = [...metrics.weeks.filter((w) => w.date < today), { date: today, values }].slice(-26);
  writeJson("data/metrics.json", metrics);
  console.log(`수집 완료: 앱 ${playOk}/${playTried}, 검색 ${trend ? Object.keys(trend).length : 0}`);
}

if (process.argv[1]?.endsWith("harvest.mjs")) main();
