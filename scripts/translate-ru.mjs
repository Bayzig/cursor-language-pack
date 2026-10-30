#!/usr/bin/env node
// One-off helper: machine-translate the zh skeleton under src/i18n/ru into Russian.
// Source of truth is the Chinese text that was copied into ru/*; we translate it
// with the public Google translate endpoint (batched), cache results, and rewrite
// every *.i18n.json / l10n / hardcoded / commerce file in place.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RU = path.join(ROOT, 'src/i18n/ru');
const CACHE_FILE = path.join(ROOT, '.zh2ru-cache.json');
const GLOSSARY_FILE = path.join(import.meta.dirname, 'lib', 'zh2ru-dict.json');

const glossary = JSON.parse(fs.readFileSync(GLOSSARY_FILE, 'utf8'));
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};

const hasCJK = (s) => /[\u3400-\u9fff\uf900-\ufaff]/.test(s);

// The free gtx endpoint only reliably serves a single q= per request, so we
// parallelise single-string requests instead of batching them.
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const POOL = 8;

async function translateOne(text) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'zh-CN');
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
      throw new Error('empty response');
    } catch { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); }
  }
  return text; // leave untranslated rather than dropping the string
}

async function runPool(items, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(POOL, queue.length) }, async () => {
    while (queue.length) { const item = queue.shift(); await worker(item); }
  });
  await Promise.all(runners);
}

function polish(raw) {
  let s = raw.trim();
  // Full-width punctuation → normal.
  s = s.replace(/（/g, '(').replace(/）/g, ')').replace(/：/g, ':').replace(/；/g, ';')
       .replace(/，/g, ', ').replace(/。/g, '.').replace(/、/g, ', ');
  // Restore placeholders that Google mangles ({0} sometimes comes back as {0} anyway).
  s = s.replace(/\{\s*(\d+)\s*\}/g, '{$1}');
  // Curly quotes.
  s = s.replace(/«\s*/g, '«').replace(/\s*»/g, '»');
  s = s.replace(/\s{2,}/g, ' ');
  return s;
}

async function translateMany(texts) {
  const need = [...new Set(texts.filter(hasCJK))].filter((t) => !(t in cache) && !(t in glossary));
  console.log(`translating ${need.length} new strings (${texts.length} occurrences)`);
  let done = 0;
  await runPool(need, async (src) => {
    cache[src] = await translateOne(src);
    if (++done % 100 === 0) {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 0));
      console.log(`...${done}/${need.length}`);
    }
  });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 0));
  return (t) => glossary[t] ?? cache[t] ?? t;
}

function walk(node, lookup) {
  if (Array.isArray(node)) return node.map((v) => walk(v, lookup));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, lookup);
    return out;
  }
  if (typeof node === 'string' && hasCJK(node)) {
    const exact = lookup(node);
    if (exact && !hasCJK(exact)) return polish(exact);
    // Compose: replace glossary terms inside longer sentences too.
    let s = node;
    for (const [zh, ru] of Object.entries(glossary)) s = s.split(zh).join(ru);
    const base = lookup(node);
    if (base && !hasCJK(base)) s = polish(base);
    // Strip any leftover CJK characters (untranslated fragments).
    s = s.replace(/[\u3400-\u9fff]+/g, '').replace(/\s{2,}/g, ' ').trim();
    return s;
  }
  return node;
}

const files = [];
(function collect(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p);
    else if (e.name.endsWith('.json')) files.push(p);
  }
})(RU);

const strings = [];
(function scan(list) {
  for (const f of list) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    (function rec(x) {
      if (Array.isArray(x)) x.forEach(rec);
      else if (x && typeof x === 'object') Object.values(x).forEach(rec);
      else if (typeof x === 'string' && hasCJK(x)) strings.push(x);
    })(d);
  }
})(files);

const lookup = await translateMany(strings);
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const translated = walk(d, lookup);
  fs.writeFileSync(f, JSON.stringify(translated, null, 2) + '\n');
}
console.log('done, files:', files.length);
