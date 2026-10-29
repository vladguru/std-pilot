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
  /^\.claude\/hooks\//,
  /^\.claude\/settings(?:\.local)?\.json$/,
  /^\.gitattributes$/,
  /^Makefile$/,
  /^make\/[^/]+\.mk$/,
  /(^|\/)pnpm-workspace\.yaml$/,
  /(^|\/)(?:vitest|jest)\.config\.[cm]?[jt]s$/,
  /(^|\/)playwright\.config\.[cm]?[jt]s$/,
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

// Git writes paths with special characters (quote, backslash, control or non-ASCII bytes) in C-style quotes.
export function unquotePath(raw) {
  if (!(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)) return raw;
  const bytes = [];
  const body = raw.slice(1, -1);
  const simple = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { bytes.push(...Buffer.from(body[i])); continue; }
    const next = body[i + 1];
    if (/[0-7]/.test(next)) { bytes.push(parseInt(body.slice(i + 1, i + 4), 8)); i += 3; } else { bytes.push(simple[next] ?? next.charCodeAt(0)); i += 1; }
  }
  return Buffer.from(bytes).toString('utf8');
}

const stripPrefix = (raw, prefix) => { const p = unquotePath(raw); return p.startsWith(prefix) ? p.slice(prefix.length) : p; };

/**
 * Parses `git diff --unified=0 --find-renames` output. File headers (--- and +++) count only between "diff --git" and
 * the first hunk: inside a hunk a line starting with "++" or "--" is content.
 * @returns {{ path: string, oldPath: string|null, status: 'A'|'M'|'D'|'R', added: {line:number,text:string}[], removed: {line:number,text:string}[] }[]}
 */
export function parseDiff(text) {
  const files = [];
  let file = null;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of normalize(text).split('\n')) {
    if (!inHunk || raw.startsWith('diff --git ')) {
      if (raw.startsWith('diff --git ')) {
        file = { path: '', oldPath: null, status: 'M', added: [], removed: [] };
        files.push(file);
        inHunk = false;
        continue;
      }
    }
    if (!file) continue;
    if (!inHunk) {
      if (raw.startsWith('--- ')) {
        file.oldPath = raw === '--- /dev/null' ? null : stripPrefix(raw.slice(4), 'a/');
      } else if (raw.startsWith('+++ ')) {
        file.path = raw === '+++ /dev/null' ? file.oldPath : stripPrefix(raw.slice(4), 'b/');
        if (raw === '+++ /dev/null') file.status = 'D';
        else if (file.oldPath === null) file.status = 'A';
        else if (file.oldPath !== file.path) file.status = 'R';
      } else if (raw.startsWith('rename from ')) {
        file.oldPath = unquotePath(raw.slice(12));
        file.status = 'R';
      } else if (raw.startsWith('rename to ')) {
        file.path = unquotePath(raw.slice(10));
      } else if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
        file.binary = true;
      }
    }
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
      inHunk = true;
    } else if (inHunk && raw.startsWith('+')) {
      file.added.push({ line: newLine++, text: raw.slice(1) });
    } else if (inHunk && raw.startsWith('-')) {
      file.removed.push({ line: oldLine++, text: raw.slice(1) });
    }
  }
  return files.filter(f => f.path);
}

// Attributes of the PR (.gitattributes: -diff, textconv) must not hide changes: --text forces a text diff of every file.
export function diffAgainst(base, head = 'HEAD', cwd = process.cwd()) {
  const args = ['-c', 'core.quotepath=false', '-c', 'diff.renames=true', 'diff', '--no-color', '--text', '--no-textconv', '--no-ext-diff', '--unified=0', '--find-renames', `${base}...${head}`];
  return parseDiff(git(args, cwd));
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

// IANA name of a time zone ("Europe/Minsk", "UTC"); the shape is checked first so that no free text reaches Intl or a table.
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

export function isTimeZone(value) {
  if (typeof value !== 'string' || !TIME_ZONE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** "7:30" → "07:30"; anything that is not a time of day → null. */
export function normalizeTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/**
 * The row "Ночная смена" of the profile: «сессии в 22:00 и 03:00, утренняя сводка в 07:30, часовой пояс Europe/Minsk».
 * @returns {{ sessions: string[], summaryTime: string|null, tz: string|null }}
 */
export function parseNightShift(agentsMd) {
  const value = profileRows(agentsMd).get('ночная смена') ?? '';
  const summaryAt = value.search(/сводк/i);
  const sessionsPart = summaryAt === -1 ? value : value.slice(0, summaryAt);
  const sessions = [...sessionsPart.matchAll(/(?<![\d:])(\d{1,2}:\d{2})(?![\d:])/g)].map(m => normalizeTime(m[1])).filter(Boolean);
  const summary = summaryAt === -1 ? null : /(?<![\d:])(\d{1,2}:\d{2})(?![\d:])/.exec(value.slice(summaryAt))?.[1];
  const tz = /часовой пояс\s+(\S+)/i.exec(value)?.[1].replace(/[.,;]+$/, '') ?? null;
  return { sessions, summaryTime: summary ? normalizeTime(summary) : null, tz: isTimeZone(tz) ? tz : null };
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function ownerFromAgentsMd(agentsMd) {
  const value = profileRows(agentsMd).get('учётная запись владельца');
  const login = value?.replace(/^@/, '');
  return login && GITHUB_LOGIN.test(login) ? login : null;
}

/** The account the agent works under (a separate GitHub account); null when the row says «не задана», is empty or is not a login. */
export function agentFromAgentsMd(agentsMd) {
  const value = profileRows(agentsMd).get('учётная запись агента');
  const login = value?.replace(/^@/, '');
  return login && GITHUB_LOGIN.test(login) ? login : null;
}

export function fail(lines) {
  for (const line of lines) console.error(line);
  process.exitCode = 1;
}
