#!/usr/bin/env node
// Traceability AC → test (spec 7). Fails when an agreed AC of SPEC.md has no test that names it.
// Usage: node scripts/std/ac-trace.mjs [--root .] [--json] [--protocol <file> --version vN --date ДД.ММ.ГГГГ] [--regenerate-protocols]
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fail, isMain, isTestFile, MARKER, readText, walk } from './common.mjs';

const PROTOCOL_HEADER = /^<!-- ac-trace: version=(\S+) date=(\S+) -->$/m;

export function parseSpec(specMd) {
  const text = specMd.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const status = /^Статус:\s*(.+)$/m.exec(text)?.[1] ?? '';
  const agreed = /согласовано\s+(\d{2}\.\d{2}\.\d{4})/i.exec(status);
  const criteria = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const heading = /^###\s+(AC-\d+)\.?\s*(.*)$/.exec(lines[i]);
    if (!heading) continue;
    let requirement = '—';
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('#'); j++) {
      const m = /^Требование:\s*(.+?)\.?\s*$/.exec(lines[j]);
      if (m) { requirement = m[1]; break; }
    }
    criteria.push({ id: heading[1], requirement, title: heading[2].trim() });
  }
  return { status: { agreed: Boolean(agreed), date: agreed ? agreed[1] : null }, criteria };
}

// Identifier with the number in any spelling: AC-01, AC_01, AC01, TestAC01_x, test_ac_01; the number is compared as a value.
const AC_MENTION = /(?:(?<![A-Za-z0-9])|(?<=Test)|(?<=test_)|(?<=test))AC[-_ ]?(\d+)(?!\d)/gi;

/** Lines of files that name the criterion: AC-1 and AC-01 are one criterion, AC-1 is not AC-12. */
export function findTests(files, id) {
  const number = Number(/\d+/.exec(id)[0]);
  const found = [];
  for (const file of files) {
    file.text.split('\n').forEach((line, i) => {
      if ([...line.matchAll(AC_MENTION)].some(m => Number(m[1]) === number)) found.push({ path: file.path, line: i + 1 });
    });
  }
  return found;
}

export function trace(root) {
  const spec = parseSpec(readText(join(root, 'SPEC.md')) ?? '');
  const files = walk(root).filter(isTestFile).map(path => ({ path, text: readText(join(root, path)) ?? '' }));
  const rows = spec.criteria.map(c => ({ ac: c.id, requirement: c.requirement, title: c.title, tests: findTests(files, c.id) }));
  return { agreed: spec.status.agreed, date: spec.status.date, rows };
}

export function renderProtocol(result, { version, date }) {
  const out = [
    MARKER,
    `<!-- ac-trace: version=${version} date=${date} -->`,
    '',
    `# Протокол приёмки ${version}`,
    '',
    `Дата: ${date}. Источник: трассировка «требование → AC → тест» (\`scripts/std/ac-trace.mjs\`). Результат прогона тестов — зелёный CI на теге версии.`,
    '',
    '| Требование | AC | Тесты | Результат | Дата |',
    '|---|---|---|---|---|',
  ];
  for (const row of result.rows) {
    const paths = [...new Set(row.tests.map(t => t.path))].sort();
    out.push(`| ${row.requirement} | ${row.ac} | ${paths.length ? paths.map(p => `\`${p}\``).join(', ') : '—'} | ${paths.length ? 'есть тест' : 'нет теста'} | ${date} |`);
  }
  const missing = result.rows.filter(r => r.tests.length === 0);
  out.push('', '## Критерии без теста', '');
  out.push(...(missing.length ? missing.map(r => `- ${r.ac}. ${r.title}`) : ['Нет.']));
  return `${out.join('\n')}\n`;
}

function regenerate(root, result) {
  const dir = join(root, 'docs/reports');
  let names = [];
  try { names = readdirSync(dir).filter(n => /^acceptance-.*\.md$/.test(n)); } catch { /* no reports yet */ }
  for (const name of names) {
    const m = PROTOCOL_HEADER.exec(readText(join(dir, name)) ?? '');
    if (m) writeFileSync(join(dir, name), renderProtocol(result, { version: m[1], date: m[2] }));
  }
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { root: { type: 'string', default: '.' }, json: { type: 'boolean' }, protocol: { type: 'string' }, version: { type: 'string' }, date: { type: 'string' }, 'regenerate-protocols': { type: 'boolean' } },
  });
  const result = trace(values.root);
  if (values.protocol) {
    if (!values.version || !values.date) throw new Error('для --protocol нужны --version и --date');
    const target = join(values.root, values.protocol);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderProtocol(result, { version: values.version, date: values.date }));
  }
  if (values['regenerate-protocols']) regenerate(values.root, result);
  if (values.json) console.log(JSON.stringify(result, null, 2));
  const missing = result.rows.filter(r => r.tests.length === 0);
  if (!result.agreed) {
    console.log(`SPEC.md не согласовано: проверка трассировки пропущена (критериев: ${result.rows.length})`);
    return;
  }
  if (missing.length > 0) {
    fail([`Согласованные критерии без теста (${missing.length}):`, ...missing.map(r => `  ${r.ac}. ${r.title}`), 'Напишите тест с идентификатором критерия в имени или комментарии.']);
    return;
  }
  console.log(`Трассировка AC → тест: критериев ${result.rows.length}, у всех есть тест`);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
