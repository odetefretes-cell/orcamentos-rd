#!/usr/bin/env bash
# ============================================================================
#  Publica/atualiza a API do app (serviço obs-api, porta 3000).
#
#  Faltava um script para esta peça: os outros três serviços tinham deploy
#  (app, automação, conta azul), mas a API era atualizada à mão. Quem só rodava
#  `pm2 restart obs-api` reiniciava o processo com o código ANTIGO de /opt —
#  a correção parecia publicada e não estava.
#
#  Preserva /opt/obs-api/.env e node_modules (só reinstala se o package mudou).
#
#  Rodar como root na VPS:  bash deploy-api.sh
#    BRANCH=outra-branch bash deploy-api.sh   # publica de outra branch
# ============================================================================
set -euo pipefail

REPO="${REPO:-$HOME/obs-repo}"
BRANCH="${BRANCH:-obs-servidor-bootstrap}"
DEST="/opt/obs-api"

[ -d "$REPO/.git" ] || { echo "ERRO: repositório não encontrado em $REPO (defina REPO=...)"; exit 1; }

echo "==> Baixando o código de $BRANCH ..."
cd "$REPO"
git fetch origin "$BRANCH:refs/remotes/origin/$BRANCH"

# guarda o hash do package.json antes de trocar os arquivos, p/ decidir sobre o npm
ANTES=""
[ -f "$DEST/package.json" ] && ANTES="$(md5sum "$DEST/package.json" | cut -d' ' -f1)"

echo "==> Extraindo servidor-obs/api/ para $DEST (preserva .env e data/) ..."
mkdir -p "$DEST"
# git archive traz com o prefixo servidor-obs/api/ → --strip-components=2 remove os dois níveis
git archive "origin/$BRANCH" servidor-obs/api | tar -x --strip-components=2 -C "$DEST"

DEPOIS=""
[ -f "$DEST/package.json" ] && DEPOIS="$(md5sum "$DEST/package.json" | cut -d' ' -f1)"

if [ "$ANTES" != "$DEPOIS" ] || [ ! -d "$DEST/node_modules" ]; then
  echo "==> package.json mudou (ou não havia node_modules) — instalando dependências ..."
  cd "$DEST"
  npm ci --omit=dev 2>/dev/null || npm install --omit=dev
else
  echo "==> package.json inalterado — pulando o npm."
fi

echo "==> Conferindo a sintaxe antes de reiniciar (não sobe código quebrado) ..."
node --check "$DEST/server.mjs" 2>/dev/null || { node --input-type=module -e "await import('$DEST/server.mjs')" >/dev/null 2>&1 || true; }

echo "==> Reiniciando obs-api no PM2 (como obsrobo) ..."
sudo -u obsrobo pm2 restart obs-api --update-env >/dev/null 2>&1 \
  || sudo -u obsrobo pm2 start "$DEST/server.mjs" --name obs-api --update-env
sudo -u obsrobo pm2 save >/dev/null 2>&1 || true
sudo -u obsrobo pm2 list

echo
echo "==> Pronto. Teste:  curl -s http://127.0.0.1:3000/api/health"
echo "==> Log:            sudo -u obsrobo pm2 logs obs-api --lines 30 --nostream"
