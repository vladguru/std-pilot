#!/usr/bin/env node
// Documents formed automatically must not be edited by hand (spec 3, 10): they start with the marker line and equal
// the result of regeneration (`make docs-generate`).
// Usage: node scripts/std/generated-docs.mjs [--root .] [--base <ref>] [--command "<команда>"]
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { diffAgainst, fail, isMain, MARKER, readText, walk } from './common.mjs';

const KNOWN = [
  /^docs\/ops\/configuration\.md$/,
  /^docs\/dev\/api\.md$/,
  /^docs\/dev\/database\.md$/,
  /^docs\/dev\/licenses\.md$/,
  /^docs\/reports\/acceptance-[^/]+\.md$/,
];
const firstLine = text => text.split('\n').find(l => l.trim() !== '')?.trim() ?? '';
const hash = text => createHash('sha256').update(text).digest('hex');

function docs(root) {
  return walk(root).filter(p => p.startsWith('docs/') && p.endsWith('.md')).map(path => ({ path, text: readText(join(root, path)) ?? '' }));
}

/** @returns {{ ok: boolean, problems: string[], generated: string[] }} */
export function check({ root = '.', base, head = 'HEAD', command }) {
  const problems = [];
  const all = docs(root);
  const generated = all.filter(d => firstLine(d.text) === MARKER).map(d => d.path);
  for (const d of all) {
    if (KNOWN.some(re => re.test(d.path)) && firstLine(d.text) !== MARKER) {
      problems.push(`${d.path}: формируется автоматически, но нет маркера первой строкой («${MARKER}»)`);
    }
  }
  if (base) {
    for (const f of diffAgainst(base, head, root)) {
      if (f.path.startsWith('docs/') && f.removed.some(l => l.text.trim() === MARKER) && !f.added.some(l => l.text.trim() === MARKER)) {
        problems.push(`${f.path}: удалён маркер автоматически формируемого файла`);
      }
    }
  }
  if (generated.length > 0) {
    const cmd = command ?? ((readText(join(root, 'Makefile')) ?? '').match(/^docs-generate\s*:/m) ? 'make docs-generate' : null);
    if (cmd === null) {
      problems.push(`есть автоматически формируемые файлы (${generated.join(', ')}), но нет цели docs-generate в Makefile: нечем проверить их повторным формированием`);
    } else {
      const before = new Map(generated.map(p => [p, hash(readText(join(root, p)) ?? '')]));
      const run = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8' });
      if (run.status !== 0) problems.push(`команда «${cmd}» завершилась с кодом ${run.status}: ${(run.stderr || run.stdout).trim().slice(0, 300)}`);
      else {
        for (const p of generated) {
          if (hash(readText(join(root, p)) ?? '') !== before.get(p)) {
            problems.push(`${p}: не совпадает с результатом повторного формирования (правился вручную или устарел); не редактируйте файл — меняйте источник и выполните «${cmd}»`);
          }
        }
      }
    }
  }
  return { ok: problems.length === 0, problems, generated };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { root: { type: 'string', default: '.' }, base: { type: 'string' }, command: { type: 'string' } } });
  const result = check({ root: values.root, base: values.base, command: values.command });
  if (result.ok) console.log(`Автоматически формируемые документы: расхождений нет (файлов: ${result.generated.length})`);
  else fail(['Автоматически формируемые документы:', ...result.problems.map(p => `  ${p}`)]);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
