import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cols, PLACEHOLDER } from "../bin/compose.mjs";

function build(env) {
  const out = mkdtempSync(join(tmpdir(), "site-"));
  execFileSync("node", ["bin/compose.mjs"], { env: { ...process.env, OUT_DIR: out, ...env }, stdio: "pipe" });
  return out;
}

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

const custom = build({ SITE_URL: "https://example.org" });
const hosted = build({ SITE_URL: "https://someone.github.io/project" });
const local = build({});
const ranking = JSON.parse(readFileSync("data/ranking.json", "utf8"));
const vendors = JSON.parse(readFileSync("data/vendors.json", "utf8")).filter((v) => v.status !== "excluded");

test("공개 수와 이동 페이지", () => {
  const html = readFileSync(join(custom, "index.html"), "utf8");
  const rows = (html.match(/<li class="entry[ "]/g) ?? []).length;
  const computable = ranking.weeks.at(-1)?.entries.length ?? 0;
  assert.equal(rows, Math.min(10, computable));
  const go = existsSync(join(custom, "go")) ? readdirSync(join(custom, "go")) : [];
  assert.equal(go.length, rows);
  for (const id of go) {
    const page = readFileSync(join(custom, "go", id, "index.html"), "utf8");
    assert.match(page, /noindex,nofollow/);
    const v = vendors.find((x) => x.id === id);
    assert.ok(!page.includes(v.url), "공식 주소가 그대로 들어 있음");
  }
});

test("결과물에 내부 파일·주석·자리표시가 없다", () => {
  for (const f of walk(custom)) {
    const rel = f.slice(custom.length + 1);
    assert.doesNotMatch(rel, /^(data|bin|test|src|\.github)\/|CLAUDE\.md|package/);
    if (!/\.(html|css|txt|xml)$/.test(f)) continue;
    const text = readFileSync(f, "utf8");
    assert.ok(!text.includes("<!--"), `HTML 주석 ${rel}`);
    assert.ok(!text.includes("/*"), `CSS 주석 ${rel}`);
    assert.ok(!text.includes(PLACEHOLDER), `자리표시 ${rel}`);
    text.split("\n").forEach((line, i) => assert.ok(cols(line) <= 140, `줄 길이 ${rel}:${i + 1} (${cols(line)})`));
  }
});

test("GitHub 기본 주소면 절대 주소와 sitemap을 쓰지 않는다", () => {
  assert.ok(!existsSync(join(hosted, "sitemap.xml")));
  for (const f of walk(hosted)) {
    if (!/\.(html|css|txt|xml)$/.test(f)) continue;
    const text = readFileSync(f, "utf8");
    assert.ok(!/github\.io/.test(text), `계정 주소 ${f.slice(hosted.length)}`);
  }
  assert.ok(existsSync(join(custom, "sitemap.xml")));
  assert.match(readFileSync(join(custom, "robots.txt"), "utf8"), /Sitemap: https:\/\/example\.org\/sitemap\.xml/);
});

test("로컬 빌드는 자리표시 주소를 쓴다", () => {
  assert.ok(readFileSync(join(local, "index.html"), "utf8").includes(PLACEHOLDER));
});

test("페이지마다 제목·설명·보안 정책", () => {
  const titles = new Set();
  for (const f of walk(custom).filter((x) => x.endsWith(".html"))) {
    const html = readFileSync(f, "utf8");
    const rel = f.slice(custom.length + 1);
    assert.match(html, /http-equiv="Content-Security-Policy"/, rel);
    assert.match(html, /name="referrer" content="no-referrer"/, rel);
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(m[1]);
    if (/noindex/.test(html)) continue;
    const title = html.match(/<title>\s*([\s\S]*?)\s*<\/title>/)[1].replace(/\s+/g, " ");
    const desc = html.match(/name="description"\s+content="([\s\S]*?)"/)[1].replace(/\s+/g, " ");
    assert.ok(title.length >= 30 && title.length <= 60, `제목 길이 ${rel} ${title.length}`);
    assert.ok(desc.length >= 80 && desc.length <= 150, `설명 길이 ${rel} ${desc.length}`);
    assert.ok(!titles.has(title), `제목 중복 ${rel}`);
    titles.add(title);
  }
});

test("404는 색인하지 않는다", () => {
  assert.match(readFileSync(join(custom, "404.html"), "utf8"), /name="robots" content="noindex"/);
});
