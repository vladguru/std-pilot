// Shared helpers of the CI checks. Installed into projects as scripts/std/ — no imports outside this directory.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARKER = 'Файл формируется автоматически, не редактировать';
export const LABEL_APPROVAL = 'на-согласовании';
export const LABEL_NO_DOCS = 'без-документов';
export const AGENT_MARK = '<!-- agent -->';
/** Files whose change weakens control unless the owner agrees (AGENTS.md of the project, spec 0 "Ограничитель"). */
export const RESTRICTOR_PATHS = [
  /^\.github\//,
  /^AGENTS\.md$/,
  /^scripts\/std\//,
  /^lefthook\.yml$/,
  /^renovate\.json$/,
  /^\.vale\.ini$/,
  /^\.vale\/styles\/Std\//,
  /^\.lychee\.toml$/,
  /(^|\/)\.golangci\.ya?ml$/,
  /(^|\/)\.?ruff\.toml$/,
  /(^|\/)pyrightconfig\.json$/,
  /(^|\/)eslint\.config\.[cm]?[jt]s$/,
];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', '.venv', '.next', 'dist', 'build', '.agents', '.claude', '.superpowers', '.serena']);

/** True when `metaUrl` is the module started from the command line. */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === metaUrl;
}

export function normalize(text) {
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

export function readText(path) {
  try {
    return normalize(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Relative paths ("/") of all files under root except service directories. */
export function walk(root, dir = '') {
  const files = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...walk(root, `${dir}${entry.name}/`));
    } else files.push(`${dir}${entry.name}`);
  }
  return files.sort();
}

const TEST_FILE = [
  /_test\.go$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.py$/,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)(tests?|__tests__)\//,
];

export function isTestFile(path) {
  return TEST_FILE.some(re => re.test(path));
}

/**
 * Parses `git diff --unified=0 --find-renames` output.
 * @returns {{ path: string, oldPath: string|null, status: 'A'|'M'|'D'|'R', added: {line:number,text:string}[], removed: {line:number,text:string}[] }[]}
 */
export function parseDiff(text) {
  const files = [];
  let file = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of normalize(text).split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = { path: '', oldPath: null, status: 'M', added: [], removed: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('--- ')) {
      file.oldPath = raw === '--- /dev/null' ? null : raw.slice(4).replace(/^a\//, '');
    } else if (raw.startsWith('+++ ')) {
      file.path = raw === '+++ /dev/null' ? file.oldPath : raw.slice(4).replace(/^b\//, '');
      if (raw === '+++ /dev/null') file.status = 'D';
      else if (file.oldPath === null) file.status = 'A';
      else if (file.oldPath !== file.path) file.status = 'R';
    } else if (raw.startsWith('rename from ')) {
      file.oldPath = raw.slice(12);
      file.status = 'R';
    } else if (raw.startsWith('rename to ')) {
      file.path = raw.slice(10);
    } else if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
    } else if (raw.startsWith('+')) {
      file.added.push({ line: newLine++, text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      file.removed.push({ line: oldLine++, text: raw.slice(1) });
    }
  }
  return files.filter(f => f.path);
}

export function diffAgainst(base, head = 'HEAD', cwd = process.cwd()) {
  return parseDiff(git(['-c', 'core.quotepath=false', 'diff', '--no-color', '--unified=0', '--find-renames', '--no-ext-diff', `${base}...${head}`], cwd));
}

/** Table rows of "## Профиль" of AGENTS.md as Map(lower-cased parameter → value). */
export function profileRows(agentsMd) {
  const rows = new Map();
  const lines = normalize(agentsMd).split('\n');
  const start = lines.findIndex(l => /^##\s+Профиль\s*$/.test(l));
  if (start === -1) return rows;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim().replace(/^`|`$/g, '').trim());
    if (cells.length < 2 || /^:?-+:?$/.test(cells[0])) continue;
    rows.set(cells[0].toLowerCase(), cells[1]);
  }
  return rows;
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function ownerFromAgentsMd(agentsMd) {
  const value = profileRows(agentsMd).get('учётная запись владельца');
  const login = value?.replace(/^@/, '');
  return login && GITHUB_LOGIN.test(login) ? login : null;
}

export function fail(lines) {
  for (const line of lines) console.error(line);
  process.exitCode = 1;
}
