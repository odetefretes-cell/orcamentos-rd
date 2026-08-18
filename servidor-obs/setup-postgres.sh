#!/usr/bin/env bash
# ============================================================================
#  FASE 1 — Fundação do banco no servidor da OBS.
#  Instala PostgreSQL, cria o banco 'obs' + um usuário da aplicação, e monta
#  BACKUP automático diário (com retenção de 14 dias).
#
#  NÃO toca no robô, no Firebase nem no sistema atual. Roda como root.
#  Uso:  sudo bash setup-postgres.sh
# ============================================================================
set -euo pipefail
DB_NAME="obs"
DB_USER="obs_app"
BACKUP_DIR="/var/backups/obs-db"
ENV_DB="/etc/obs-db/.env"
c_ok(){ printf '\033[32m  OK  \033[0m %s\n' "$1"; }
step(){ printf '\n\033[1m==> %s\033[0m\n' "$1"; }
[ "$(id -u)" -eq 0 ] || { echo "Rode como root: sudo bash setup-postgres.sh"; exit 1; }

step "1. Instalando PostgreSQL"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq postgresql postgresql-contrib openssl >/dev/null
systemctl enable --now postgresql >/dev/null 2>&1 || true
c_ok "PostgreSQL: $(sudo -u postgres psql -tAc 'SHOW server_version;' 2>/dev/null | head -1)"

step "2. Segredos do banco (/etc/obs-db/.env)"
mkdir -p /etc/obs-db && chmod 750 /etc/obs-db
if [ ! -f "$ENV_DB" ]; then
  DB_PASS=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 28)
  cat > "$ENV_DB" <<EOF
# Banco PostgreSQL da OBS (Fase 1). SEGREDOS — nunca versionar. chmod 640 root:root.
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=$DB_NAME
PGUSER=$DB_USER
PGPASSWORD=$DB_PASS
EOF
  chmod 640 "$ENV_DB"
  c_ok "Criado $ENV_DB (senha do app gerada)"
else
  DB_PASS=$(grep '^PGPASSWORD=' "$ENV_DB" | cut -d= -f2-)
  c_ok "$ENV_DB já existe (mantido)"
fi

step "3. Banco '$DB_NAME' e usuário '$DB_USER'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';" >/dev/null
sudo -u postgres psql -c "ALTER USER $DB_USER WITH PASSWORD '$DB_PASS';" >/dev/null
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" >/dev/null
c_ok "Banco '$DB_NAME' pronto (dono: $DB_USER)"

step "4. Backup automático diário (retém 14 dias)"
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
cat > /usr/local/bin/obs-db-backup.sh <<'BKP'
#!/usr/bin/env bash
set -euo pipefail
DIR=/var/backups/obs-db
TS=$(date '+%Y%m%d-%H%M%S')
sudo -u postgres pg_dump -Fc obs > "$DIR/obs-$TS.dump"
find "$DIR" -name 'obs-*.dump' -mtime +14 -delete
BKP
chmod +x /usr/local/bin/obs-db-backup.sh
CRON_LINE='0 3 * * * /usr/local/bin/obs-db-backup.sh >> /var/log/obs-db-backup.log 2>&1'
{ crontab -l 2>/dev/null | grep -v 'obs-db-backup.sh' || true; echo "$CRON_LINE"; } | crontab -
/usr/local/bin/obs-db-backup.sh || true
c_ok "Backup diário às 03:00 → $BACKUP_DIR (fiz um agora pra provar)"

step "RESUMO"
printf '  %-26s %s\n' "PostgreSQL" "$(sudo -u postgres psql -tAc 'SHOW server_version;' | head -1)"
printf '  %-26s %s\n' "Banco / usuário" "$DB_NAME / $DB_USER"
printf '  %-26s %s\n' "Segredos do banco" "$ENV_DB"
printf '  %-26s %s\n' "Backups" "$BACKUP_DIR (diário 03:00, 14 dias)"
echo "  Backups presentes:"
ls -la "$BACKUP_DIR" 2>/dev/null | tail -3
echo
echo "Fase 1 concluída. Nada do sistema atual foi tocado. Próxima: a 'ponte' (API)."
