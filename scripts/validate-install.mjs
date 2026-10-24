#!/usr/bin/env node
/** Check the actual application bundles without writing to the application. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { rewrite } from './translate-install.mjs';
import { rewriteCommerce } from './lib/commerce-i18n.mjs';
import { findCursorInstall, readCursorInfo } from './lib/cursor-paths.mjs';
import { p, readJson, writeJson, loadConfig } from './lib/util.mjs';

const found = findCursorInstall();
if (!found) throw new Error('Cursor not found. Set CURSOR_INSTALL_DIR to the application directory.');
const info = readCursorInfo(found.appRoot);
const config = loadConfig();
const files = ['workbench.desktop.main.js', 'workbench.glass.main.js',
  'workbench.anysphere-ui-automations.js', 'workbench.xai-commerce-prepaid.js'];
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const dict = (locale, filename) => Object.fromEntries(Object.entries(readJson(p('src', 'i18n', locale, filename)))
  .filter(([key, value]) => !key.startsWith('$') && typeof value === 'string' && value !== key));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-translation-validation-'));
const results = [];
try {
  for (const locale of config.locales.filter((item) => item.enabled !== false)) {
    const hardcoded = dict(locale.id, 'hardcoded.json');
    const commerce = dict(locale.id, 'commerce.json');
    for (const name of files) {
      const file = path.join(found.appRoot, 'out', 'vs', 'workbench', name);
      if (!fs.existsSync(file)) continue;
      const source = fs.readFileSync(file, 'utf8');
      const before = hash(source);
      const result = name === 'workbench.xai-commerce-prepaid.js' ? rewriteCommerce(source, commerce) : rewrite(source, hardcoded);
      const output = path.join(temporary, `${locale.id}-${name}.mjs`);
      fs.writeFileSync(output, result.text);
      const check = spawnSync(process.execPath, ['--check', output], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      if (check.error || check.status !== 0) throw new Error(`${locale.id} ${name}: ${check.error?.message ?? check.stderr}`);
      if (hash(fs.readFileSync(file, 'utf8')) !== before) throw new Error(`Application changed during validation: ${file}`);
      results.push({ locale: locale.id, bundle: name, replacements: result.count, matchedEntries: result.hits.size,
        hitCounts: Object.fromEntries(result.hits), originalSha256: before, rewrittenSha256: hash(result.text),
        syntax: 'passed', applicationUnchanged: true });
      console.log(`${locale.id} ${name}: ${result.count} entries/replacements, syntax passed, application unchanged`);
      fs.rmSync(output);
    }
  }
  const version = String(info.cursorVersion ?? 'unknown').replace(/[^\w.-]/g, '_');
  writeJson(p('reports', `translation-bundles-${version}.json`), {
    generatedAt: new Date().toISOString(), cursorVersion: info.cursorVersion, commit: info.commit,
    node: process.version, installRoot: found.installRoot, applicationWrites: false, results
  });
} finally {
  if (path.dirname(temporary) !== path.resolve(os.tmpdir())) throw new Error('Unexpected validation directory');
  fs.rmSync(temporary, { recursive: true, force: true });
}
