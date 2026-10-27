#!/usr/bin/env bash
# Проверка окружения сессии: PostgreSQL и версии инструментов. Ничего не изменяет в репозитории.
set -u
echo "== пользователь: $(id -un) (uid $(id -u))"
echo "== система: $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-неизвестно}")"
echo "== журнал скрипта установки (последние строки)"; tail -15 /tmp/std-cloud-setup.log 2>/dev/null || echo "журнала нет"
echo "== версии инструментов"
for tool in node npm npx uv uvx go python3 git gh psql; do
  if command -v "$tool" >/dev/null 2>&1; then echo "$tool: $("$tool" --version 2>&1 | head -1)"; else echo "$tool: НЕТ"; fi
done
echo "== запуск PostgreSQL"
SUDO=""; [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
if command -v pg_lsclusters >/dev/null 2>&1; then
  $SUDO pg_ctlcluster "$(pg_lsclusters -h | awk 'NR==1{print $1}')" "$(pg_lsclusters -h | awk 'NR==1{print $2}')" start 2>&1 || $SUDO service postgresql start 2>&1
  sleep 3
  pg_lsclusters
  $SUDO -u postgres psql -Atc "select 'POSTGRES-OK ' || version()" 2>&1
  $SUDO -u postgres psql -Atc "alter user postgres password 'std-probe'" >/dev/null 2>&1
  PGPASSWORD=std-probe psql -h localhost -U postgres -Atc "select 'POSTGRES-TCP-OK'" 2>&1
else
  echo "POSTGRES-НЕТ: pg_lsclusters не найден"
fi
echo "== доступ к сети (код ответа)"
for u in https://registry.npmjs.org/ https://pypi.org/simple/ https://api.githubcopilot.com/mcp/ https://mcp.vercel.com https://mcp.render.com/mcp https://mcp.neon.tech/mcp https://github.com; do
  printf '%s -> ' "$u"; curl -s -o /dev/null -m 15 -w '%{http_code}\n' "$u" || echo "НЕТ ОТВЕТА"
done
