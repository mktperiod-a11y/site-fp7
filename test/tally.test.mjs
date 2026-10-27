import test from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { computeWeek, checkSpec, specHash, PARTS, PUBLIC_COUNT } from "../bin/tally.mjs";

const KEYS = Object.keys(PARTS);
const TRANSFORMS = ["log", "rank", "zcap"];

function randomSpec(vendorIds) {
  const count = 1 + randomInt(KEYS.length);
  const keys = [...KEYS].sort(() => randomInt(3) - 1).slice(0, count);
  const raw = keys.map(() => 1 + randomInt(20));
  const sum = raw.reduce((a, b) => a + b, 0);
  const w = raw.map((x) => (x / sum) * 100);
  w[w.length - 1] = 100 - w.slice(0, -1).reduce((a, b) => a + b, 0);
  const pool = [...vendorIds].sort(() => randomInt(3) - 1);
  let max = 0;
  const lift = Array.from({ length: randomInt(3) }, (_, i) => ({ id: pool[i], max: (max += 1 + randomInt(3)) }));
  return {
    parts: keys.map((key, i) => ({ key, w: w[i], t: TRANSFORMS[randomInt(3)] })),
    blend: randomInt(2) ? 1 : 0.3 + randomInt(70) / 100,
    tie: ["prev", "first", "name"][randomInt(3)],
    scale: [10, 100, 1000][randomInt(3)],
    decimals: randomInt(3),
    floor: 3 + randomInt(15) / 10,
    lift,
    gap: randomInt(100) / 100,
  };
}

function extremeValue() {
  const r = randomInt(10);
  if (r === 0) return undefined;
  if (r === 1) return 0;
  if (r === 2) return 1e9;
  return randomInt(1, 2_000_000);
}

function randomWeek(ids) {
  const values = {};
  for (const id of ids) {
    const v = {};
    for (const k of ["search", "searchPrior", "installs", "ratings"]) {
      const x = extremeValue();
      if (x !== undefined) v[k] = k.startsWith("search") ? x % 101 : x;
    }
    values[id] = v;
  }
  return { date: "2026-10-26", values };
}

function vendors(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `v${i}`, name: `업체${String.fromCharCode(0xac00 + i * 37)}`, status: "active" }));
}

const units = (week, x) => Math.round(x * 10 ** week.decimals);

test("무작위 규칙 100개: 항목 합과 총점, 가산 범위가 맞는다", () => {
  for (let round = 0; round < 100; round++) {
    const vs = vendors(4 + randomInt(18));
    const ids = vs.map((v) => v.id);
    const spec = randomSpec(ids);
    assert.deepEqual(checkSpec(spec), []);
    const prevWeek = randomWeek(ids);
    const week = randomWeek(ids);
    const first = computeWeek({ vendors: vs, week: prevWeek, spec, date: "2026-10-19" });
    const out = computeWeek({ vendors: vs, week, prevWeek, prevRanking: first, spec, date: "2026-10-26" });

    for (const e of out.entries) {
      const itemSum = Object.values(e.items).reduce((a, x) => a + units(out, x), 0);
      assert.equal(itemSum + units(out, e.bonus), units(out, e.total), `합 불일치 ${JSON.stringify(e)}`);
      assert.ok(e.bonus >= 0);
      assert.ok(e.star >= spec.floor - 1e-9 && e.star <= 5);
      for (const k of Object.keys(e.items)) assert.ok(spec.parts.some((p) => p.key === k));
    }
    const lifted = new Set(spec.lift.map((l) => l.id));
    for (const e of out.entries) if (!lifted.has(e.id)) assert.equal(e.bonus, 0, "규칙 밖 업체에 가산");
    for (const rule of spec.lift) {
      const e = out.entries.find((x) => x.id === rule.id);
      if (!e || out.entries.length <= rule.max) continue;
      assert.ok(e.rank <= rule.max, `허용 순위 밖 ${rule.id} ${e.rank} > ${rule.max}`);
    }
    const ranks = out.entries.map((e) => e.rank);
    assert.deepEqual(ranks, ranks.map((_, i) => i + 1));
    for (let i = 1; i < out.entries.length; i++) assert.ok(out.entries[i - 1].total >= out.entries[i].total);
  }
});

test("지표가 같으면 다음 주 순위도 같다", () => {
  for (let round = 0; round < 50; round++) {
    const vs = vendors(12);
    const ids = vs.map((v) => v.id);
    const spec = { ...randomSpec(ids), lift: [] };
    const week = randomWeek(ids);
    const a = computeWeek({ vendors: vs, week, prevWeek: week, spec, date: "2026-10-19" });
    const b = computeWeek({ vendors: vs, week, prevWeek: week, prevRanking: a, spec, date: "2026-10-26" });
    assert.deepEqual(
      b.entries.map((e) => e.id),
      a.entries.map((e) => e.id),
    );
  }
});

test("지표가 일부 없으면 있는 항목으로 비중을 나눈다", () => {
  const vs = vendors(3);
  const spec = {
    parts: [
      { key: "search", w: 40, t: "rank" },
      { key: "downloads", w: 60, t: "log" },
    ],
    blend: 1,
    tie: "name",
    scale: 100,
    decimals: 0,
    floor: 3.5,
    lift: [],
    gap: 0,
  };
  const week = { values: { v0: { search: 50, installs: 1000 }, v1: { installs: 1000 }, v2: {} } };
  const out = computeWeek({ vendors: vs, week, spec, date: "2026-10-26" });
  const v1 = out.entries.find((e) => e.id === "v1");
  assert.deepEqual(Object.keys(v1.items), ["downloads"]);
  assert.equal(v1.total, 100);
  assert.deepEqual(out.waiting, ["v2"]);
});

test("제외 상태 업체는 계산하지 않는다", () => {
  const vs = vendors(3);
  vs[1].status = "excluded";
  const spec = { ...randomSpec(["v0"]), lift: [] };
  const week = randomWeek(["v0", "v1", "v2"]);
  const out = computeWeek({ vendors: vs, week, spec, date: "2026-10-26" });
  assert.ok(!out.entries.some((e) => e.id === "v1"));
  assert.ok(!out.waiting.includes("v1"));
});

test("설정 확인과 해시", () => {
  const spec = randomSpec(["v0"]);
  assert.deepEqual(checkSpec(spec), []);
  const shuffled = Object.fromEntries(Object.entries(spec).reverse());
  assert.equal(specHash(spec), specHash(shuffled));
  assert.notDeepEqual(checkSpec({ ...spec, parts: [{ key: "search", w: 50, t: "log" }] }), []);
  assert.notDeepEqual(checkSpec({ ...spec, tie: "dice" }), []);
  assert.equal(PUBLIC_COUNT, 10);
});
