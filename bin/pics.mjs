import { existsSync, mkdirSync } from "node:fs";
import sharp from "sharp";
import { readJson } from "./tally.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const force = process.argv.includes("--force");

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" } });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res;
}

async function iconSource(v) {
  if (v.iosId) {
    try {
      const json = await (await get(`https://itunes.apple.com/lookup?id=${v.iosId}&country=kr`)).json();
      const art = json.results?.[0]?.artworkUrl512;
      if (art) return art;
    } catch {
      /* fall back to the other store */
    }
  }
  if (v.playId) {
    const html = await (await get(`https://play.google.com/store/apps/details?id=${encodeURIComponent(v.playId)}&hl=ko&gl=KR`)).text();
    const m = html.match(/<meta property="og:image" content="([^"]+)"/);
    if (m) return m[1].replace(/=w\d+(-h\d+)?[^&"]*$/, "") + "=w256-h256";
  }
  return null;
}

async function main() {
  mkdirSync("assets/icon", { recursive: true });
  const vendors = readJson("data/vendors.json", []).filter((v) => v.status !== "excluded");
  for (const v of vendors) {
    const out = `assets/icon/${v.id}.webp`;
    if (!force && existsSync(out)) continue;
    try {
      const src = await iconSource(v);
      if (!src) {
        console.log(`${v.id}: no source`);
        continue;
      }
      const buf = Buffer.from(await (await get(src)).arrayBuffer());
      await sharp(buf).resize(128, 128, { fit: "cover" }).flatten({ background: "#ffffff" }).webp({ quality: 88 }).toFile(out);
      console.log(`${v.id}: ok`);
    } catch {
      console.log(`${v.id}: failed`);
    }
  }
}

main();
