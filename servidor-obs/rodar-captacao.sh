#!/usr/bin/env bash
# Roda a captação (respeita o DRY_RUN do /etc/obs-robo/.env) e guarda no log.
# Chamado pelo cron a cada ~15 min. Um trava (flock) evita duas rodadas juntas.
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
export PATH=/usr/local/bin:/usr/bin:/bin
cd /opt/obs-robo || exit 1
mkdir -p logs
exec 9>/tmp/obs-captar.lock
flock -n 9 || { echo "$(date '+%F %T') — já havia uma rodada em andamento, pulei." >> logs/captar.log; exit 0; }
{
  echo "===== $(date '+%F %T') ====="
  node captar-leads.mjs
  echo ""
} >> logs/captar.log 2>&1
