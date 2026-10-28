import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { readJson } from "./tally.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const force = process.argv.includes("--force");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res;
}

export function pickLogo(html, base, name) {
  let best = null;
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = tag.match(/\s(?:data-src|src)=["']([^"']+)["']/i)?.[1];
    if (!src || src.startsWith("data:")) continue;
    const alt = tag.match(/\salt=["']([^"']*)["']/i)?.[1] ?? "";
    let score = 0;
    if (/logo/i.test(tag)) score += 4;
    if (alt.includes(name)) score += 2;
    if (/(top|header|gnb|head)/i.test(src)) score += 1;
    if (/(banner|event|ico_|icon|btn|sns|qr|app_)/i.test(src)) score -= 3;
    if (score > (best?.score ?? 0)) best = { score, url: new URL(src, base).href };
  }
  return best?.url ?? null;
}

export async function normalizeLogo(buf) {
  const trimmed = await sharp(buf, { animated: false, density: 288 }).ensureAlpha().trim({ threshold: 12 }).png().toBuffer();
  const { data, info } = await sharp(trimmed).raw().toBuffer({ resolveWithObject: true });
  let light = 0;
  let solid = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    solid += 1;
    if (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] > 220) light += 1;
  }
  let img = sharp(trimmed);
  if (solid && light / solid > 0.85 && solid < info.width * info.height * 0.8) {
    const alpha = await sharp(trimmed).extractChannel(3).raw().toBuffer();
    img = sharp({ create: { width: info.width, height: info.height, channels: 3, background: "#1f2328" } }).joinChannel(alpha, {
      raw: { width: info.width, height: info.height, channels: 1 },
    });
  }
  return img.resize({ width: 360, height: 120, fit: "inside", withoutEnlargement: true }).webp({ quality: 92, alphaQuality: 100 }).toBuffer();
}

async function main() {
  mkdirSync("assets/logo", { recursive: true });
  const vendors = readJson("data/vendors.json", []).filter((v) => v.status !== "excluded" && (!only || only.includes(v.id)));
  for (const v of vendors) {
    const out = `assets/logo/${v.id}.webp`;
    if (!force && existsSync(out)) continue;
    try {
      const src = v.logoUrl ?? pickLogo(await (await get(v.url)).text(), v.url, v.name);
      if (!src) {
        console.log(`${v.id}: no source`);
        continue;
      }
      writeFileSync(out, await normalizeLogo(Buffer.from(await (await get(src)).arrayBuffer())));
      console.log(`${v.id}: ok ${new URL(src).pathname}`);
    } catch (err) {
      console.log(`${v.id}: failed (${err.message})`);
    }
  }
}

async function shoot() {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ deviceScaleFactor: 3, viewport: { width: 1280, height: 900 }, userAgent: UA, locale: "ko-KR" });
  mkdirSync("assets/logo-hi", { recursive: true });
  const vendors = readJson("data/vendors.json", []).filter((v) => v.status !== "excluded" && v.url && (!only || only.includes(v.id)));
  for (const v of vendors) {
    const page = await ctx.newPage();
    try {
      await page.goto(v.url, { waitUntil: "networkidle", timeout: 30000 });
      const handle = await page.evaluateHandle((name) => {
        let best = null;
        let top = 0;
        for (const el of document.querySelectorAll("img, svg")) {
          const r = el.getBoundingClientRect();
          if (r.width < 40 || r.height < 12 || r.top > 260 || r.width / r.height < 1.2) continue;
          const text = [el.getAttribute("src"), el.getAttribute("alt"), el.getAttribute("class"), el.id, el.closest("a,div,h1")?.className].join(" ");
          let score = 0;
          if (/logo/i.test(text)) score += 4;
          if ((el.getAttribute("alt") ?? "").includes(name)) score += 2;
          if (el.closest("header, #header, .header, h1")) score += 2;
          if (/(banner|event|ico_|icon|btn|sns|qr|app_)/i.test(text)) score -= 3;
          if (score > top) {
            top = score;
            best = el;
          }
        }
        return best;
      }, v.name);
      const el = handle.asElement();
      if (!el) {
        console.log(`${v.id}: no element`);
        continue;
      }
      const shot = await el.screenshot({ omitBackground: true });
      writeFileSync(`assets/logo-hi/${v.id}.webp`, await normalizeLogo(shot));
      console.log(`${v.id}: ok`);
    } catch (err) {
      console.log(`${v.id}: failed (${err.message})`);
    } finally {
      await page.close();
    }
  }
  await browser.close();
}

if (process.argv[1]?.endsWith("pics.mjs")) (process.argv.includes("--shot") ? shoot : main)();
