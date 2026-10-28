import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { blockedLines, fnv, LIST_SIZE } from "../bin/guard.mjs";

const vendors = JSON.parse(readFileSync("data/vendors.json", "utf8"));
const faq = JSON.parse(readFileSync("data/faq.json", "utf8"));

test("업체 목록 형식", () => {
  const ids = new Set();
  const names = new Set();
  for (const v of vendors) {
    assert.match(v.id, /^[a-z0-9]+$/);
    assert.ok(!ids.has(v.id) && !names.has(v.name), `중복 ${v.id}`);
    ids.add(v.id);
    names.add(v.name);
    assert.ok(["active", "excluded", "pending"].includes(v.status));
    assert.match(v.url, /^https:\/\/[^/]+\//);
    if (v.playId) assert.match(v.playId, /^[A-Za-z0-9_.]+$/);
    if (v.iosId) assert.match(v.iosId, /^\d+$/);
  }
});

test("혜택 문구 규칙", () => {
  for (const v of vendors) {
    for (const b of v.benefits ?? []) {
      assert.ok(["join", "event"].includes(b.kind), `${v.id} 종류`);
      const len = [...b.text].length;
      assert.ok(len >= 2 && len <= 16, `${v.id} 길이 ${len} "${b.text}"`);
      assert.doesNotMatch(b.text, /(지급|진행\s?중|증정|드립니다|확인 필요)|\s시$|^[–-]$/, `${v.id} 꼬리말 "${b.text}"`);
    }
  }
});

test("다루지 않는 업체 검사", () => {
  assert.equal(LIST_SIZE, 12);
  const word = "가상의테스트업체";
  const extra = [[fnv(word), createHash("sha256").update(word).digest("hex").slice(0, 24), [...word].length]];
  assert.deepEqual(blockedLines(`첫 줄\n여기에 ${word} 있음`, extra), [2]);
  assert.deepEqual(blockedLines(JSON.stringify(vendors, null, 2)), []);
  assert.deepEqual(blockedLines(JSON.stringify(faq, null, 2)), []);
});

test("FAQ 답은 짧게", () => {
  for (const f of [...faq.home, ...faq.criteria]) {
    assert.ok([...f.q].length <= 30, f.q);
    assert.ok([...f.a].length <= 60, f.a);
  }
});
