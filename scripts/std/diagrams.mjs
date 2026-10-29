#!/usr/bin/env node
// Build check of every Mermaid diagram in Markdown (spec 10): each block must render with mermaid-cli.
// Usage: node scripts/std/diagrams.mjs [--root .] [--list]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fail, isMain, normalize, readText, walk } from './common.mjs';

const MERMAID_CLI = '@mermaid-js/mermaid-cli@12.0.0';

/** @returns {{ line: number, code: string }[]} diagrams of a Markdown text with the line of their opening fence */
export function extractBlocks(markdown) {
  const blocks = [];
  const lines = normalize(markdown).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^```mermaid\s*$/.test(lines[i])) continue;
    const end = lines.findIndex((l, j) => j > i && /^```\s*$/.test(l));
    if (end === -1) { blocks.push({ line: i + 1, code: null }); break; }
    blocks.push({ line: i + 1, code: lines.slice(i + 1, end).join('\n') });
    i = end;
  }
  return blocks;
}

// Command and leading arguments of mermaid-cli: an installed mmdc or the pinned package through npx.
function renderer() {
  if (spawnSync('mmdc', ['--version'], { stdio: 'ignore' }).status === 0) return ['mmdc'];
  return ['npx', '--yes', MERMAID_CLI];
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { root: { type: 'string', default: '.' }, list: { type: 'boolean' } } });
  const found = [];
  for (const path of walk(values.root).filter(p => p.endsWith('.md'))) {
    for (const block of extractBlocks(readText(join(values.root, path)) ?? '')) found.push({ path, ...block });
  }
  if (found.length === 0) {
    console.log('Схемы Mermaid: нет схем');
    return;
  }
  if (values.list) {
    found.forEach(b => console.log(`${b.path}:${b.line}`));
    return;
  }
  const problems = found.filter(b => b.code === null).map(b => `${b.path}:${b.line}: схема не закрыта`);
  const dir = mkdtempSync(join(tmpdir(), 'std-mermaid-'));
  try {
    const config = join(dir, 'puppeteer.json');
    writeFileSync(config, JSON.stringify({ args: ['--no-sandbox'] }));
    const cli = renderer();
    found.filter(b => b.code !== null).forEach((b, i) => {
      const input = join(dir, `d${i}.mmd`);
      writeFileSync(input, b.code);
      const [command, ...prefix] = cli;
      const r = spawnSync(command, [...prefix, '-p', config, '-i', input, '-o', join(dir, `d${i}.svg`), '--quiet'], { encoding: 'utf8' });
      if (r.status !== 0) problems.push(`${b.path}:${b.line}: схема не собирается: ${(r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' | ')}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (problems.length > 0) fail(['Схемы Mermaid:', ...problems.map(p => `  ${p}`)]);
  else console.log(`Схемы Mermaid: собрано ${found.length}`);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
