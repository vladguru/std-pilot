#!/usr/bin/env bash
# Plan 2 minimal cloud setup (full template: plan 4). ASCII only on purpose.
# Idempotent, always exits 0; log: /tmp/std-cloud-setup.log
LOG=/tmp/std-cloud-setup.log
echo "cloud-setup: start" > "$LOG"

SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

if command -v psql >/dev/null 2>&1 && command -v pg_ctlcluster >/dev/null 2>&1; then
  echo "postgresql: already installed" | tee -a "$LOG"
else
  echo "postgresql: installing via apt" | tee -a "$LOG"
  $SUDO apt-get update -y >>"$LOG" 2>&1
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y postgresql postgresql-client >>"$LOG" 2>&1
  echo "postgresql: apt exit code $?" | tee -a "$LOG"
fi

for tool in node npm npx uv uvx go python3 git gh psql; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "version $tool: $("$tool" --version 2>&1 | head -1)" | tee -a "$LOG"
  else
    echo "version $tool: MISSING" | tee -a "$LOG"
  fi
done
echo "cloud-setup: end" | tee -a "$LOG"
exit 0
