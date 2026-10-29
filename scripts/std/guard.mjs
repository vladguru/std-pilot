#!/usr/bin/env node
// Protection of restrictors (spec 7): a PR must not delete or skip tests, lower thresholds, add linter suppressions
// without a reason or change CI and linter settings unless the owner approved it.
// Usage: node scripts/std/guard.mjs --base <ref> [--head HEAD] [--approved | --report]
import { parseArgs } from 'node:util';
import { diffAgainst, fail, isMain, isTestFile, RESTRICTOR_PATHS } from './common.mjs';

const TEST_DEFINITIONS = [
  { re: /^\s*func\s+((?:Test|Benchmark|Fuzz|Example)\w*)\s*\(/, group: 1 },
  { re: /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/, group: 1 },
  { re: /\b(?:it|test)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1).)+)\1/, group: 2 },
];

const SKIPS = [
  /\bt\.Skip(?:f|Now)?\(/,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
  /\bpytest\.(?:skip|xfail)\(/,
  /@unittest\.skip/,
  /\b(?:it|test|describe|suite)\.(?:skip|todo|fixme)\b/,
  /\b(?:xit|xtest|xdescribe)\(/,
  /\.only\(/,
  /\.(?:skipIf|runIf)\(/,
  /\bpytestmark\s*=.*\bskip/,
  /^\s*\/\/\s*go:build\s+ignore/,
];
const QUARANTINE = /(?:карантин|quarantine)\s*#\d+/i;

// lowerIsWeaker: false means a larger value is the weaker one.
const THRESHOLDS = [
  { re: /(?<!cov-)fail[_-]under["']?\s*[=:]\s*["']?(\d+(?:\.\d+)?)/gi, id: () => 'fail_under', value: 1 },
  { re: /--cov-fail-under[= ]\s*(\d+(?:\.\d+)?)/g, id: () => '--cov-fail-under', value: 1 },
  { re: /\b((?:COVERAGE|COVER|MUTATION|MUTANT)_(?:MIN|THRESHOLD)[A-Z_]*)\s*[:?+]?=\s*(\d+(?:\.\d+)?)/g, id: m => m[1], value: 2 },
  { re: /--max-warnings[= ]\s*(\d+)/g, id: () => '--max-warnings', value: 1, lowerIsWeaker: false },
  { re: /--threshold-(efficacy|mcover)[= ]\s*(\d+(?:\.\d+)?)/g, id: m => `threshold-${m[1]}`, value: 2 },
  { re: /"minScore"\s*:\s*(\d+(?:\.\d+)?)/g, id: () => 'minScore', value: 1 },
  { re: /\bbreak["']?\s*:\s*(\d+(?:\.\d+)?)/g, id: () => 'stryker-break', value: 1, files: /stryker/i },
  { re: /\b(lines|functions|branches|statements)["']?\s*:\s*(\d+(?:\.\d+)?)/g, id: m => `coverage-${m[1]}`, value: 2, files: /(?:vitest|vite|jest)\.config\./ },
];

// A directive and the text after it; a reason follows a separator (-- or — or a second comment) or, for TypeScript directives, the colon.
const SUPPRESSIONS = [
  { re: /\/\/\s*nolint\b/, ts: false },
  { re: /#\s*noqa\b/, ts: false },
  { re: /#\s*type:\s*ignore\b/, ts: false },
  { re: /#\s*pyright:\s*(?:ignore|basic|standard)\b/, ts: false },
  { re: /#\s*ruff:\s*noqa\b/, ts: false },
  { re: /#\s*pylint:\s*disable/, ts: false },
  { re: /eslint-disable(?:-next-line|-line)?\b/, ts: false },
  { re: /@ts-(?:ignore|nocheck|expect-error)\b/, ts: true },
  { re: /(?:#|\/\/)\s*nosec\b/, ts: false },
  { re: /nosemgrep\b/, ts: false },
  { re: /gitleaks:allow\b/, ts: false },
];
const REASON = /(?:^|\s)(?:--|—|\/\/|#)\s*\S{3,}/;
const TS_REASON = /^\s*:?\s*\S{3,}/;

function binaryViolations(files) {
  return files
    .filter(f => f.binary && (isTestFile(f.path) || RESTRICTOR_PATHS.some(re => re.test(f.path))))
    .map(f => ({ kind: 'path', path: f.path, message: `файл тестов или ограничителя изменён как двоичный: ${f.path}` }));
}

export function analyze(files) {
  return [
    ...binaryViolations(files),
    ...restrictorViolations(files),
    ...removedTestViolations(files),
    ...skippedTestViolations(files),
    ...thresholdViolations(files),
    ...suppressionViolations(files),
  ];
}

function restrictorViolations(files) {
  return files
    .filter(f => RESTRICTOR_PATHS.some(re => re.test(f.path) || (f.oldPath && re.test(f.oldPath))))
    .map(f => ({ kind: 'path', path: f.path, message: `изменён ограничитель: ${f.path}` }));
}

function definitions(lines) {
  const names = [];
  for (const { text } of lines) {
    for (const { re, group } of TEST_DEFINITIONS) {
      const m = re.exec(text);
      if (m) { names.push(m[group]); break; }
    }
  }
  return names;
}

// Tests removed from the PR net of tests with the same name added anywhere and of new tests added instead.
function removedTestViolations(files) {
  const testFiles = files.filter(f => isTestFile(f.path) || (f.oldPath && isTestFile(f.oldPath)));
  const added = new Map();
  for (const f of testFiles) for (const n of definitions(f.added)) added.set(n, (added.get(n) ?? 0) + 1);
  const unmatchedRemoved = [];
  for (const f of testFiles) {
    for (const n of definitions(f.removed)) {
      if (added.get(n) > 0) added.set(n, added.get(n) - 1);
      else unmatchedRemoved.push({ name: n, path: f.oldPath ?? f.path });
    }
  }
  const replacements = [...added.values()].reduce((a, b) => a + b, 0);
  const lost = unmatchedRemoved.length - replacements;
  if (lost <= 0) return [];
  const where = [...new Set(unmatchedRemoved.map(r => r.path))];
  return [{ kind: 'test-removed', path: where[0], message: `удалено тестов: ${lost} (${unmatchedRemoved.map(r => r.name).join(', ')}) в ${where.join(', ')}` }];
}

function skippedTestViolations(files) {
  const out = [];
  for (const f of files.filter(f => isTestFile(f.path))) {
    const quarantined = new Set(f.added.filter(a => QUARANTINE.test(a.text)).map(a => a.line));
    for (const a of f.added) {
      if (!SKIPS.some(re => re.test(a.text))) continue;
      if (quarantined.has(a.line) || quarantined.has(a.line - 1)) continue;
      out.push({ kind: 'test-skipped', path: f.path, line: a.line, message: `пропущен тест без карантина с issue («карантин #N»): ${f.path}:${a.line}` });
    }
  }
  return out;
}

function thresholdEntries(lines, rule) {
  const found = [];
  for (const { text } of lines) {
    for (const m of text.matchAll(rule.re)) found.push({ id: rule.id(m), value: Number(m[rule.value]), text: text.trim() });
  }
  return found;
}

function thresholdViolations(files) {
  const out = [];
  for (const f of files) {
    for (const rule of THRESHOLDS) {
      if (rule.files && !rule.files.test(f.path)) continue;
      const added = thresholdEntries(f.added, rule);
      for (const old of thresholdEntries(f.removed, rule)) {
        const i = added.findIndex(a => a.id === old.id);
        const next = i === -1 ? null : added.splice(i, 1)[0];
        const lowerIsWeaker = rule.lowerIsWeaker !== false;
        const weaker = next === null || (lowerIsWeaker ? next.value < old.value : next.value > old.value);
        if (weaker) {
          out.push({ kind: 'threshold', path: f.path, message: `порог ослаблен или удалён в ${f.path}: ${old.id} ${old.value}${next ? ` → ${next.value}` : ' → удалён'}` });
        }
      }
    }
  }
  return out;
}

function suppressionViolations(files) {
  const out = [];
  for (const f of files.filter(f => !/\.(md|txt|rst)$/i.test(f.path))) {
    for (const a of f.added) {
      for (const { re, ts } of SUPPRESSIONS) {
        const m = re.exec(a.text);
        if (!m) continue;
        const tail = a.text.slice(m.index + m[0].length);
        // A second directive in the tail (for example "# type: ignore  # noqa") is not a reason.
        const reasonText = SUPPRESSIONS.some(s => s.re.test(tail)) ? '' : tail;
        if (!(ts ? TS_REASON : REASON).test(reasonText)) {
          out.push({ kind: 'suppression', path: f.path, line: a.line, message: `подавление проверки без причины (добавьте « -- причина»): ${f.path}:${a.line}` });
          break;
        }
      }
    }
  }
  return out;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { base: { type: 'string' }, head: { type: 'string', default: 'HEAD' }, approved: { type: 'boolean' }, report: { type: 'boolean' } } });
  if (!values.base) throw new Error('нужен --base <ветка или коммит>');
  const violations = analyze(diffAgainst(values.base, values.head));
  if (violations.length === 0) {
    console.log('Защита ограничителей: нарушений нет');
    return;
  }
  if (values.report) {
    // CI: the decision is the commit status "std/согласование" (approval.mjs counts the same violations and the owner's approval).
    console.log(`Защита ограничителей: нарушений ${violations.length}; решение — статус std/согласование`);
    violations.forEach(v => console.log(`  ${v.message}`));
    return;
  }
  if (values.approved) {
    console.log(`Защита ограничителей: нарушений ${violations.length}, владелец одобрил PR`);
    violations.forEach(v => console.log(`  ${v.message}`));
    return;
  }
  fail([`Защита ограничителей: нарушений ${violations.length}; нужно одобрение владельца (метка «на-согласовании»).`, ...violations.map(v => `  ${v.message}`)]);
}

if (isMain(import.meta.url)) main(process.argv.slice(2)).catch(err => { console.error(`Ошибка: ${err.message}`); process.exitCode = 1; });
