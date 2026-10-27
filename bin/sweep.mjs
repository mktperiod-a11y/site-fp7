import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import sharp from "sharp";
import { blockedLines } from "./guard.mjs";

const full = process.argv.includes("--history");
const problems = [];
const report = (where, what) => problems.push(`${where} — ${what}`);
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });

const TEXT = new Set([".html", ".css", ".js", ".mjs", ".json", ".md", ".txt", ".xml", ".yml", ".yaml", ".svg", ""]);
const IMAGES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);
const BOT = "41898282+github-actions[bot]@users.noreply.github.com";

const list = (name) =>
  (process.env[name] ?? "")
    .split("\n")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
const terms = list("SWEEP_TERMS");
const phrases = list("SWEEP_PHRASES");
if (!terms.length) console.log("::warning::금지 문자열 목록이 비어 있습니다.");
if (!phrases.length) console.log("::warning::특징 문구 목록이 비어 있습니다.");

function repoNames() {
  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (fromEnv) return fromEnv.toLowerCase().split("/");
  try {
    const url = git("remote", "get-url", "origin").trim();
    const m = url.match(/[/:]([^/:]+)\/([^/]+?)(\.git)?$/);
    return m ? [m[1].toLowerCase(), m[2].toLowerCase()] : [];
  } catch {
    return [];
  }
}
const names = repoNames().filter((n) => n.length >= 4);

const PATTERNS = [
  ["이메일", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ["전화번호", /(?<![\d-])0(1[016789]|2|[3-6][1-5]|70)[-. ]?\d{3,4}[-. ]?\d{4}(?![\d-])/g],
  ["확인 코드", /google-site-verification|naver-site-verification|msvalidate\.01|yandex-verification/gi],
  ["분석·광고 ID", /\bUA-\d{4,}-\d+\b|\bG-[A-Z0-9]{8,12}\b|\bGTM-[A-Z0-9]{5,}\b|ca-pub-\d{8,}/g],
];

function scanText(where, text, { patterns = true } = {}) {
  const lower = text.toLowerCase();
  const lineOf = (idx) => lower.slice(0, idx).split("\n").length;
  for (const t of terms) for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + 1)) report(`${where}:${lineOf(i)}`, "금지 문자열");
  for (const p of phrases) for (let i = lower.indexOf(p); i >= 0; i = lower.indexOf(p, i + 1)) report(`${where}:${lineOf(i)}`, "특징 문구");
  for (const n of names) for (let i = lower.indexOf(n); i >= 0; i = lower.indexOf(n, i + 1)) report(`${where}:${lineOf(i)}`, "계정·저장소 이름");
  if (!patterns) return;
  text.split("\n").forEach((line, i) => {
    for (const [label, re] of PATTERNS) {
      for (const m of line.matchAll(re)) {
        if (label === "이메일" && m[0].toLowerCase() === BOT) continue;
        report(`${where}:${i + 1}`, label);
      }
    }
  });
}

async function scanImage(where, buf) {
  try {
    const meta = await sharp(buf).metadata();
    if (meta.exif || meta.xmp || meta.iptc || meta.icc || (meta.comments && meta.comments.length)) report(where, "이미지 메타데이터");
  } catch {
    report(where, "이미지를 읽지 못함");
  }
}

function scanSvg(where, text) {
  if (/<metadata|inkscape:|sodipodi:|<!--|xmlns:(dc|cc|rdf)=/i.test(text)) report(where, "SVG 편집 흔적");
  if (/data:image\//i.test(text)) report(where, "SVG 안 이미지");
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
}

async function scanFile(where, path) {
  const ext = extname(path).toLowerCase();
  if (IMAGES.has(ext)) return scanImage(where, readFileSync(path));
  if (!TEXT.has(ext) || statSync(path).size > 4 << 20) return;
  const text = readFileSync(path, "utf8");
  scanText(where, text, { patterns: !/(package-lock\.json|bin\/sweep\.mjs)$/.test(path) });
  if (ext === ".svg") scanSvg(where, text);
  for (const line of blockedLines(text)) report(`${where}:${line}`, "다루지 않는 업체");
  for (const m of text.matchAll(/data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)/g)) await scanImage(`${where} (내장 이미지)`, Buffer.from(m[1], "base64"));
}

function commitRange() {
  if (full) return ["--all"];
  const range = process.env.SWEEP_RANGE;
  if (range && !/^0+\.\./.test(range)) {
    try {
      git("rev-list", "--count", range);
      return [range];
    } catch {
      /* fall back to recent commits */
    }
  }
  return ["-n", "30", "HEAD"];
}

async function main() {
  const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
  for (const f of tracked) if (existsSync(f)) await scanFile(f, f);
  if (existsSync("_site")) for (const f of walk("_site")) await scanFile(f, f);

  const range = commitRange();
  const log = git("log", ...range, "--format=%h%x01%ae%x01%ce%x01%B%x02");
  for (const rec of log.split("\x02")) {
    const [hash, author, committer, body] = rec.replace(/^\n/, "").split("\x01");
    if (!hash) continue;
    for (const mail of [author, committer]) {
      if (!(mail.endsWith("@users.noreply.github.com") || mail === "noreply@github.com")) report(`커밋 ${hash}`, "공개 이메일로 작성됨");
    }
    scanText(`커밋 ${hash} 메시지`, body ?? "");
  }
  if (full) {
    const diff = git("log", "--all", "-p", "--no-color", "--format=@@commit %h", "--", ".", ":(exclude)assets/fonts");
    let commit = "";
    let file = "";
    for (const line of diff.split("\n")) {
      if (line.startsWith("@@commit ")) commit = line.slice(9);
      else if (line.startsWith("+++ b/")) file = line.slice(6);
      else if (line.startsWith("+") && !line.startsWith("+++")) {
        const before = problems.length;
        scanText(`커밋 ${commit} ${file}`, line.slice(1), { patterns: !file.endsWith("package-lock.json") });
        if (blockedLines(line).length) report(`커밋 ${commit} ${file}`, "다루지 않는 업체");
        if (problems.length > before) problems.splice(before + 1);
      }
    }
  }

  const unique = [...new Set(problems)];
  if (unique.length) {
    console.log(`검사 실패 ${unique.length}건:`);
    for (const p of unique) console.log(`  ${p}`);
    process.exit(1);
  }
  console.log(`검사 통과: 파일 ${tracked.length}개, 커밋 범위 ${range.join(" ")}`);
}

main();
