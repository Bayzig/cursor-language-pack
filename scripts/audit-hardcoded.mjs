#!/usr/bin/env node
/**
 * Audit reviewed dictionary additions against real bundles without installing.
 *
 * node scripts/audit-hardcoded.mjs --app-root="F:/AI/cursor/resources/app" \
 *   --before-dict="<saved hardcoded.json>" --report="reports/<audit>.json" \
 *   --baseline-record="<optional read-only rewrite.json>" --check-syntax
 *
 * The report's additions/pendingScriptChanges carry human review notes. Raw
 * field matches are candidates, never automatically classified as visible UI.
 * Only the report and isolated temporary syntax-check copies are written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { rewrite } from './translate-install.mjs';
import { p, parseArgs } from './lib/util.mjs';

const { flags } = parseArgs();
if (!flags['app-root'] || !flags['before-dict'] || !flags.report) {
  console.error('Required: --app-root=... --before-dict=... --report=...; optional: --baseline-record=... --check-syntax');
  process.exit(1);
}
const appRoot = path.resolve(String(flags['app-root']));
const beforeFile = path.resolve(String(flags['before-dict']));
const reportFile = path.resolve(String(flags.report));
const dictFile = p('src', 'i18n', 'zh-cn', 'hardcoded.json');
const scriptFile = p('scripts', 'translate-install.mjs');
const bundleNames = [
  'workbench.desktop.main.js',
  'workbench.glass.main.js',
  'workbench.anysphere-ui-automations.js'
];
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const entries = (dict) => Object.entries(dict).filter(([key, value]) => !key.startsWith('$') && typeof value === 'string');
const counts = (dict) => ({
  totalEntries: entries(dict).length,
  effectiveTranslations: entries(dict).filter(([key, value]) => value.length > 0 && value !== key).length,
  unchangedEnglish: entries(dict).filter(([key, value]) => value === key).map(([key]) => key)
});
function inside(file, directory) {
  const rel = path.relative(directory, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
if (!inside(reportFile, p('reports'))) throw new Error('The report must be inside this repository\'s reports directory.');
if (inside(reportFile, appRoot)) throw new Error('The application is read-only.');

// Read the production whitelist instead of maintaining a second field list.
const scriptSource = fs.readFileSync(scriptFile, 'utf8');
const fieldDefinition = scriptSource.match(/const UI_FIELDS = \[([\s\S]*?)\];/);
if (!fieldDefinition) throw new Error('Cannot read production UI_FIELDS.');
const uiFields = [...fieldDefinition[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const fieldRe = new RegExp(`\\b(${uiFields.join('|')})\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"|"aria-label"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'g');
function decode(raw) {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (_, token) => {
    if (token.startsWith('u')) return String.fromCharCode(Number.parseInt(token.slice(1), 16));
    return { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[token] ?? token;
  });
}
function evidence(source, bundle) {
  const found = new Map();
  fieldRe.lastIndex = 0;
  for (const m of source.matchAll(fieldRe)) {
    const english = decode(m[2] ?? m[3]);
    const rows = found.get(english) ?? [];
    if (rows.length < 3) rows.push({
      bundle, field: m[1] ?? 'aria-label', offset: m.index,
      context: source.slice(Math.max(0, m.index - 180), m.index + m[0].length + 200)
    });
    found.set(english, rows);
  }
  return found;
}
const before = readJson(beforeFile);
const afterSource = fs.readFileSync(dictFile, 'utf8');
const after = JSON.parse(afterSource);
const previous = fs.existsSync(reportFile) ? readJson(reportFile) : {};
const annotations = new Map((previous.additions ?? []).map((row) => [row.english, row]));
const addedEntries = entries(after).filter(([key]) => !Object.hasOwn(before, key));
const removedEntries = entries(before).filter(([key]) => !Object.hasOwn(after, key)).map(([key]) => key);
const changedEntries = entries(before).filter(([key, value]) => Object.hasOwn(after, key) && after[key] !== value).map(([key]) => key);
const reviewKeys = new Set(addedEntries.map(([key]) => key));
const report = {
  ...previous,
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  status: 'complete-with-reported-rule-gaps',
  appRoot,
  cursorVersion: readJson(path.join(appRoot, 'package.json')).version,
  commit: readJson(path.join(appRoot, 'product.json')).commit,
  offsetUnit: 'zero-based UTF-16 code unit in the original UTF-8-decoded bundle',
  auditedBundles: bundleNames,
  dictionaryCounts: { before: counts(before), after: counts(after) },
  summary: {
    ...previous.summary,
    dictionaryBefore: counts(before).totalEntries,
    effectiveTranslationsBefore: counts(before).effectiveTranslations,
    dictionaryAfter: counts(after).totalEntries,
    effectiveTranslationsAfter: counts(after).effectiveTranslations,
    addedMappings: addedEntries.length,
    removedMappings: removedEntries.length,
    changedExistingMappings: changedEntries.length
  },
  removedEntries, changedEntries,
  bundles: [], additions: [],
  validation: {
    mode: flags['check-syntax'] ? 'rewrite-in-memory-and-node-check-isolated-copies' : 'rewrite-only-in-memory',
    beforeSnapshot: beforeFile,
    dictionarySha256: sha256(afterSource),
    rewriteScriptSha256: sha256(scriptSource),
    uiFields,
    appWrites: false, userConfigWrites: false,
    existingEntriesPreserved: removedEntries.length === 0 && changedEntries.length === 0,
    sourceHashesUnchanged: true,
    syntax: [],
    addedKeysWithNoRewriteHits: []
  }
};

let baselineRecord;
const oldByBundle = new Map();
if (flags['baseline-record']) {
  const recordFile = path.resolve(String(flags['baseline-record']));
  baselineRecord = readJson(recordFile);
  report.baseline = { recordPath: recordFile, cursorVersion: baselineRecord.cursorVersion, commit: baselineRecord.commit, hashesVerified: true, files: [] };
  for (const bundle of bundleNames) {
    const rel = `out/vs/workbench/${bundle}`;
    const entry = baselineRecord.files?.[rel];
    if (!entry?.backup) throw new Error(`Missing baseline bundle: ${bundle}`);
    const bytes = fs.readFileSync(entry.backup);
    const hash = sha256(bytes);
    if (hash !== entry.original) throw new Error(`Backup hash mismatch: ${bundle}`);
    const source = bytes.toString('utf8');
    oldByBundle.set(bundle, { source, decoded: decode(source), hash, backup: entry.backup });
    report.baseline.files.push({ bundle: rel, backup: entry.backup, sha256: hash, bytes: bytes.length });
  }
}

const currentSources = new Map();
const currentEvidence = new Map();
const allCurrentHits = new Set();
const allOldHits = new Set();
const tempDirectory = flags['check-syntax'] ? fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-hardcoded-audit-')) : null;
const tempFiles = [];
try {
  for (const bundle of bundleNames) {
    const file = path.join(appRoot, 'out', 'vs', 'workbench', bundle);
    const bytes = fs.readFileSync(file);
    const source = bytes.toString('utf8');
    const fields = evidence(source, bundle);
    currentSources.set(bundle, { file, source, decoded: decode(source), hash: sha256(bytes) });
    for (const key of reviewKeys) if (fields.has(key)) currentEvidence.set(key, [...currentEvidence.get(key) ?? [], ...fields.get(key)]);
    const beforeResult = rewrite(source, before);
    const result = rewrite(source, after);
    for (const key of result.hits.keys()) allCurrentHits.add(key);
    const old = oldByBundle.get(bundle);
    const oldResult = old ? rewrite(old.source, after) : null;
    if (oldResult) for (const key of oldResult.hits.keys()) allOldHits.add(key);
    report.bundles.push({
      bundle, bytes: bytes.length, sha256: sha256(bytes),
      rewriteCountBefore: beforeResult.count, rewriteCountAfter: result.count,
      matchedKeysBefore: beforeResult.hits.size, matchedKeysAfter: result.hits.size,
      baselineRewriteCount: oldResult?.count,
      addedKeyHits: Object.fromEntries([...result.hits].filter(([key]) => reviewKeys.has(key)))
    });
    if (tempDirectory) {
      const tempFile = path.join(tempDirectory, bundle.replace(/\.js$/, '.mjs'));
      fs.writeFileSync(tempFile, result.text);
      tempFiles.push(tempFile);
      const checked = spawnSync(process.execPath, ['--check', tempFile], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
      report.validation.syntax.push({ bundle, passed: checked.status === 0, diagnostics: checked.error?.message ?? checked.stderr.trim() });
    }
    console.log(`${bundle}: rewrite ${beforeResult.count} -> ${result.count}; ${oldResult ? 'baseline checked' : 'no old bundle'}`);
  }
} finally {
  for (const file of tempFiles) fs.unlinkSync(file);
  if (tempDirectory) fs.rmdirSync(tempDirectory);
}

for (const [english, chinese] of addedEntries) {
  const oldBundles = [...oldByBundle].filter(([, old]) => old.decoded.includes(english)).map(([bundle]) => bundle);
  report.additions.push({
    ...annotations.get(english), english, chinese, classification: 'current-gap',
    evidence: currentEvidence.get(english) ?? annotations.get(english)?.evidence ?? [],
    comparison: baselineRecord ? (oldBundles.length ? 'present-in-baseline' : 'absent-from-comparable-baseline-bundles') : 'no-bundle-baseline',
    oldBundles,
    currentRewriteHits: report.bundles.reduce((n, b) => n + (b.addedKeyHits[english] ?? 0), 0)
  });
}
const absent = report.additions.filter((row) => baselineRecord && row.oldBundles.length === 0);
report.summary.knownAbsentFrom3259 = baselineRecord?.cursorVersion === '3.25.9' ? absent.length : undefined;
report.comparison = {
  from: baselineRecord?.cursorVersion ?? null, to: report.cursorVersion,
  exact32616DeltaAvailable: false,
  method: 'Decoded literal-text presence in all three full, hash-verified baseline bundles. UI context is reviewed only for the additions listed here.',
  provenLiteralAdditionsAmongReviewedGaps: absent.map((row) => row.english),
  preexistingGaps: report.additions.filter((row) => row.oldBundles.length > 0).map((row) => row.english),
  noLongerMatchedDictionaryKeys: [...allOldHits].filter((key) => !allCurrentHits.has(key)).map((english) => ({
    english, chinese: after[english], translationRetained: true,
    literalStillPresentInCurrent: [...currentSources.values()].some((current) => current.decoded.includes(english))
  }))
};
report.comparison.provenLiteralRemovalsAmongDictionary = report.comparison.noLongerMatchedDictionaryKeys.filter((row) => !row.literalStillPresentInCurrent).map((row) => row.english);
report.validation.addedKeysWithNoRewriteHits = report.additions.filter((row) => row.currentRewriteHits === 0).map((row) => row.english);
for (const { file, hash } of currentSources.values()) if (sha256(fs.readFileSync(file)) !== hash) report.validation.sourceHashesUnchanged = false;
if (sha256(fs.readFileSync(dictFile)) !== report.validation.dictionarySha256) throw new Error('Dictionary changed during audit; rerun.');
report.validation.rewriteScriptStableDuringAudit = sha256(fs.readFileSync(scriptFile)) === report.validation.rewriteScriptSha256;
if (!report.validation.rewriteScriptStableDuringAudit) report.status = 'review-complete-rerun-validation-after-rule-edits';
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: reportFile, summary: report.summary, knownLiteralAdditions: absent.length, retainedRemovedKeys: report.comparison.provenLiteralRemovalsAmongDictionary.length }));
if (!report.validation.rewriteScriptStableDuringAudit || !report.validation.sourceHashesUnchanged || !report.validation.existingEntriesPreserved || report.validation.addedKeysWithNoRewriteHits.length || report.validation.syntax.some((row) => !row.passed)) process.exitCode = 1;
