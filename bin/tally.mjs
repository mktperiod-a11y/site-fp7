import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const PUBLIC_COUNT = 10;

export const PARTS = {
  search: { label: "검색 관심도", line: "사람들이 얼마나 자주 찾아보는지예요." },
  search_trend: { label: "검색 관심도 상승세", line: "최근 들어 관심이 늘고 있는지예요." },
  ratings_growth: { label: "이용자 반응", line: "앱에 새 평가가 얼마나 꾸준히 쌓이는지예요." },
  downloads: { label: "앱 이용 규모", line: "앱을 내려받은 사람이 얼마나 많은지예요." },
};
export const BONUS_LABEL = "운영 가산";

export function canonical(spec) {
  const sortKeys = (v) =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
        : v;
  return JSON.stringify(sortKeys(spec));
}

export function specHash(spec) {
  return createHash("sha256").update(canonical(spec)).digest("hex");
}

export function checkSpec(spec) {
  const errs = [];
  if (!spec || !Array.isArray(spec.parts) || spec.parts.length === 0) errs.push("parts");
  else {
    const sum = spec.parts.reduce((a, p) => a + p.w, 0);
    if (Math.abs(sum - 100) > 1e-9) errs.push("weights");
    for (const p of spec.parts) {
      if (!PARTS[p.key]) errs.push(`key:${p.key}`);
      if (!["log", "rank", "zcap"].includes(p.t)) errs.push(`t:${p.key}`);
      if (!(p.w > 0)) errs.push(`w:${p.key}`);
    }
  }
  if (!(spec?.blend > 0 && spec.blend <= 1)) errs.push("blend");
  if (!["prev", "first", "name"].includes(spec?.tie)) errs.push("tie");
  if (!(spec?.scale > 0) || !Number.isInteger(spec?.decimals ?? 0)) errs.push("scale");
  if (!(spec?.floor >= 0 && spec.floor < 5)) errs.push("floor");
  if (!Array.isArray(spec?.lift)) errs.push("lift");
  if (!(spec?.gap >= 0)) errs.push("gap");
  return errs;
}

function rawValues(id, week, prevWeek) {
  const cur = week?.values?.[id] ?? {};
  const old = prevWeek?.values?.[id] ?? {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const search = num(cur.search);
  const prior = num(cur.searchPrior);
  const fresh = !(cur.carried ?? []).includes("ratings");
  const ratings = fresh ? num(cur.ratings) : null;
  const oldRatings = num(old.ratings);
  return {
    search,
    search_trend: search !== null && prior !== null ? (search + 1) / (prior + 1) - 1 : null,
    downloads: num(cur.installs),
    ratings_growth: ratings !== null && oldRatings !== null ? Math.max(0, ratings - oldRatings) : null,
  };
}

function normalize(values, t) {
  const ids = Object.keys(values);
  const out = {};
  if (ids.length === 0) return out;
  const xs = ids.map((id) => values[id]);
  if (t === "log") {
    const ls = xs.map((x) => Math.log10(1 + Math.max(0, x)));
    const max = Math.max(...ls);
    ids.forEach((id, i) => (out[id] = max > 0 ? ls[i] / max : 1));
  } else if (t === "rank") {
    if (ids.length === 1) out[ids[0]] = 1;
    else
      ids.forEach((id, i) => {
        const below = xs.filter((x) => x < xs[i]).length;
        const same = xs.filter((x) => x === xs[i]).length - 1;
        out[id] = (below + same / 2) / (ids.length - 1);
      });
  } else {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    ids.forEach((id, i) => {
      const z = sd > 0 ? Math.max(-2, Math.min(2, (xs[i] - mean) / sd)) : 0;
      out[id] = (z + 2) / 4;
    });
  }
  return out;
}

function splitRound(parts, unitTotal) {
  const keys = Object.keys(parts);
  const floors = Object.fromEntries(keys.map((k) => [k, Math.floor(parts[k])]));
  let left = unitTotal - keys.reduce((a, k) => a + floors[k], 0);
  const order = [...keys].sort((a, b) => parts[b] - Math.floor(parts[b]) - (parts[a] - Math.floor(parts[a])) || (a < b ? -1 : 1));
  for (const k of order) {
    if (left <= 0) break;
    floors[k] += 1;
    left -= 1;
  }
  return floors;
}

export function computeWeek({ vendors, week, prevWeek, prevRanking, spec, date }) {
  const active = vendors.filter((v) => v.status !== "excluded");
  const raw = Object.fromEntries(active.map((v) => [v.id, rawValues(v.id, week, prevWeek)]));
  const norm = {};
  for (const p of spec.parts) {
    const vals = {};
    for (const v of active) if (raw[v.id][p.key] !== null) vals[v.id] = raw[v.id][p.key];
    norm[p.key] = normalize(vals, p.t);
  }

  const unit = 10 ** (spec.decimals ?? 0);
  const units = spec.scale * unit;
  const prevById = Object.fromEntries((prevRanking?.entries ?? []).map((e) => [e.id, e]));
  const rows = [];
  const waiting = [];
  for (const v of active) {
    const have = spec.parts.filter((p) => norm[p.key][v.id] !== undefined);
    if (have.length === 0) {
      waiting.push(v.id);
      continue;
    }
    const wsum = have.reduce((a, p) => a + p.w, 0);
    const items = {};
    for (const p of have) items[p.key] = (p.w / wsum) * norm[p.key][v.id];
    const prev = prevById[v.id];
    if (prev && spec.blend < 1) {
      const keys = new Set([...Object.keys(items), ...Object.keys(prev.items ?? {})]);
      for (const k of keys) {
        const before = (prev.items?.[k] ?? 0) / units;
        items[k] = spec.blend * (items[k] ?? 0) + (1 - spec.blend) * before;
      }
    }
    const base = Object.values(items).reduce((a, b) => a + b, 0);
    rows.push({ id: v.id, name: v.name, items, base, total: base, bonus: 0, lifted: false, prev });
  }

  const firstKey = spec.parts[0].key;
  const cmp = (a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (a.lifted !== b.lifted) return a.lifted ? -1 : 1;
    if (spec.tie === "prev") {
      const pa = a.prev?.rank ?? Infinity;
      const pb = b.prev?.rank ?? Infinity;
      if (pa !== pb) return pa - pb;
    } else if (spec.tie === "first") {
      const fa = norm[firstKey][a.id] ?? -1;
      const fb = norm[firstKey][b.id] ?? -1;
      if (fa !== fb) return fb - fa;
    }
    return a.name.localeCompare(b.name, "ko");
  };
  rows.sort(cmp);

  for (let round = 0; round < 20; round++) {
    let moved = false;
    for (const rule of spec.lift) {
      const at = rows.findIndex((r) => r.id === rule.id);
      if (at < 0 || at + 1 <= rule.max || rows.length < rule.max) continue;
      const edge = rows.filter((r) => r.id !== rule.id)[rule.max - 1];
      const row = rows[at];
      const target = Math.min(1, edge.total + spec.gap / 100);
      if (target > row.total) {
        row.bonus += target - row.total;
        row.total = target;
      }
      row.lifted = true;
      rows.sort(cmp);
      moved = true;
    }
    if (!moved) break;
  }

  const entries = rows.map((r, i) => {
    const totalUnits = Math.round(r.total * units);
    const baseUnits = Math.min(totalUnits, Math.round(r.base * units));
    const itemUnits = splitRound(
      Object.fromEntries(Object.entries(r.items).map(([k, x]) => [k, x * units])),
      baseUnits,
    );
    const star = Math.round((spec.floor + (5 - spec.floor) * Math.min(1, r.total)) * 10) / 10;
    return {
      id: r.id,
      rank: i + 1,
      prev: r.prev?.rank ?? null,
      total: totalUnits / unit,
      items: Object.fromEntries(Object.entries(itemUnits).map(([k, u]) => [k, u / unit])),
      bonus: (totalUnits - baseUnits) / unit,
      star,
    };
  });
  return { date, scale: spec.scale, decimals: spec.decimals ?? 0, keys: spec.parts.map((p) => p.key), entries, waiting };
}

export function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}

export function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function kstDate(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
}

function main() {
  const text = process.env.TALLY_SPEC;
  if (!text) {
    console.log("::warning::점수 설정이 없어 계산을 건너뜁니다.");
    return;
  }
  let spec;
  try {
    spec = JSON.parse(text);
  } catch {
    console.log("::warning::점수 설정을 읽지 못해 계산을 건너뜁니다.");
    return;
  }
  const errs = checkSpec(spec);
  if (errs.length) {
    console.log("::warning::점수 설정 형식이 맞지 않아 계산을 건너뜁니다.");
    return;
  }
  const expect = existsSync("data/tally.sha256") ? readFileSync("data/tally.sha256", "utf8").trim() : "";
  if (expect && expect !== specHash(spec)) {
    console.log("::warning::점수 설정이 기록과 달라 계산을 건너뜁니다.");
    return;
  }
  const vendors = readJson("data/vendors.json", []);
  const metrics = readJson("data/metrics.json", { weeks: [] });
  const ranking = readJson("data/ranking.json", { weeks: [] });
  const date = process.env.TALLY_DATE || kstDate();
  const mw = metrics.weeks.filter((w) => w.date <= date);
  const week = mw.at(-1);
  if (!week) {
    console.log("::warning::지표 기록이 없어 계산을 건너뜁니다.");
    return;
  }
  const prevWeek = mw.filter((w) => w.date < week.date).at(-1);
  const older = ranking.weeks.filter((w) => w.date < date);
  const result = computeWeek({ vendors, week, prevWeek, prevRanking: older.at(-1), spec, date });
  ranking.weeks = [...older, result].slice(-26);
  writeJson("data/ranking.json", ranking);
  if (!existsSync("data/baseline.json")) writeJson("data/baseline.json", result);
  if (!expect) writeFileSync("data/tally.sha256", specHash(spec) + "\n");
  console.log(`계산 완료: ${result.entries.length}곳, 대기 ${result.waiting.length}곳`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
