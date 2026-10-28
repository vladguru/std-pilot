#!/usr/bin/env node
// Check of the owner's approval (spec 2 "Порядок согласования"). Runs from main, never from the PR code:
// the owner's account is read from AGENTS.md of main, so a PR cannot replace it.
// Usage (CI): node scripts/std/approval.mjs [--post-status]   — env GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_EVENT_PATH
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AGENT_MARK, LABEL_APPROVAL, ownerFromAgentsMd, parseDiff, RESTRICTOR_PATHS, isMain } from './common.mjs';

export const STATUS_CONTEXT = 'std/согласование';
const APPROVAL_PATHS = [/^SPEC\.md$/, /^design\/tokens\.json$/];
// "согласовано" but not "не согласовано" / "несогласовано"
const APPROVED_WORD = /(?<![\p{L}])(?<!не\s)(?<!не-)согласовано/u;

/** Converts files of `GET /pulls/{n}/files` to the diff structure of parseDiff. */
export function filesFromApi(files) {
  const text = files.map(f => {
    const oldPath = f.status === 'added' ? '/dev/null' : `a/${f.previous_filename ?? f.filename}`;
    const newPath = f.status === 'removed' ? '/dev/null' : `b/${f.filename}`;
    return `diff --git a/x b/x\n--- ${oldPath}\n+++ ${newPath}\n${f.patch ?? ''}\n`;
  }).join('');
  return parseDiff(text);
}

function statusLineOnly(file) {
  const lines = [...file.added, ...file.removed];
  return lines.length > 0 && lines.every(l => /^Статус:/.test(l.text));
}

function approvalReasons({ labels, files }) {
  const reasons = [];
  if (labels.includes(LABEL_APPROVAL)) reasons.push(`метка «${LABEL_APPROVAL}»`);
  for (const f of files) {
    const paths = [f.path, f.oldPath].filter(Boolean);
    if (paths.includes('SPEC.md') && statusLineOnly(f)) continue;
    if (paths.some(p => APPROVAL_PATHS.some(re => re.test(p)) || RESTRICTOR_PATHS.some(re => re.test(p)))) reasons.push(`изменён ${f.path}`);
  }
  return reasons;
}

const sameLogin = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const byOwner = (item, owner) => sameLogin(item.user?.login, owner) && !(item.body ?? '').startsWith(AGENT_MARK);

export function ownerApproval({ owner, headSha, reviews, comments, commits }) {
  const decisions = reviews
    .filter(r => byOwner(r, owner) && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
    .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
  const last = decisions.at(-1);
  if (last?.state === 'APPROVED' && last.commit_id === headSha) return 'ревью APPROVED на текущем коммите';
  const lastCommit = commits.flatMap(c => [c.commit?.committer?.date, c.commit?.author?.date]).filter(Boolean).sort().at(-1) ?? '';
  const comment = comments.find(c => byOwner(c, owner) && APPROVED_WORD.test(c.body.toLowerCase()) && c.created_at > lastCommit);
  return comment ? 'комментарий «согласовано» после последнего коммита' : null;
}

/** @returns {{ required: boolean, approved: boolean, ok: boolean, reason: string }} */
export function evaluate({ labels, headSha, owner, reviews, comments, commits, files }) {
  const reasons = approvalReasons({ labels, files });
  const required = reasons.length > 0;
  if (!required) return { required, approved: false, ok: true, reason: 'согласование не требуется' };
  if (!owner) return { required, approved: false, ok: false, reason: 'в профиле AGENTS.md ветки main не задана «Учётная запись владельца»: одобрение принять нельзя' };
  const needsLabel = !labels.includes(LABEL_APPROVAL);
  const how = ownerApproval({ owner, headSha, reviews, comments, commits });
  if (needsLabel) return { required, approved: Boolean(how), ok: false, reason: `PR требует согласования (${reasons.join(', ')}): поставьте метку «${LABEL_APPROVAL}»` };
  if (!how) return { required, approved: false, ok: false, reason: `ждём одобрения владельца ${owner}: ревью Approve на последнем коммите или комментарий «согласовано» после него` };
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
  const file = await api(`repos/${repo}/contents/AGENTS.md?ref=main`);
  return ownerFromAgentsMd(Buffer.from(file.content, 'base64').toString('utf8'));
}

async function load(api, repo, number) {
  const pr = await api(`repos/${repo}/pulls/${number}`);
  const [owner, files, reviews, commits, comments] = await Promise.all([
    ownerFromMain(api, repo),
    listAll(api, `repos/${repo}/pulls/${number}/files`),
    listAll(api, `repos/${repo}/pulls/${number}/reviews`),
    listAll(api, `repos/${repo}/pulls/${number}/commits`),
    listAll(api, `repos/${repo}/issues/${number}/comments`),
  ]);
  return { pr, owner, files, reviews, commits, comments };
}

/** Loads the PR from GitHub and evaluates it; with postStatus publishes the commit status `std/согласование`. */
export async function run({ api, repo, number, postStatus = false }) {
  const { pr, owner, files, reviews, commits, comments } = await load(api, repo, number);
  const result = evaluate({ labels: pr.labels.map(l => l.name), headSha: pr.head.sha, owner, reviews, comments, commits, files: filesFromApi(files) });
  if (postStatus) {
    await api(`repos/${repo}/statuses/${pr.head.sha}`, { method: 'POST', body: { state: result.ok ? 'success' : 'failure', context: STATUS_CONTEXT, description: result.reason.slice(0, 140) } });
  }
  return result;
}

/** True when the owner (account from AGENTS.md of main) approved the current head of the PR. */
export async function isApprovedByOwner({ api, repo, number }) {
  const { pr, owner, reviews, commits, comments } = await load(api, repo, number);
  return Boolean(owner) && ownerApproval({ owner, headSha: pr.head.sha, reviews, comments, commits }) !== null;
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
