#!/usr/bin/env node
// A PR that changes code of apps, services or packages must change docs/ or carry the label «без-документов» with a reason (spec 10).
// Usage: node scripts/std/docs-required.mjs --base <ref> [--head HEAD] --event <GITHUB_EVENT_PATH>
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { diffAgainst, fail, isMain, isTestFile, LABEL_NO_DOCS } from './common.mjs';

const CODE_DIRS = /^(?:apps|services|packages)\//;
const CODE_EXT = /\.(?:go|py|[cm]?[jt]sx?|sql|css|scss|vue|svelte|rs|java|kt)$/;
const GENERATED = /(?:^|\/)generated\/|\.gen\.[a-z]+$|\.generated\./;
const REASON = /^[>*#\s-]*без[ -]документов[^\S\n]*[:—–-][^\S\n]*\S.{4,}$/im;

const isCode = path => CODE_DIRS.test(path) && CODE_EXT.test(path) && !isTestFile(path) && !GENERATED.test(path);

/** @returns {{ ok: boolean, reason: string }} */
export function check({ files, labels, body }) {
  const code = files.filter(f => isCode(f.path));
  if (code.length === 0) return { ok: true, reason: 'код приложений и сервисов не менялся' };
  if (files.some(f => f.path.startsWith('docs/'))) return { ok: true, reason: 'документы обновлены' };
  if (!labels.includes(LABEL_NO_DOCS)) {
    return { ok: false, reason: `PR меняет код (${code[0].path} и др.), но не меняет docs/: обновите документы либо поставьте метку «${LABEL_NO_DOCS}» и напишите причину в описании PR` };
  }
  if (!REASON.test(body ?? '')) {
    return { ok: false, reason: `метка «${LABEL_NO_DOCS}» требует обоснования: добавьте в описание PR строку «Без документов: <причина>»` };
  }
  return { ok: true, reason: `метка «${LABEL_NO_DOCS}» с обоснованием` };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { base: { type: 'string' }, head: { type: 'string', default: 'HEAD' }, event: { type: 'string' } } });
  if (!values.base) throw new Error('нужен --base <ветка или коммит>');
  const pr = values.event ? JSON.parse(readFileSync(values.event, 'utf8')).pull_request ?? {} : {};
  const result = check({ files: diffAgainst(values.base, values.head), labels: (pr.labels ?? []).map(l => l.name), body: pr.body ?? '' });
  if (result.ok) console.log(`Документы: ${result.reason}`);
  else fail([`Документы: ${result.reason}`]);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
