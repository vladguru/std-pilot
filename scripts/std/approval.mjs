#!/usr/bin/env node
// Check of the owner's approval (spec 2 "Порядок согласования"). Runs from main, never from the PR code:
// the owner's account is read from AGENTS.md of main, so a PR cannot replace it.
// Usage (CI): node scripts/std/approval.mjs [--post-status]   — env GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_EVENT_PATH
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AGENT_MARK, isMain, LABEL_APPROVAL, ownerFromAgentsMd, parseDiff, RESTRICTOR_PATHS } from './common.mjs';
import { analyze } from './guard.mjs';

export const STATUS_CONTEXT = 'std/согласование';
const APPROVAL_PATHS = [/^SPEC\.md$/, /^design\/tokens\.json$/];
// The whole comment is the word "согласовано" (punctuation and quotes allowed): "не согласовано", "согласовано ли?" do not count.
const APPROVE_COMMENT = /^[\s"«'(]*согласовано[\s.!»")]*$/u;
const REJECT_COMMENT = /(?<![\p{L}])не\s*согласовано|(?<![\p{L}])не\s+согласен|(?<![\p{L}])отклоня|(?<![\p{L}])отклонено/u;
const AGREED_STATUS = /^Статус:\s*согласовано\s+\d{2}\.\d{2}\.\d{4}/i;

/** Converts files of `GET /pulls/{n}/files` to the diff structure of parseDiff; a file without a patch is treated as binary. */
export function filesFromApi(files) {
  const text = files.map(f => {
    const oldPath = f.status === 'added' ? '/dev/null' : `a/${f.previous_filename ?? f.filename}`;
    const newPath = f.status === 'removed' ? '/dev/null' : `b/${f.filename}`;
    return `diff --git a/x b/x\n--- ${oldPath}\n+++ ${newPath}\n${f.patch ?? 'Binary files differ'}\n`;
  }).join('');
  return parseDiff(text);
}

// Only the move of the status to "согласовано ДД.ММ.ГГГГ" is free; returning to "черновик" is a change of requirements.
function statusLineOnly(file) {
  return file.added.length > 0 && file.added.every(l => AGREED_STATUS.test(l.text)) && file.removed.every(l => /^Статус:/.test(l.text));
}

function approvalReasons({ labels, files, changedFiles }) {
  const reasons = [];
  if (labels.includes(LABEL_APPROVAL)) reasons.push(`метка «${LABEL_APPROVAL}»`);
  if (typeof changedFiles === 'number' && files.length < changedFiles) reasons.push('получены не все файлы PR');
  for (const f of files) {
    const paths = [f.path, f.oldPath].filter(Boolean);
    if (paths.includes('SPEC.md') && statusLineOnly(f)) continue;
    if (paths.some(p => APPROVAL_PATHS.some(re => re.test(p)) || RESTRICTOR_PATHS.some(re => re.test(p)))) reasons.push(`изменён ${f.path}`);
  }
  for (const v of analyze(files)) if (v.kind !== 'path') reasons.push(v.message);
  return reasons;
}

const sameLogin = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const byOwner = (item, owner) => sameLogin(item.user?.login, owner) && !(item.body ?? '').includes(AGENT_MARK);

/**
 * The latest decision of the owner decides. A review APPROVED counts on the current head only; a comment «согласовано»
 * counts after the last commit (the later of the commit dates and the time GitHub first saw the head). Without the time
 * GitHub saw the head a comment does not count: commit dates alone can be forged.
 */
export function ownerApproval({ owner, headSha, reviews, comments, commits, suites = [] }) {
  const headSeen = suites.map(s => s.created_at).filter(Boolean).sort()[0];
  const lastCommit = [...commits.flatMap(c => [c.commit?.committer?.date, c.commit?.author?.date]), headSeen].filter(Boolean).sort().at(-1) ?? '';
  const events = [];
  for (const r of reviews.filter(r => byOwner(r, owner))) {
    if (r.state === 'APPROVED' && r.commit_id === headSha) events.push({ at: r.submitted_at, ok: true, how: 'ревью APPROVED на текущем коммите' });
    else if (r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED') events.push({ at: r.submitted_at, ok: false });
  }
  for (const c of comments.filter(c => byOwner(c, owner))) {
    const body = (c.body ?? '').toLowerCase();
    if (REJECT_COMMENT.test(body)) events.push({ at: c.created_at, ok: false });
    else if (APPROVE_COMMENT.test(body) && headSeen && c.created_at > lastCommit) events.push({ at: c.created_at, ok: true, how: 'комментарий «согласовано» после последнего коммита' });
  }
  events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const last = events.at(-1);
  return last?.ok ? last.how : null;
}

/** @returns {{ required: boolean, approved: boolean, ok: boolean, reason: string }} */
export function evaluate({ labels, headSha, owner, reviews, comments, commits, suites = [], files, changedFiles }) {
  const reasons = approvalReasons({ labels, files, changedFiles });
  const required = reasons.length > 0;
  if (!required) return { required, approved: false, ok: true, reason: 'согласование не требуется' };
  if (!owner) return { required, approved: false, ok: false, reason: 'в профиле AGENTS.md ветки main не задана «Учётная запись владельца»: одобрение принять нельзя' };
  const needsLabel = !labels.includes(LABEL_APPROVAL);
  const how = ownerApproval({ owner, headSha, reviews, comments, commits, suites });
  const list = reasons.slice(0, 5).join('; ');
  // Без наборов проверок неизвестно, когда GitHub увидел коммит, и комментарий не принимается: подсказываем причину.
  const hint = suites.length === 0 ? '; время появления коммита на GitHub не получено — проверьте право checks: read у рабочего процесса' : '';
  if (needsLabel) return { required, approved: Boolean(how), ok: false, reason: `PR требует согласования (${list}): поставьте метку «${LABEL_APPROVAL}»` };
  if (!how) return { required, approved: false, ok: false, reason: `ждём одобрения владельца ${owner} (${list}): ревью Approve на последнем коммите или комментарий «согласовано» после него${hint}` };
  return { required, approved: true, ok: true, reason: `одобрено владельцем: ${how}` };
}

export function makeApi(token, base = 'https://api.github.com') {
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'std-ci', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub API ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
}

export async function listAll(api, path) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

export async function ownerFromMain(api, repo) {
  const file = await api(`repos/${repo}/contents/AGENTS.md?ref=refs/heads/main`);
  return ownerFromAgentsMd(Buffer.from(file.content, 'base64').toString('utf8'));
}

async function load(api, repo, number) {
  const pr = await api(`repos/${repo}/pulls/${number}`);
  const [owner, files, reviews, commits, comments, suites] = await Promise.all([
    ownerFromMain(api, repo),
    listAll(api, `repos/${repo}/pulls/${number}/files`),
    listAll(api, `repos/${repo}/pulls/${number}/reviews`),
    listAll(api, `repos/${repo}/pulls/${number}/commits`),
    listAll(api, `repos/${repo}/issues/${number}/comments`),
    api(`repos/${repo}/commits/${pr.head.sha}/check-suites`).then(r => r.check_suites ?? [], () => []),
  ]);
  return { pr, owner, files, reviews, commits, comments, suites };
}

/** Loads the PR from GitHub and evaluates it; with postStatus publishes the commit status `std/согласование`. */
export async function run({ api, repo, number, postStatus = false }) {
  const { pr, owner, files, reviews, commits, comments, suites } = await load(api, repo, number);
  // Список файлов PR строится относительно его базы: при базе, отличной от основной ветки, он скрывает изменения ограничителей.
  const defaultBranch = pr.base?.repo?.default_branch;
  const baseOk = !defaultBranch || pr.base?.ref === defaultBranch;
  const result = !baseOk
    ? { required: true, approved: false, ok: false, reason: `PR направлен в ветку «${pr.base.ref}», а не в основную «${defaultBranch}»: согласование действует только для PR в основную ветку` }
    : evaluate({ labels: pr.labels.map(l => l.name), headSha: pr.head.sha, owner, reviews, comments, commits, suites, files: filesFromApi(files), changedFiles: pr.changed_files });
  if (postStatus) {
    await api(`repos/${repo}/statuses/${pr.head.sha}`, { method: 'POST', body: { state: result.ok ? 'success' : 'failure', context: STATUS_CONTEXT, description: result.reason.slice(0, 140) } });
  }
  return result;
}

export function prNumber(event) {
  if (event.pull_request) return event.pull_request.number;
  if (event.issue?.pull_request) return event.issue.number;
  return null;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { 'post-status': { type: 'boolean' }, pr: { type: 'string' } } });
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error('нужны GITHUB_REPOSITORY и GITHUB_TOKEN');
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const number = values.pr ? Number(values.pr) : prNumber(event);
  if (!number) {
    console.log('Событие не относится к PR: проверка согласования пропущена');
    return;
  }
  const result = await run({ api: makeApi(token), repo, number, postStatus: values['post-status'] });
  console.log(`Согласование PR #${number}: ${result.reason}`);
  // With --post-status the verdict is the commit status; the job itself stays green so that repeated runs do not pile up red checks.
  if (!result.ok && !values['post-status']) process.exitCode = 1;
}

if (isMain(import.meta.url)) main(process.argv.slice(2)).catch(err => { console.error(`Ошибка: ${err.message}`); process.exitCode = 1; });
