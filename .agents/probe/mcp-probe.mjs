// Запускает каждый MCP-сервер из .mcp.json (stdio) и просит список инструментов.
// Запуск: node .agents/probe/mcp-probe.mjs [секунд на сервер, по умолчанию 120]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const limit = Number(process.argv[2] ?? 120) * 1000;
const servers = JSON.parse(readFileSync('.mcp.json', 'utf8')).mcpServers;
const results = [];

function probe(name, cfg) {
  return new Promise(resolve => {
    // Домашний каталог в песочнице Codex доступен только для чтения: кэши переносим в /tmp.
    const env = { ...process.env, UV_CACHE_DIR: '/tmp/std-probe/uv', npm_config_cache: '/tmp/std-probe/npm', XDG_CACHE_HOME: '/tmp/std-probe/xdg', DATABASE_URI: process.env.DATABASE_URI ?? 'postgresql://postgres:std-probe@localhost:5432/postgres' };
    const child = spawn(cfg.command, cfg.args ?? [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = (status, detail) => {
      if (done) return;
      done = true; clearTimeout(timer); child.kill();
      resolve({ name, status, detail });
    };
    const timer = setTimeout(() => finish('ТАЙМАУТ', err.slice(-300).trim()), limit);
    child.stdin.on('error', () => {});
    const send = msg =>child.stdin.write(JSON.stringify(msg) + '\n');
    child.on('error', e => finish('НЕ ЗАПУСТИЛСЯ', e.message));
    child.on('exit', code => finish('ЗАВЕРШИЛСЯ', `код ${code}; ${err.slice(-300).trim()}`));
    child.stderr.on('data', d => { err += d; });
    child.stdout.on('data', d => {
      out += d;
      for (const line of out.split('\n')) {
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        }
        if (m.id === 2) finish('РАБОТАЕТ', `инструментов: ${m.result?.tools?.length ?? '?'}: ${(m.result?.tools ?? []).slice(0, 4).map(t => t.name).join(', ')}`);
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'std-probe', version: '0' } } });
  });
}

for (const [name, cfg] of Object.entries(servers)) {
  if (!cfg.command) { console.log(`${name}: ПРОПУЩЕН — удалённый сервер ${cfg.url}: нужен токен, проверяется только доступность адреса`); continue; }
  results.push(await probe(name, cfg));
  console.log(`${results.at(-1).name}: ${results.at(-1).status} — ${results.at(-1).detail}`);
}
