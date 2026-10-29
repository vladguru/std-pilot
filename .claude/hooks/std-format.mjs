// Хук Claude Code PostToolUse (стандарт агента, файл принадлежит стандарту): форматирует файл, который агент
// только что изменил, — gofmt для Go, ruff format для Python, prettier для веб-файлов. Программа должна быть найдена;
// ошибки форматирования никогда не блокируют работу (код выхода всегда 0). Самодостаточный файл.
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const PRETTIER_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.html', '.vue']);
const PRETTIER_CONFIGS = [
  '.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.json5', '.prettierrc.toml',
  '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts',
];
const WINDOWS = process.platform === 'win32';
const SHIM = /.(cmd|bat)$/i;

// ---- доверие к коду ветки ----------------------------------------------------------------------------------------------
// Хук запускает prettier проекта, а его код и настройки лежат в ветке, которую правит агент. Поэтому запуск разрешён, только если среда
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

/** Путь к программе из PATH либо null. */
export function which(name, env = process.env) {
  const extensions = WINDOWS ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Точка входа prettier в каталоге установки (node_modules/prettier): его запускает node, без оболочки и без обёрток .cmd.
const PRETTIER_ENTRIES = ['bin/prettier.cjs', 'bin-prettier.js', 'bin/prettier.js'];

function prettierEntry(packageDir, exists) {
  const entry = PRETTIER_ENTRIES.map(name => join(packageDir, ...name.split('/'))).find(path => exists(path));
  return entry === undefined ? null : entry;
}

/**
 * Что запустить для файла: { command, args } либо null, если форматировать нечем или незачем.
 * prettier запускается, только если он установлен в проекте или в проекте есть его настройки:
 * иначе он переформатировал бы код по своим умолчаниям. Оболочка нигде не используется: prettier запускается
 * через node по его JS-файлу, а программа из PATH с расширением .cmd или .bat не запускается вовсе.
 */
export function planFormat(file, { projectDir, which: find = which, exists = existsSync }) {
  const ext = extname(file).toLowerCase();
  if (ext === '.go') {
    const command = find('gofmt');
    return command ? { command, args: ['-w', file] } : null;
  }
  if (ext === '.py') {
    const command = find('ruff');
    return command ? { command, args: ['format', file] } : null;
  }
  if (!PRETTIER_EXTENSIONS.has(ext)) return null;
  const local = prettierEntry(join(projectDir, 'node_modules', 'prettier'), exists);
  if (local !== null) return { command: process.execPath, args: [local, '--write', file] };
  if (!PRETTIER_CONFIGS.some(name => exists(join(projectDir, name)))) return null;
  const command = find('prettier');
  if (!command) return null;
  if (!SHIM.test(command)) return { command, args: ['--write', file] };
  // npm кладёт рядом с обёрткой prettier.cmd каталог node_modules/prettier: берём его JS-файл.
  const entry = prettierEntry(join(dirname(command), 'node_modules', 'prettier'), exists);
  return entry === null ? null : { command: process.execPath, args: [entry, '--write', file] };
}

function run({ command, args }, cwd) {
  if (SHIM.test(command)) return; // обёртку .cmd или .bat можно запустить только через оболочку: не запускаем
  spawnSync(command, args, { cwd, stdio: 'ignore', timeout: 30000, windowsHide: true });
}

function main(env = process.env) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''));
  } catch {
    return;
  }
  if (typeof input !== 'object' || input === null || !TOOLS.has(input.tool_name)) return;
  const file = input.tool_input?.file_path;
  if (typeof file !== 'string' || file === '' || !existsSync(file)) return;
  const projectDir = env.CLAUDE_PROJECT_DIR || (typeof input.cwd === 'string' && input.cwd) || process.cwd();
  const plan = planFormat(file, { projectDir });
  if (plan === null) return;
  if (PRETTIER_EXTENSIONS.has(extname(file).toLowerCase()) && !isTrusted({ cwd: projectDir, env })) {
    process.stderr.write('std-format: prettier пропущен: ограничители (Makefile, make/, scripts/std, .claude и другие) отличаются от origin/main либо origin/main недоступен, код ветки не считается доверенным.\n');
    return;
  }
  run(plan, projectDir);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch {
    // форматирование — удобство, а не проверка: любой сбой игнорируется
  }
  process.exitCode = 0;
}
