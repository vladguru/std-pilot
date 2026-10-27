#!/usr/bin/env bash
# Минимальный скрипт подготовки облачной среды для плана 2 (полный шаблон — план 4).
# Идемпотентен, всегда завершается с кодом 0; итог пишет в /tmp/std-cloud-setup.log.
set -u
LOG=/tmp/std-cloud-setup.log
: > "$LOG"
say() { echo "$*" | tee -a "$LOG"; }

say "== cloud-setup: начало $(date -u +%FT%TZ)"
SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

if command -v psql >/dev/null 2>&1 && command -v pg_ctlcluster >/dev/null 2>&1; then
  say "postgresql: уже установлен"
else
  say "postgresql: установка через apt"
  { $SUDO apt-get update -y && DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y postgresql postgresql-client; } >>"$LOG" 2>&1 \
    && say "postgresql: установлен" || say "postgresql: ОШИБКА установки (см. $LOG)"
fi

for tool in node npm npx uv uvx go python3 git gh psql; do
  if command -v "$tool" >/dev/null 2>&1; then say "версия $tool: $("$tool" --version 2>&1 | head -1)"; else say "версия $tool: НЕТ"; fi
done
say "== cloud-setup: конец"
exit 0
