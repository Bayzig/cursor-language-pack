#!/usr/bin/env node
// Second pass: translate the original English sources of the ru locale directly
// (zh machine translations lose nuance, and some keys have no zh counterpart).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RU = path.join(ROOT, 'src/i18n/ru');
const CACHE_FILE = path.join(ROOT, '.en2ru-cache.json');

const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};

async function translateOne(text) {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'en');
  url.searchParams.set('tl', 'ru');
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', text);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const out = (json[0] ?? []).map((s) => s?.[0] ?? '').join('');
      if (out) return out;
      throw new Error('empty');
    } catch { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); }
  }
  return null;
}

function polish(raw) {
  let s = String(raw).trim();
  s = s.replace(/，/g, ', ').replace(/。/g, '.').replace(/\s{2,}/g, ' ');
  s = s.replace(/\{\s*(\d+)\s*\}/g, '{$1}');
  return s;
}

// Collect every English key that carries a translation in ru/.
const targets = []; // {file, get/set paths, enKey}
function collectFromDict(obj, file) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') targets.push({ file, key: k });
    else if (v && typeof v === 'object') collectFromDict(v, file);
  }
}
for (const rel of ['hardcoded.json', 'commerce.json', 'extension.l10n.json']) {
  const f = path.join(RU, rel);
  if (fs.existsSync(f)) collectFromDict(JSON.parse(fs.readFileSync(f, 'utf8')), rel);
}
console.log(`${targets.length} dictionary keys`);

const need = [...new Set(targets.map((t) => t.key))]
  .filter((k) => /[A-Za-z]{3}/.test(k) && !(k in cache));
console.log(`translating ${need.length} new English strings`);
let done = 0, queue = [...need];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const src = queue.shift();
    cache[src] = await translateOne(src);
    if (++done % 100 === 0) {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 0));
      console.log(`...${done}/${need.length}`);
    }
  }
}));
fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 0));

// Apply: for dict files, prefer the fresh EN->RU translation over the zh-derived one.
for (const rel of ['hardcoded.json', 'commerce.json', 'extension.l10n.json']) {
  const f = path.join(RU, rel);
  if (!fs.existsSync(f)) continue;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  (function rec(o) {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v !== 'string') { if (v && typeof v === 'object') rec(v); continue; }
      const fresh = cache[k];
      if (fresh) o[k] = polish(fresh);
    }
  })(d);
  fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
}
console.log('second pass done');
