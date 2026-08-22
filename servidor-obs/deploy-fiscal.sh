#!/usr/bin/env bash
# ============================================================================
#  Publica/atualiza o MÓDULO FISCAL (obs-fiscal) no Hostinger.
#  CT-e/MDF-e via Focus NFe + averbação. Porta 3003, systemd, como obsrobo.
#
#  Pré-requisito: /etc/obs-fiscal/.env (ver fiscal/.env.example).
#  Sem FOCUS_TOKEN o serviço roda em MODO PREVIEW (monta o JSON, não emite).
#
#  Rodar como root na VPS:  bash deploy-fiscal.sh
# ============================================================================
set -euo pipefail

REPO="${REPO:-$HOME/obs-repo}"
BRANCH="${BRANCH:-obs-servidor-bootstrap}"
DEST="/opt/obs-fiscal"

[ -d "$REPO/.git" ] || { echo "ERRO: repositório não encontrado em $REPO (defina REPO=...)"; exit 1; }

echo "==> Baixando o código de $BRANCH ..."
cd "$REPO"
git fetch origin "$BRANCH:refs/remotes/origin/$BRANCH"

echo "==> Extraindo fiscal/ para $DEST (preserva .env) ..."
mkdir -p "$DEST"
git archive "origin/$BRANCH" fiscal | tar -x --strip-components=1 -C "$DEST"

echo "==> Instalando dependências (produção) ..."
cd "$DEST"
npm install --omit=dev --no-audit --no-fund

if [ ! -f /etc/obs-fiscal/.env ]; then
  mkdir -p /etc/obs-fiscal
  cp -n "$DEST/.env.example" /etc/obs-fiscal/.env
  # herda o segredo compartilhado dos outros serviços
  if grep -q '^OBS_SHARED_SECRET=$' /etc/obs-fiscal/.env && grep -q '^OBS_SHARED_SECRET=' /opt/obs-contaazul/.env 2>/dev/null; then
    SEG=$(grep '^OBS_SHARED_SECRET=' /opt/obs-contaazul/.env | head -1)
    sed -i "s|^OBS_SHARED_SECRET=$|$SEG|" /etc/obs-fiscal/.env
  fi
  echo "!!  Criei /etc/obs-fiscal/.env a partir do exemplo — preencher FOCUS_TOKEN/EMIT_*/FISCAL_* na Fase 0/1."
fi

echo "==> Subindo/atualizando obs-fiscal via SYSTEMD (como obsrobo) ..."
chown -R obsrobo:obsrobo "$DEST"
NODE_BIN="$(su - obsrobo -c 'command -v node' 2>/dev/null)"
cat > /etc/systemd/system/obs-fiscal.service <<UNIT
[Unit]
Description=OBS - Modulo Fiscal (CT-e/MDF-e/averbacao)
After=network.target postgresql.service

[Service]
Type=simple
User=obsrobo
WorkingDirectory=$DEST
ExecStart=$NODE_BIN $DEST/src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now obs-fiscal
systemctl restart obs-fiscal

echo ""
echo "==> Pronto. Teste:  curl -s http://127.0.0.1:3003/health"
echo "==> Preview de um CT-e (não emite):  via obs-api → GET /api/fiscal/cte/preview?frete=NUMERO"
