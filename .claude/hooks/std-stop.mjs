// Хук Claude Code Stop (стандарт агента, файл принадлежит стандарту): перед завершением хода запускает быструю проверку
// `make check-std`, если такая цель есть и в рабочем дереве есть изменённые файлы. При ошибке — код 2 и краткая причина:
// агент исправляет и завершает ход снова. Повторный запуск в том же ходе (stop_hook_active) всегда пропускается,
// поэтому цикла нет. Зависшая проверка (2 минуты) агента не держит. Самодостаточный файл.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const CHECK_TIMEOUT_MS = 120000;
const MAX_MESSAGE = 1500;

// ---- доверие к коду ветки ----------------------------------------------------------------------------------------------
// Хук запускает make, а Makefile лежит в ветке, которую правит агент. Поэтому запуск разрешён, только если среда
// доверенная: облако (CLAUDE_CODE_REMOTE), репозиторий без удалённого origin либо ограничители (Makefile, make/,
// .mise.toml, scripts/std, package.json, pnpm-workspace.yaml, .claude) не отличаются от origin/main.
const GUARDED_PATHS = ['Makefile', 'make', '.mise.toml', 'scripts/std', 'package.json', 'pnpm-workspace.yaml', '.claude'];
const GIT_OPTIONS = { encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } };

export function isTrusted({ cwd, env = process.env }) {
  if (env.CLAUDE_CODE_REMOTE) return true;
  const git = args => spawnSync('git', args, { cwd, ...GIT_OPTIONS });
  const origin = git(['config', '--get', 'remote.origin.url']);
  if (origin.error) return false;
  if (origin.status === 1) return true; // удалённого origin нет
  if (origin.status === 128 && /not a git repository/i.test(origin.stderr ?? '')) return true; // это не репозиторий
  if (origin.status !== 0) return false;
  if (git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']).status !== 0) return false;
  if (git(['diff', '--quiet', '--no-ext-diff', '--no-textconv', 'refs/remotes/origin/main', '--', ...GUARDED_PATHS]).status !== 0) return false;
  // Новый файл (например, make/evil.mk) подхватывается Makefile, а git diff его не видит.
  const fresh = git(['ls-files', '--others', '--exclude-standard', '--', ...GUARDED_PATHS, ':(exclude).claude/settings.local.json']);
  return fresh.status === 0 && (fresh.stdout ?? '').trim() === '';
}

function hasTarget(cwd) {
  try {
    return readFileSync(join(cwd, 'Makefile'), 'utf8').split('\n').some(line => line.startsWith('check-std:'));
  } catch {
    return false;
  }
}

// Пути из `git status --porcelain -z`: «XY путь\0», у переименования следом идёт прежний путь.
function changedFiles(cwd, run) {
  const r = run('git', ['-c', 'core.quotepath=off', 'status', '--porcelain', '-z'], { cwd, encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return [];
  const parts = r.stdout.split('\0').filter(Boolean);
  const files = [];
  for (let k = 0; k < parts.length; k++) {
    const entry = parts[k];
    files.push(entry.slice(3));
    if (/^[RC]/.test(entry)) k++; // прежний путь переименования не проверяется
  }
  return files;
}

function tail(text) {
  const clean = text.replace(/\r/g, '').trim();
  return clean.length > MAX_MESSAGE ? `…${clean.slice(-MAX_MESSAGE)}` : clean;
}

/** @returns {{ block: boolean, message?: string }} */
export function runStop({ input, cwd, spawnSync: run = spawnSync, env = process.env }) {
  if (input?.stop_hook_active === true) return { block: false };
  if (!hasTarget(cwd)) return { block: false };
  const files = changedFiles(cwd, run);
  if (files.length === 0) return { block: false };
  if (!isTrusted({ cwd, env })) {
    return { block: false, skipped: 'std-stop: make check-std пропущен: ограничители (Makefile, make/, scripts/std, .claude и другие) отличаются от origin/main либо origin/main недоступен, код ветки не считается доверенным. Проверьте изменения и запустите make check-std вручную.' };
  }
  const result = run('make', ['check-std'], {
    cwd,
    encoding: 'utf8',
    timeout: CHECK_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, STD_CHANGED_FILES: files.join('\n') },
  });
  if (result.error || result.status === 0 || result.status === null) return { block: false };
  const output = tail(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  return { block: true, message: `std-stop: make check-std завершился с ошибкой (код ${result.status}). Исправьте замечания и завершите работу снова.${output ? `\n${output}` : ''}` };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''));
  } catch {
    return 0;
  }
  if (typeof input !== 'object' || input === null) return 0;
  const cwd = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === 'string' && input.cwd) || process.cwd();
  const result = runStop({ input, cwd });
  if (!result.block) {
    if (result.skipped) process.stderr.write(`${result.skipped}\n`); // не блокирует: код выхода 0
    return 0;
  }
  process.stderr.write(`${result.message}\n`);
  return 2;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exitCode = main();
  } catch {
    process.exitCode = 0;
  }
}
