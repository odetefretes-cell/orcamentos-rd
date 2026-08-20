#!/usr/bin/env bash
# ============================================================================
#  Publica/atualiza a INTEGRAÇÃO CONTA AZUL no Hostinger (serviço obs-contaazul).
#  Backend Node (Express + SQLite) que registra vendas e lança despesas no
#  Conta Azul Pro pelos botões do sistema OBS.
#
#  Porta 3002 (3000 = obs-api, 3001 = obs-automacao). Roda como obsrobo no PM2,
#  atrás do Caddy em https://contaazul.obstransportes.com.br.
#
#  Pré-requisitos:
#    - DNS: contaazul.obstransportes.com.br → A → IP da VPS (187.127.53.211).
#    - /opt/obs-contaazul/.env preenchido (ver contaazul/.env.example):
#        PORT=3002, OBS_SHARED_SECRET, CA_CLIENT_ID/SECRET, CA_REDIRECT_URI,
#        DB_PATH=/opt/obs-contaazul/data/obs-ca.db, OBS_ORIGIN, nomes de serviço...
#
#  Rodar como root na VPS:  bash deploy-contaazul.sh
# ============================================================================
set -euo pipefail

REPO="${REPO:-$HOME/obs-repo}"
BRANCH="${BRANCH:-obs-servidor-bootstrap}"
DEST="/opt/obs-contaazul"

[ -d "$REPO/.git" ] || { echo "ERRO: repositório não encontrado em $REPO (defina REPO=...)"; exit 1; }

echo "==> Ferramentas de build (better-sqlite3 compila código nativo) ..."
apt-get install -y build-essential python3 >/dev/null 2>&1 || echo "AVISO: apt build-essential/python3 falhou — se o npm quebrar, instale à mão."

echo "==> Baixando o código de $BRANCH ..."
cd "$REPO"
git fetch origin "$BRANCH:refs/remotes/origin/$BRANCH"

echo "==> Extraindo contaazul/ para $DEST (preserva .env e data/) ..."
mkdir -p "$DEST/data"
# git archive traz os arquivos com o prefixo contaazul/ → --strip-components=1 remove
git archive "origin/$BRANCH" contaazul | tar -x --strip-components=1 -C "$DEST"

echo "==> Instalando dependências (produção) ..."
cd "$DEST"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev

if [ ! -f "$DEST/.env" ]; then
  echo ""
  echo "!!  Falta o $DEST/.env — crie a partir de contaazul/.env.example ANTES de subir."
  echo "!!  Lembre: PORT=3002 e DB_PATH=$DEST/data/obs-ca.db"
  echo ""
fi

echo "==> Subindo/atualizando obs-contaazul no PM2 (como obsrobo) ..."
chown -R obsrobo:obsrobo "$DEST"
su - obsrobo -c "cd $DEST && pm2 delete obs-contaazul 2>/dev/null; pm2 start src/server.js --name obs-contaazul --time --max-memory-restart 300M"
su - obsrobo -c "pm2 save" || true

echo ""
echo "==> Pronto. Teste local:  curl -s http://127.0.0.1:3002/health"
echo "==> Externo (após Caddy):  https://contaazul.obstransportes.com.br/health"
echo "==> Conectar o Conta Azul (1x): abra no navegador  https://contaazul.obstransportes.com.br/oauth/start"
