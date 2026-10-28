#!/usr/bin/env node
// Completeness of the document kit for handoff (spec 10, std-handoff, checkpoint 5).
// Usage: node scripts/std/handoff-complete.mjs [--root .]
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fail, isMain, profileRows, readText } from './common.mjs';

const MIN_CHARS = 200;
const PLACEHOLDER = /\b(?:TODO|TBD|FIXME)\b|ЗАПОЛНИТЬ|ЗАПОЛНИТЕ|Образец:/;
const MERMAID = /^```mermaid\s*$/gm;

// path, minimum number of Mermaid diagrams, whether the file is formed automatically (then it is not read for prose)
function required(profile) {
  const docs = [
    ['README.md', 0], ['ARCHITECTURE.md', 1], ['CHANGELOG.md', 0, { short: true }],
    ['docs/overview.md', 2], ['docs/decisions.md', 0, { pattern: /Р-\d+/, short: true }],
    ['docs/glossary.md', 0, { rows: 1, short: true }],
    ['docs/ops/deployment.md', 1], ['docs/ops/configuration.md', 0], ['docs/ops/operations.md', 0],
    ['docs/dev/testing.md', 0], ['docs/dev/security.md', 1], ['docs/dev/tech-debt.md', 0],
    ['docs/dev/licenses.md', 0], ['docs/dev/sbom.json', 0, { short: true }],
  ];
  if (profile('интерфейс')) docs.push(['docs/user/user-guide.md', 1], ['docs/user/faq.md', 0]);
  if (profile('роли пользователей')) docs.push(['docs/user/admin-guide.md', 0]);
  if (profile('api')) docs.push(['docs/dev/api.md', 0]);
  if (profile('база данных')) docs.push(['docs/dev/database.md', 1]);
  return docs;
}

function list(root, dir, re) {
  try { return readdirSync(join(root, dir)).filter(n => re.test(n)); } catch { return []; }
}

/** @returns {{ ok: boolean, problems: string[] }} */
export function check({ root = '.' }) {
  const rows = profileRows(readText(join(root, 'AGENTS.md')) ?? '');
  const on = key => rows.get(key) === 'да';
  const problems = [];
  for (const [path, diagrams, options = {}] of required(on)) {
    const text = readText(join(root, path));
    if (text === null) { problems.push(`${path}: файла нет`); continue; }
    if (options.pattern && !options.pattern.test(text)) { problems.push(`${path}: нет записей`); continue; }
    if (options.rows) {
      const dataRows = text.split('\n').filter(l => l.startsWith('|') && !/^\|[\s:|-]+\|?$/.test(l)).length - 1;
      if (dataRows < options.rows) { problems.push(`${path}: таблица пуста`); continue; }
    }
    if (!options.short && text.replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim().length < MIN_CHARS) problems.push(`${path}: пуст или слишком мало текста`);
    if (PLACEHOLDER.test(text)) problems.push(`${path}: остался заполнитель (${PLACEHOLDER.exec(text)[0]})`);
    const found = (text.match(MERMAID) ?? []).length;
    if (found < diagrams) problems.push(`${path}: нужна схема Mermaid (есть ${found}, нужно ${diagrams})`);
  }
  if (list(root, 'docs/releases', /^v.+\.md$/).length === 0) problems.push('docs/releases/: нет заметок к выпуску (vN.md)');
  if (list(root, 'docs/reports', /^acceptance-.+\.md$/).length === 0) problems.push('docs/reports/: нет протокола приёмки (acceptance-vN.md)');
  return { ok: problems.length === 0, problems };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { root: { type: 'string', default: '.' } } });
  const result = check({ root: values.root });
  if (result.ok) console.log('Комплект документов для передачи полон');
  else fail([`Комплект документов для передачи неполон (${result.problems.length}):`, ...result.problems.map(p => `  ${p}`)]);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
