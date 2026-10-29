// Хук Claude Code PreToolUse (стандарт агента, файл принадлежит стандарту): блокирует опасные команды оболочки
// и запись в файлы-ограничители. Ввод — JSON со стандартного ввода; код выхода 2 блокирует вызов, причина — в stderr.
//
// Политика: известные опасные формы блокируются, в том числе внутри `;`, `&&`, `||`, `|`, `$(…)`, обратных кавычек,
// `sh -c`, `bash -c`, `eval`, `xargs`, `find -exec`, переменных окружения перед командой и простых присваиваний.
// Если команду нельзя разобрать с уверенностью (динамическое имя команды, чужой язык), она пропускается:
// хук — страховка от ошибок агента, а не изоляция. Самодостаточный файл: импортирует только модули Node.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_DEPTH = 6;
const MAX_LENGTH = 100000;
const PLACEHOLDER = '\u0001'; // место подстановки $(…), значение которой неизвестно

const REASONS = {
  force: 'Принудительная отправка (--force, -f, --force-with-lease, ссылка с «+») переписывает историю. Отправляйте изменения обычным git push в рабочую ветку и открывайте PR.',
  pushMain: 'Прямая отправка в main запрещена. Работайте в ветке и открывайте PR: в main изменения попадают только слиянием после проверок.',
  deleteRef: 'Удаление веток и тегов в удалённом репозитории запрещено (push --delete, :ссылка, --mirror, --prune). Ветки после слияния удаляет GitHub, теги не удаляются.',
  tag: 'Удаление и перемещение тегов запрещено: теги фиксируют выпуски. Нужен другой тег — создайте новый с новым номером.',
  reset: 'git reset --hard к удалённой ветке на main уничтожает локальные коммиты. Создайте ветку от нужного коммита или используйте git merge.',
  branchMain: 'Удаление, переименование и перемещение веток main и master запрещено.',
  history: 'Переписывание истории (filter-branch, filter-repo) запрещено.',
  apiDelete: 'Удаление защиты веток, правил, тегов и самого репозитория через API запрещено. Менять защиту может только владелец.',
  repoDelete: 'Удаление репозитория запрещено. Это решение владельца.',
  pipeShell: 'Выполнение скачанного сценария без просмотра (curl или wget в оболочку, bash -c "$(curl …)") запрещено. Скачайте файл, прочитайте его и запустите отдельно; установку сторонних программ согласуйте с владельцем.',
  token: 'Вывод токенов и секретов запрещён: значение попадёт в журнал и контекст. Используйте переменную внутри команды (например, в заголовке запроса), но не печатайте её.',
  rm: 'Рекурсивное удаление корня, домашнего или системного каталога запрещено. Удаляйте конкретные каталоги проекта (например, node_modules).',
  restrictor: 'Запись в .github/workflows/, scripts/std/, .claude/hooks/ и .claude/settings.json командами оболочки запрещена: это ограничители. Менять их можно только через PR с согласием владельца (метка «на-согласовании»).',
  file: 'Запись в .github/workflows/, scripts/std/, .claude/hooks/ и .claude/settings.json запрещена: это ограничители. Менять их можно только через PR с согласием владельца (метка «на-согласовании»); напомните владельцу об этом в описании PR.',
};

// ---- разбор оболочки -------------------------------------------------------------------------------------------------

/**
 * Разбирает командную строку в плоский список простых команд.
 * Команда: { words, redirs, pipe, pipeIn, heredoc, hereString }; слово: { text, vars, dl, sub, quoted }.
 * Подстановки $(…), `…`, <(…) разбираются рекурсивно: их команды попадают в тот же список.
 * `vars` — имена переменных, раскрываемых оболочкой (в одинарных кавычках и после `\` их нет).
 * `dl` — слово содержит подстановку, в которой что-то скачивается (curl, wget).
 */
export function parseShell(src) {
  const s = src;
  const commands = [];
  const pending = []; // here-документы, ждущие тела
  let i = 0;
  let nextPipe = 0;

  const newCommand = (pipe, pipeIn) => ({ words: [], redirs: [], pipe, pipeIn, heredoc: null, hereString: null });
  const newWord = () => ({ text: '', vars: [], dl: false, sub: false, quoted: false });

  function substitution(word, closer) {
    const before = commands.length;
    parseSeq(closer);
    word.sub = true;
    word.text += PLACEHOLDER;
    if (commands.slice(before).some(c => isDownloader(callOf(c, new Map())))) word.dl = true;
  }

  function readHeredocs() {
    while (pending.length > 0) {
      const h = pending.shift();
      const lines = [];
      while (i < s.length) {
        let end = s.indexOf('\n', i);
        if (end === -1) end = s.length;
        const line = s.slice(i, end).replace(/\r$/, '');
        i = Math.min(end + 1, s.length);
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        lines.push(line);
      }
      h.cmd.heredoc = (h.cmd.heredoc === null ? '' : `${h.cmd.heredoc}\n`) + lines.join('\n');
    }
  }

  // Знак $ внутри слова: подстановка команды, арифметика, переменная.
  function readDollar(word, inDouble) {
    const next = s[i + 1];
    if (next === '(') {
      if (s[i + 2] === '(') { // арифметика: содержимое не команда
        let depth = 0;
        let k = i + 1;
        for (; k < s.length; k++) {
          if (s[k] === '(') depth++;
          else if (s[k] === ')' && --depth === 0) break;
        }
        word.text += s.slice(i, k + 1);
        i = Math.min(k + 1, s.length);
        return;
      }
      i += 2;
      substitution(word, ')');
      return;
    }
    if (next === '{') {
      const m = /^\$\{!?([A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(i, i + 200));
      let close = s.indexOf('}', i);
      if (close === -1) close = s.length - 1;
      word.text += s.slice(i, close + 1);
      if (m) word.vars.push(m[1]);
      i = close + 1;
      return;
    }
    if (next === "'" && !inDouble) { // $'…' — строка с escape-последовательностями, значение не раскрывается
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) word.text += s[i++];
        word.text += s[i++];
      }
      i++;
      word.quoted = true;
      return;
    }
    if (next === '"' && !inDouble) { i++; return; } // $"…" — знак отбрасывается, кавычку разберёт основной цикл
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(i, i + 200));
    if (m) {
      word.vars.push(m[1]);
      word.text += m[0];
      i += m[0].length;
      return;
    }
    word.text += '$';
    i++;
  }

  function readDouble(word) {
    while (i < s.length) {
      const c = s[i];
      if (c === '"') { i++; return; }
      if (c === '\\') {
        const n = s[i + 1];
        if (n === undefined) { i++; continue; }
        if ('$`"\\\n'.includes(n)) {
          if (n !== '\n') word.text += n;
          i += 2;
        } else {
          word.text += '\\';
          i++;
        }
        continue;
      }
      if (c === '$') { readDollar(word, true); continue; }
      if (c === '`') { i++; substitution(word, '`'); continue; }
      word.text += c;
      i++;
    }
  }

  function readWord(closer) {
    const word = newWord();
    while (i < s.length) {
      const c = s[i];
      if (' \t\r\n;&|()<>'.includes(c)) break;
      if (c === '`') {
        if (closer === '`') break;
        i++;
        substitution(word, '`');
      } else if (c === "'") {
        const end = s.indexOf("'", i + 1);
        word.text += s.slice(i + 1, end === -1 ? s.length : end);
        i = end === -1 ? s.length : end + 1;
        word.quoted = true;
      } else if (c === '"') {
        i++;
        readDouble(word);
        word.quoted = true;
      } else if (c === '\\') {
        const n = s[i + 1];
        i += 2;
        if (n !== undefined && n !== '\n') word.text += n;
      } else if (c === '$') {
        readDollar(word, false);
      } else {
        word.text += c;
        i++;
      }
    }
    return word;
  }

  const REDIRECT = /(\d*)(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/y;

  function parseSeq(closer) {
    let pipe = nextPipe++;
    let cmd = newCommand(pipe, false);
    let redir = null; // оператор, ждущий слова-цели
    let parens = 0;
    const flush = piped => {
      if (cmd.words.length > 0 || cmd.redirs.length > 0) commands.push(cmd);
      if (!piped) pipe = nextPipe++;
      cmd = newCommand(pipe, piped);
      redir = null;
    };
    const attach = word => {
      if (redir === null) { cmd.words.push(word); return; }
      if (redir.op === '<<' || redir.op === '<<-') pending.push({ delim: word.text, strip: redir.op === '<<-', cmd });
      else if (redir.op === '<<<') cmd.hereString = word.text;
      else if (!redir.op.endsWith('&')) cmd.redirs.push({ op: redir.op, target: word });
      redir = null;
    };

    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '\n') { i++; flush(false); readHeredocs(); continue; }
      if (c === '\\' && s[i + 1] === '\n') { i += 2; continue; }
      if (c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (c === ';') { i += s[i + 1] === ';' || s[i + 1] === '&' ? 2 : 1; flush(false); continue; }
      if (c === '&' && s[i + 1] !== '>') { i += s[i + 1] === '&' ? 2 : 1; flush(false); continue; }
      if (c === '|') {
        const piped = s[i + 1] !== '|';
        i += s[i + 1] === '|' || s[i + 1] === '&' ? 2 : 1;
        flush(piped);
        continue;
      }
      if (c === '(') { parens++; i++; flush(false); continue; }
      if (c === ')') {
        i++;
        flush(false);
        if (parens > 0) parens--;
        else if (closer === ')') return;
        continue;
      }
      if (c === '`' && closer === '`') { i++; flush(false); return; }
      if ((c === '<' || c === '>') && s[i + 1] === '(') { // подстановка процесса: <(…), >(…)
        i += 2;
        const word = newWord();
        substitution(word, ')');
        attach(word);
        continue;
      }
      REDIRECT.lastIndex = i;
      const r = REDIRECT.exec(s);
      if (r) {
        i += r[0].length;
        redir = { op: r[2] };
        continue;
      }
      const start = i;
      attach(readWord(closer));
      if (i === start) i++; // защита от зацикливания
    }
    flush(false);
  }

  parseSeq(null);
  return commands;
}

// ---- вспомогательные функции разбора команды -----------------------------------------------------------------------

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'coproc']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'fish', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd']);
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'aria2c', 'http', 'xh']);
const INTERPRETERS = /^(python[0-9.]*|py|perl|ruby|node|nodejs|deno|bun|php|lua)$/;
const EVAL_FLAGS = new Set(['-c', '-e', '-r', '-p', '--eval', '-E']);
const SENSITIVE = /(token|secret|passw(or)?d|api_?key|private_?key|credential|auth_?key|access_?key)/i;
// Переменные с такими окончаниями хранят путь или имя, а не секрет.
const NOT_SECRET = /_(FILE|PATH|DIR|NAME)$/i;
const LOOSE_SECRET = /(token|secret|passw|key|credential)/i;
// Файлы, в которых лежат токены и закрытые ключи пользователя (открытые ключи .pub не затронуты).
const CREDENTIAL_FILES = /(^|\/)(\.config\/gh\/hosts\.yml|\.git-credentials|\.netrc|\.ssh\/id_[a-z0-9_]+)$/i;

// Программы, запускающие другую команду: name -> { valued: параметры со значением, positional: число обычных аргументов }.
const WRAPPERS = {
  sudo: { valued: new Set(['-u', '-g', '-h', '-p', '-C', '-T', '-D', '-R', '-U', '-r', '-t']) },
  doas: { valued: new Set(['-u', '-C']) },
  env: { valued: new Set(['-u', '-C', '-S', '-P']) },
  command: { valued: new Set() },
  builtin: { valued: new Set() },
  exec: { valued: new Set(['-a']) },
  nohup: { valued: new Set() },
  setsid: { valued: new Set() },
  nice: { valued: new Set(['-n']) },
  ionice: { valued: new Set(['-c', '-n', '-p']) },
  stdbuf: { valued: new Set(['-i', '-o', '-e']) },
  timeout: { valued: new Set(['-s', '-k']), positional: 1 },
  time: { valued: new Set() },
  xargs: { valued: new Set(['-I', '-n', '-P', '-L', '-s', '-E', '-d', '-a']) },
  watch: { valued: new Set(['-n']) },
  busybox: { valued: new Set() },
};

const lower = text => text.toLowerCase();

function baseName(text) {
  return lower(text.replace(/\\/g, '/').split('/').pop()).replace(/\.(exe|cmd|bat|com)$/, '');
}

function skipWrapper(args, spec) {
  let k = 0;
  while (k < args.length) {
    const t = args[k].text;
    if (t === '--') { k++; break; }
    if (!t.startsWith('-') || t === '-') break;
    k++;
    if (spec.valued.has(t)) k++;
  }
  for (let n = 0; n < (spec.positional ?? 0) && k < args.length; n++) k++;
  while (k < args.length && ASSIGN.test(args[k].text)) k++;
  return args.slice(k);
}

// Раскрывает слова, равные одной известной переменной ($X, "$X", ${X}), по простым присваиваниям выше в той же строке.
function expandWords(words, known) {
  const out = [];
  for (const w of words) {
    const m = w.vars.length === 1 ? /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(w.text) : null;
    if (m && known.has(m[1])) {
      const value = known.get(m[1]);
      const parts = w.quoted ? [value] : value.split(/\s+/).filter(Boolean);
      for (const text of parts) out.push({ text, vars: [], dl: false, sub: false, quoted: true });
    } else {
      out.push(w);
    }
  }
  return out;
}

// Убирает присваивания и ключевые слова оболочки перед командой. Возвращает { words, assigns }.
function stripPrefix(words) {
  const assigns = [];
  let k = 0;
  for (; k < words.length; k++) {
    if (ASSIGN.test(words[k].text)) assigns.push(words[k]);
    else if (!KEYWORDS.has(words[k].text)) break;
  }
  return { words: words.slice(k), assigns };
}

// Снимает обёртки (sudo, env, xargs…). Результат: { name, args } либо null, если имя команды неизвестно.
function unwrap(words) {
  let rest = words;
  for (let n = 0; n < 8 && rest.length > 0; n++) {
    if (rest[0].text.includes(PLACEHOLDER)) return null;
    const name = baseName(rest[0].text);
    const spec = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : null;
    if (spec === null) return { name, args: rest.slice(1) };
    if (name === 'command' && rest.slice(1).some(a => /^-[vV]$/.test(a.text))) return null;
    const after = skipWrapper(rest.slice(1), spec);
    if (after.length === 0) return { name, args: [] };
    rest = after;
  }
  return null;
}

function callOf(cmd, known) {
  const { words } = stripPrefix(expandWords(cmd.words, known));
  return words.length === 0 ? null : unwrap(words);
}

function isDownloader(call) {
  return call !== null && DOWNLOADERS.has(call.name);
}

// ---- пути --------------------------------------------------------------------------------------------------------

const PROTECTED = [
  /(^|\/)\.github\/workflows(\/|$)/,
  /(^|\/)scripts\/std(\/|$)/,
  /(^|\/)\.claude\/hooks(\/|$)/,
  /(^|\/)\.claude\/settings\.json$/,
];

function projectRoot(cwd) {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return cwd;
  }
}

function isProtectedPath(path, ctx) {
  let n = posix.normalize(path.replace(/\\/g, '/').toLowerCase());
  const root = ctx.root.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  if (root !== '' && n.startsWith(`${root}/`)) n = n.slice(root.length + 1);
  return PROTECTED.some(re => re.test(n));
}

// Ветка из .git/HEAD (обычный каталог .git или файл .git рабочего дерева); null, если не определить.
function currentBranch(cwd) {
  try {
    for (let dir = cwd; ; dir = dirname(dir)) {
      const dot = join(dir, '.git');
      if (existsSync(dot)) {
        let head = join(dot, 'HEAD');
        if (statSync(dot).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'));
          if (!m) return null;
          head = join(dir, m[1].trim(), 'HEAD');
        }
        const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(head, 'utf8'));
        return ref ? ref[1].trim() : null;
      }
      if (dirname(dir) === dir) return null;
    }
  } catch {
    return null;
  }
}

// ---- правила -----------------------------------------------------------------------------------------------------

function gitPush(args) {
  const positional = [];
  let force = false;
  let del = false;
  let mirror = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { positional.push(...args.slice(k + 1)); break; }
    if (a.startsWith('--')) {
      const name = a.split('=')[0];
      if (name === '--force' || name === '--force-with-lease' || name === '--force-if-includes') force = true;
      else if (name === '--delete') del = true;
      else if (name === '--mirror' || name === '--prune') mirror = true;
      else if (!a.includes('=') && ['--repo', '--receive-pack', '--exec', '--push-option'].includes(name)) k++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      if (/^-[a-z0-9]+$/.test(a)) {
        const letters = a.slice(1);
        if (letters.includes('f')) force = true;
        if (letters.includes('d')) del = true;
        if (letters.endsWith('o')) k++;
      }
      continue;
    }
    positional.push(a);
  }
  if (force) return REASONS.force;
  if (del || mirror) return REASONS.deleteRef;
  for (const p of positional) {
    if (p.startsWith('+')) return REASONS.force;
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(p) || p.includes('@')) continue; // адрес, а не ссылка
    if (p.startsWith(':')) return REASONS.deleteRef;
    const dst = (p.includes(':') ? p.slice(p.lastIndexOf(':') + 1) : p).replace(/^refs\/heads\//, '');
    if (dst === 'main' || dst === 'master') return REASONS.pushMain;
  }
  return null;
}

// Параметры git tag читаются с учётом регистра только там, где он различает смысл (-f принудительно, -F файл сообщения).
function gitTag(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') break;
    if (a.startsWith('--')) {
      const n = lower(a);
      if (n === '--delete' || n === '--force') return REASONS.tag;
      if (['--message', '--file', '--local-user'].includes(n)) k++;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(a)) {
      if (/[dD]/.test(a) || a.includes('f')) return REASONS.tag;
      if ('mFu'.includes(a.at(-1))) k++;
    }
  }
  return null;
}

function gitReset(args, ctx) {
  if (!args.includes('--hard')) return null;
  const refs = args.filter(a => !a.startsWith('-'));
  if (refs.some(r => /^(refs\/remotes\/)?[^/]+\/(main|master)$/.test(r))) return REASONS.reset;
  const branch = currentBranch(ctx.cwd);
  if ((branch === 'main' || branch === 'master') && refs.some(r => r.includes('/'))) return REASONS.reset;
  return null;
}

function gitBranch(args) {
  let del = false;
  let force = false;
  const positional = [];
  for (const a of args) {
    if (a.startsWith('--')) {
      if (a === '--delete' || a === '--move') del = true;
      else if (a === '--force') force = true;
    } else if (/^-[a-z]+$/.test(a)) {
      if (/[dm]/.test(a)) del = true;
      if (a.includes('f')) force = true;
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }
  const protectedName = n => n === 'main' || n === 'master';
  if (del && positional.some(protectedName)) return REASONS.branchMain;
  if (force && positional.length > 0 && protectedName(positional[0])) return REASONS.branchMain;
  return null;
}

function checkGit(raw, ctx) {
  let k = 0;
  while (k < raw.length) {
    const a = lower(raw[k]);
    if (['-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'].includes(a)) k += 2;
    else if (a.startsWith('-')) k++;
    else break;
  }
  if (k >= raw.length) return null;
  const sub = lower(raw[k]);
  const rest = raw.slice(k + 1);
  const low = rest.map(lower);
  switch (sub) {
    case 'push': return gitPush(low);
    case 'tag': return gitTag(rest);
    case 'reset': return gitReset(low, ctx);
    case 'branch': return gitBranch(low);
    case 'filter-branch':
    case 'filter-repo': return REASONS.history;
    case 'update-ref':
      if (low.includes('-d') && low.some(a => a.startsWith('refs/tags/'))) return REASONS.tag;
      if (low.includes('-d') && low.some(a => /^refs\/heads\/(main|master)$/.test(a))) return REASONS.branchMain;
      return null;
    case 'rm':
    case 'mv': return low.some(a => !a.startsWith('-') && isProtectedPath(a, ctx)) ? REASONS.restrictor : null;
    default: return null;
  }
}

const API_TARGETS = [
  /(^|\/)repos\/[^/]+\/[^/?#]+\/?(\?.*)?$/, // сам репозиторий
  /(^|\/)repos\/[^/]+\/[^/]+\/branches\/.+\/protection/,
  /(^|\/)repos\/[^/]+\/[^/]+\/git\/refs\/tags(\/|%2f)/,
  /(^|\/)repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(main|master)(\?|$)/,
  /(^|\/)repos\/[^/]+\/[^/]+\/(rulesets|tags\/protection)(\/|$)/,
];

// -X DELETE, -XDELETE, --method DELETE, --method=DELETE, --request DELETE (curl).
function hasDeleteMethod(low) {
  return low.some((a, k) => {
    if (['-x', '--method', '--request'].includes(a)) return low[k + 1] === 'delete';
    if (a === '--method=delete' || a === '--request=delete') return true;
    return /^-x/.test(a) && a.slice(2) === 'delete';
  });
}

function checkGh(raw) {
  const low = raw.map(lower);
  const sub = low.find(a => !a.startsWith('-'));
  if (sub === 'api' && hasDeleteMethod(low) && low.some(a => API_TARGETS.some(re => re.test(a)))) return REASONS.apiDelete;
  const k = low.indexOf(sub);
  if (sub === 'repo' && low[k + 1] === 'delete') return REASONS.repoDelete;
  if (sub === 'release' && low[k + 1] === 'delete' && low.includes('--cleanup-tag')) return REASONS.tag;
  if (sub === 'auth' && (low[k + 1] === 'token' || (low[k + 1] === 'status' && low.some(a => a === '-t' || a === '--show-token')))) return REASONS.token;
  return null;
}

function isDangerousRmTarget(word) {
  const t = word.text.replace(/\\/g, '/').replace(/\/+/g, '/');
  const low = lower(t);
  const core = low.replace(/(\/\*|\/\.|\/)+$/, '');
  if (core === '' && low.startsWith('/')) return true;
  if (/^\/(bin|boot|dev|etc|home|lib|lib32|lib64|libx32|mnt|media|opt|proc|root|run|sbin|srv|sys|usr|var|snap)$/.test(core)) return true;
  if (/^\/[a-z]$/.test(core) || /^[a-z]:$/.test(core)) return true; // корень диска (Git Bash и Windows)
  if (core === '~' || /^~[a-z_][a-z0-9_-]*$/.test(core)) return true;
  return (core === '$home' || core === '${home}' || core === '$userprofile' || core === '${userprofile}') && word.vars.some(v => /^(home|userprofile)$/i.test(v));
}

function checkRm(args) {
  const texts = args.map(a => a.text);
  if (texts.includes('--no-preserve-root')) return REASONS.rm;
  const recursive = texts.some(t => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(t) || lower(t) === '--recursive');
  let afterDashes = false;
  for (const a of args) {
    if (a.text === '--') { afterDashes = true; continue; }
    if (!afterDashes && a.text.startsWith('-')) continue;
    if ((recursive || a.text.endsWith('*')) && isDangerousRmTarget(a)) return REASONS.rm;
  }
  return null;
}

// Команды, меняющие файлы: какие их аргументы — пути назначения.
function writtenPaths(name, args) {
  const texts = args.map(a => a.text);
  const plain = texts.filter(t => !t.startsWith('-') || t === '-');
  switch (name) {
    case 'tee':
    case 'mv':
    case 'rm':
    case 'unlink':
    case 'rmdir':
    case 'touch':
    case 'truncate':
    case 'chmod':
    case 'chown':
    case 'chgrp':
    case 'shred': return plain;
    case 'sed':
    case 'perl': return texts.some(t => (/^-[A-Za-z]*i/.test(t) && !t.startsWith('--')) || t.startsWith('--in-place')) ? plain : [];
    case 'cp':
    case 'install':
    case 'ln':
    case 'rsync':
    case 'scp': {
      const out = plain.slice(-1);
      texts.forEach((t, k) => { if (t === '-t' || t === '--target-directory') out.push(texts[k + 1] ?? ''); });
      return out;
    }
    case 'dd': return texts.filter(t => t.startsWith('of=')).map(t => t.slice(3));
    case 'curl': return texts.flatMap((t, k) => (t === '-o' || t === '--output' ? [texts[k + 1] ?? ''] : t.startsWith('--output=') ? [t.slice(9)] : []));
    case 'wget': return texts.flatMap((t, k) => (t === '-O' || t === '--output-document' ? [texts[k + 1] ?? ''] : t.startsWith('--output-document=') ? [t.slice(18)] : []));
    default: return [];
  }
}

// Скрипт, который оболочка выполнит: { text } для -c, { file } для файла, { stdin } для ввода.
function shellScript(name, args) {
  const texts = args.map(a => a.text);
  if (name === 'cmd') {
    const k = texts.findIndex(t => /^\/[ck]$/i.test(t));
    return k >= 0 ? { text: texts.slice(k + 1).join(' ') } : { stdin: true };
  }
  if (name === 'pwsh' || name === 'powershell') {
    const k = texts.findIndex(t => /^-(c|command)$/i.test(t));
    return k >= 0 ? { text: texts.slice(k + 1).join(' ') } : { stdin: true };
  }
  for (let k = 0; k < texts.length; k++) {
    const t = texts[k];
    if (t === '-o' || t === '+o' || t === '-O' || t === '+O') { k++; continue; }
    if (/^-[A-Za-z]+$/.test(t)) {
      if (/c/i.test(t)) return { text: texts[k + 1] ?? '' };
      continue;
    }
    if (t.startsWith('-') || t.startsWith('+')) continue;
    return { file: true };
  }
  return { stdin: true };
}

// Тексты команд, которые передаются оболочке по конвейеру: echo, printf, cat с here-документом.
function upstreamScripts(cmd, ctx) {
  const out = [];
  for (const up of ctx.pipeline) {
    if (up === cmd) break;
    const call = callOf(up, ctx.known);
    if (call === null) continue;
    if (call.name === 'echo' || call.name === 'printf') {
      out.push(call.args.map(a => a.text).filter(t => !/^-[neE]+$/.test(t)).join(' ').replace(/\\n/g, '\n'));
    }
    if (up.heredoc !== null) out.push(up.heredoc);
    if (up.hereString !== null) out.push(up.hereString);
  }
  return out;
}

function upstreamHasDownloader(cmd, ctx) {
  for (const up of ctx.pipeline) {
    if (up === cmd) break;
    if (isDownloader(callOf(up, ctx.known))) return true;
  }
  return false;
}

function isDump(call) {
  const flags = call.args.map(a => a.text);
  if ((call.name === 'env' || call.name === 'printenv') && flags.length === 0) return true;
  if (call.name === 'set' && flags.length === 0) return true;
  if (call.name === 'export' && flags.every(f => f === '-p')) return true;
  return (call.name === 'declare' || call.name === 'typeset') && flags.length > 0 && flags.every(f => /^-[xp]+$/.test(f));
}

function stringLiterals(text) {
  return [...text.matchAll(/(["'])((?:\\.|(?!\1)[^\\])*)\1/gs)].map(m => m[2].replace(/\\(["'\\])/g, '$1'));
}

/** Проверяет простую команду; возвращает причину блокировки или null. */
function checkCall(call, cmd, ctx) {
  const { name, args } = call;
  const texts = args.map(a => a.text);
  const low = texts.map(lower);

  // скачанное выполняется без просмотра
  if ((SHELLS.has(name) || name === 'eval' || name === 'source' || name === '.') && args.some(a => a.dl)) return REASONS.pipeShell;
  if (cmd.pipeIn && upstreamHasDownloader(cmd, ctx)) {
    if (SHELLS.has(name) && shellScript(name, args).stdin) return REASONS.pipeShell;
    if (INTERPRETERS.test(name) && texts.every(t => t === '-')) return REASONS.pipeShell;
  }

  switch (name) {
    case 'git': {
      const r = checkGit(texts, ctx);
      if (r) return r;
      break;
    }
    case 'gh': {
      const r = checkGh(texts);
      if (r) return r;
      break;
    }
    case 'rm': {
      const r = checkRm(args);
      if (r) return r;
      break;
    }
    case 'curl':
      if (hasDeleteMethod(low) && low.some(a => API_TARGETS.some(re => re.test(a)))) return REASONS.apiDelete;
      break;
    case 'echo':
    case 'printf':
    case 'print':
      if (args.some(a => a.vars.some(v => SENSITIVE.test(v) && !NOT_SECRET.test(v)))) return REASONS.token;
      break;
    case 'printenv':
      if (texts.some(t => !t.startsWith('-') && SENSITIVE.test(t))) return REASONS.token;
      break;
    case 'export':
    case 'declare':
    case 'local':
    case 'readonly':
    case 'typeset':
      for (const a of args) {
        const m = ASSIGN.exec(a.text);
        if (!m) continue;
        const key = m[0].replace(/\+?=$/, '');
        if (a.sub || a.vars.length > 0) ctx.known.delete(key);
        else ctx.known.set(key, a.text.slice(m[0].length));
      }
      break;
    case 'find': {
      for (let k = 0; k < texts.length; k++) {
        if (!['-exec', '-execdir', '-ok', '-okdir'].includes(texts[k])) continue;
        let end = k + 1;
        while (end < texts.length && texts[end] !== ';' && texts[end] !== '+') end++;
        const r = checkWords(args.slice(k + 1, end), cmd, ctx);
        if (r) return r;
      }
      break;
    }
    default:
  }

  if (isDump(call)) {
    const after = ctx.pipeline.slice(ctx.pipeline.indexOf(cmd) + 1);
    if (after.some(c => c.words.some(w => LOOSE_SECRET.test(w.text)))) return REASONS.token;
  }
  if (texts.some(t => /\/proc\/[^/]+\/environ/.test(t) || CREDENTIAL_FILES.test(t.replace(/\\/g, '/')))) return REASONS.token;

  if (writtenPaths(name, args).some(p => isProtectedPath(p, ctx))) return REASONS.restrictor;

  // вложенные сценарии
  if (ctx.depth < MAX_DEPTH) {
    const nested = text => checkScript(text, ctx, ctx.depth + 1);
    if (name === 'eval') {
      const r = nested(texts.join(' '));
      if (r) return r;
    }
    if (SHELLS.has(name)) {
      const script = shellScript(name, args);
      if (script.text !== undefined) {
        const r = nested(script.text);
        if (r) return r;
      } else if (script.stdin) {
        for (const text of [cmd.heredoc, cmd.hereString, ...upstreamScripts(cmd, ctx)]) {
          const r = text ? nested(text) : null;
          if (r) return r;
        }
      }
    }
    if (INTERPRETERS.test(name) && texts.some(t => EVAL_FLAGS.has(t))) {
      for (const text of texts.filter(t => /["']/.test(t))) {
        for (const literal of stringLiterals(text)) {
          const r = literal.length > 3 ? nested(literal) : null;
          if (r) return r;
        }
      }
    }
  }
  return null;
}

function checkWords(words, cmd, ctx) {
  const { words: rest } = stripPrefix(expandWords(words, ctx.known));
  if (rest.length === 0) return null;
  const call = unwrap(rest);
  return call === null ? null : checkCall(call, cmd, ctx);
}

function checkCommand(cmd, ctx) {
  for (const r of cmd.redirs) {
    if (r.op.includes('>') && !r.op.endsWith('&') && isProtectedPath(r.target.text, ctx)) return REASONS.restrictor;
  }
  const { words, assigns } = stripPrefix(expandWords(cmd.words, ctx.known));
  if (words.length === 0) { // только присваивания: запоминаем значения для $X ниже по строке
    for (const a of assigns) {
      const m = ASSIGN.exec(a.text);
      const key = m[0].replace(/\+?=$/, '');
      if (a.sub || a.vars.length > 0 || m[0].endsWith('+=')) ctx.known.delete(key);
      else ctx.known.set(key, a.text.slice(m[0].length));
    }
    return null;
  }
  const call = unwrap(words);
  return call === null ? null : checkCall(call, cmd, ctx);
}

function checkScript(src, parent, depth) {
  if (depth > MAX_DEPTH || src.length > MAX_LENGTH) return null;
  const commands = parseShell(src);
  const pipelines = new Map();
  for (const c of commands) {
    if (!pipelines.has(c.pipe)) pipelines.set(c.pipe, []);
    pipelines.get(c.pipe).push(c);
  }
  const known = new Map();
  for (const cmd of commands) {
    const r = checkCommand(cmd, { cwd: parent.cwd, root: parent.root, known, pipeline: pipelines.get(cmd.pipe), depth });
    if (r) return r;
  }
  return null;
}

// ---- точка входа -------------------------------------------------------------------------------------------------

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** @returns {string | null} причина блокировки по-русски либо null, если вызов разрешён */
export function decide(input) {
  if (typeof input !== 'object' || input === null) return null;
  if (input.hook_event_name !== undefined && input.hook_event_name !== 'PreToolUse') return null;
  const tool = input.tool_name;
  const toolInput = input.tool_input;
  if (typeof tool !== 'string' || typeof toolInput !== 'object' || toolInput === null) return null;
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  const ctx = { cwd, root: projectRoot(cwd) };
  if (tool === 'Bash') {
    return typeof toolInput.command === 'string' ? checkScript(toolInput.command, ctx, 0) : null;
  }
  if (FILE_TOOLS.has(tool)) {
    const path = [toolInput.file_path, toolInput.notebook_path].find(p => typeof p === 'string' && p !== '');
    return path !== undefined && isProtectedPath(path, ctx) ? REASONS.file : null;
  }
  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return 0; // пустой или неверный ввод: решать нечего
  }
  let reason = null;
  try {
    reason = decide(input);
  } catch {
    return 0; // не удалось разобрать с уверенностью: пропускаем
  }
  if (reason === null) return 0;
  process.stderr.write(`std-guard: заблокировано. ${reason}\n`);
  return 2;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = main();
