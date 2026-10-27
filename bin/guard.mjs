import { createHash } from "node:crypto";

const LIST = [
  [3550315031, "47b59cda57a24853e7392e0d", 5],
  [2551496123, "00a311c3aa44e326e408609a", 5],
  [669812161, "c7b62df44d4b300aa085578f", 4],
  [835075801, "9334cc5e5bb7249e8f497e94", 4],
  [776015275, "994023e5e23912692fd607b4", 5],
  [1899991392, "176d6ee0e2b01b813babcefa", 3],
  [1522423614, "3c2bec6e124172b258137a3e", 7],
  [1235436476, "e94667333367f131e6d8dc80", 8],
  [16531607, "95bd7e3c006c18d9e8a1bd2d", 6],
  [3973616721, "105a307f28a4dcad2d44e5df", 9],
  [2447044948, "fc4e728fef70b0f34b5eb975", 9],
  [4030396268, "7ebe1c17d62733c89279786f", 5],
];

export const LIST_SIZE = LIST.length;

export function fnv(s) {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function blockedLines(text, extra = []) {
  const list = [...LIST, ...extra];
  const byFnv = new Map(list.map(([f, s, n]) => [f, { s, n }]));
  const maxLen = Math.max(...list.map((r) => r[2]));
  const lines = new Set();
  text.toLowerCase().split("\n").forEach((line, li) => {
    const chars = [...line];
    for (let i = 0; i < chars.length; i++) {
      let h = 0x811c9dc5;
      for (let j = i; j < Math.min(chars.length, i + maxLen); j++) {
        h ^= chars[j].codePointAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
        const hit = byFnv.get(h);
        if (hit && hit.n === j - i + 1) {
          const word = chars.slice(i, j + 1).join("");
          if (createHash("sha256").update(word).digest("hex").startsWith(hit.s)) lines.add(li + 1);
        }
      }
    }
  });
  return [...lines];
}
