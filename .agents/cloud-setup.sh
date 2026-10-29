#!/usr/bin/env bash
# Подготовка облачной среды (Claude Code и Codex): общий скрипт стандарта (спека, п. 5 «Окружение»).
# Файл принадлежит стандарту: sync возвращает его к версии стандарта. Дополнения проекта — в .agents/cloud-setup.local.sh.
#
# Идемпотентен и всегда завершается с кодом 0: сбой шага записывается в журнал и в итоговую сводку, среда остаётся рабочей.
# Не предполагает ни Ubuntu, ни root: привилегированные шаги (apt) выполняются только при root или sudo без пароля.
# Нужные сетевые адреса — .agents/cloud-network.md. Журнал — /tmp/std-cloud-setup.log.
#
# Переменные: STD_SETUP_LOG — путь журнала; STD_SETUP_DRY_RUN=1 — вывести шаги, ничего не выполняя.
# Параметры профиля читаются из AGENTS.md: «База данных», «Интерфейс».

set -u

SERENA_VERSION=2.1.0
PLAYWRIGHT_VERSION=1.64.1
AGENT_BROWSER_VERSION=0.40.0

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 0

LOG="${STD_SETUP_LOG:-/tmp/std-cloud-setup.log}"
DRY="${STD_SETUP_DRY_RUN:-0}"
FAILED=""
export MISE_YES=1
export DO_NOT_TRACK=1
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"

say() { printf '[std-setup] %s\n' "$1"; printf '%s\n' "$1" >>"$LOG" 2>/dev/null; }

step() {
  name="$1"; shift
  say "шаг: $name"
  if [ "$DRY" = "1" ]; then return 0; fi
  if "$@" >>"$LOG" 2>&1; then say "готово: $name"; else FAILED="$FAILED $name"; say "сбой: $name (подробности в журнале $LOG)"; fi
}

# Значение параметра профиля из таблицы «Профиль» файла AGENTS.md.
profile() {
  awk -F'|' -v key="$1" '
    /^## Профиль/ { in_profile = 1; next }
    /^## / { in_profile = 0 }
    in_profile && NF > 2 {
      k = $2; v = $3
      gsub(/^[ \t`]+|[ \t`\r]+$/, "", k); gsub(/^[ \t`]+|[ \t`\r]+$/, "", v)
      if (k == key) { print v; exit }
    }' AGENTS.md 2>/dev/null
}

have() { command -v "$1" >/dev/null 2>&1; }

# Привилегии: root, sudo без пароля или их отсутствие.
if [ "$(id -u)" = "0" ]; then SUDO=""; PRIV=1
elif have sudo && sudo -n true 2>/dev/null; then SUDO="sudo"; PRIV=1
else SUDO=""; PRIV=0; fi

want_db=0; [ "$(profile 'База данных')" = "да" ] && want_db=1
want_ui=0; [ "$(profile 'Интерфейс')" = "да" ] && want_ui=1

: >>"$LOG" 2>/dev/null
say "профиль: база данных=$want_db, интерфейс=$want_ui; привилегии=$PRIV; журнал $LOG"

install_mise() {
  if have mise; then return 0; fi
  # The installer is downloaded to a file first: in a pipe the failure of curl would be hidden by the exit code of sh.
  installer="$(mktemp)"
  if have curl; then curl -fsSL https://mise.run -o "$installer"
  elif have wget; then wget -qO "$installer" https://mise.run
  else echo "нужен curl или wget"; return 1; fi || { rm -f "$installer"; return 1; }
  sh "$installer"; status=$?
  rm -f "$installer"
  [ "$status" = "0" ] || return "$status"
  line='export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"  # std-mise'
  for rc in "$HOME/.bashrc" "$HOME/.profile"; do
    grep -qs '# std-mise' "$rc" || printf '%s\n' "$line" >>"$rc"
  done
}

install_tools() {
  have mise || return 1
  [ -f .mise.toml ] || return 0
  mise trust --yes .mise.toml
  mise install --yes
}

start_postgres() {
  # Готовый кластер (образ Claude: PostgreSQL 16 установлен, не запущен) запускаем; нет сервера — ставим при привилегиях.
  if ! have pg_lsclusters && ! have psql; then
    [ "$PRIV" = "1" ] && have apt-get || { echo "PostgreSQL не установлен, а прав на apt-get нет"; return 1; }
    $SUDO apt-get update -qq
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql postgresql-client
  fi
  if have pg_lsclusters; then
    pg_lsclusters --no-header | while read -r version name _; do
      $SUDO pg_ctlcluster "$version" "$name" start 2>/dev/null || $SUDO service postgresql start || true
    done
  else
    $SUDO service postgresql start || true
  fi
  sleep 2
  as_postgres() { if [ -z "$SUDO" ] && [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else sudo -n -u postgres "$@"; fi; }
  as_postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='app'" | grep -q 1 \
    || as_postgres psql -c "CREATE ROLE app LOGIN PASSWORD 'app' CREATEDB"
  as_postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='app'" | grep -q 1 \
    || as_postgres psql -c "CREATE DATABASE app OWNER app"
}

warm_serena() {
  have uvx || return 1
  uvx --python 3.13 --from "serena-agent==$SERENA_VERSION" serena --help >/dev/null
}

install_playwright() {
  have npx || return 1
  # System libraries need privileges; the browser itself is installed for the current user (not into the home of root).
  if [ "$PRIV" = "1" ]; then
    $SUDO env "PATH=$PATH" npx --yes "playwright@$PLAYWRIGHT_VERSION" install-deps chromium
  fi
  npx --yes "playwright@$PLAYWRIGHT_VERSION" install chromium
}

install_agent_browser() {
  have npm || return 1
  npm install --global "agent-browser@$AGENT_BROWSER_VERSION"
  agent-browser install
}

install_project_deps() {
  [ -f Makefile ] || return 0
  have make || return 1
  make deps
}

run_local() {
  [ -f .agents/cloud-setup.local.sh ] || return 0
  bash .agents/cloud-setup.local.sh
}

step "mise" install_mise
step "версии из .mise.toml (Node, языки, инструменты)" install_tools
[ "$want_db" = "1" ] && step "PostgreSQL" start_postgres
step "Serena $SERENA_VERSION" warm_serena
if [ "$want_ui" = "1" ]; then
  step "браузеры Playwright $PLAYWRIGHT_VERSION" install_playwright
  step "agent-browser $AGENT_BROWSER_VERSION" install_agent_browser
fi
step "зависимости проекта (make deps)" install_project_deps
step "дополнения проекта (.agents/cloud-setup.local.sh)" run_local

if [ -n "$FAILED" ]; then say "готово с замечаниями; не выполнено:$FAILED"; else say "готово: все шаги выполнены"; fi
exit 0
