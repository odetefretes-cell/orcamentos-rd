#!/usr/bin/env bash
# ============================================================================
#  Migração Hostinger — HOSPEDAGEM COMPLETA no Caddy (sem Firebase Hosting).
#  Configura DOIS domínios com HTTPS automático:
#    • sistema.obstransportes.com.br  → serve o APP (index.html estático em /opt/obs-app)
#    • api.obstransportes.com.br       → API (127.0.0.1:3000) + webhook da automação
#                                         (/webhook/* → 127.0.0.1:3001)
#
#  PRÉ-REQUISITO (DNS): os DOIS domínios devem apontar (registro A) para o IP
#  desta VPS. sistema.* hoje aponta pro Firebase (CNAME) — troque para A → IP daqui.
#  (Deixe o TTL baixo antes, pra propagar rápido; rollback = voltar o DNS pro Firebase.)
#
#  Rodar como root:  bash setup-hosting.sh
# ============================================================================
set -euo pipefail

APP_DOMINIO="${APP_DOMINIO:-sistema.obstransportes.com.br}"
API_DOMINIO="${API_DOMINIO:-api.obstransportes.com.br}"
API_ALVO="127.0.0.1:3000"
AUTOMACAO_ALVO="127.0.0.1:3001"
APP_DIR="/opt/obs-app"

echo "==> Hospedagem: app=$APP_DOMINIO  api=$API_DOMINIO"

# 1) Caddy instalado?
if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Instalando o Caddy..."
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y >/dev/null && apt-get install -y caddy >/dev/null
else
  echo "==> Caddy já instalado."
fi

# 2) Pasta do app
mkdir -p "$APP_DIR"

# 3) Caddyfile com os dois domínios
cat > /etc/caddy/Caddyfile <<EOF
# ---- APP (sistema) — arquivo estático servido pela VPS ----
$APP_DOMINIO {
    encode gzip
    root * $APP_DIR
    try_files {path} /index.html
    file_server
}

# ---- API + WEBHOOK da automação ----
$API_DOMINIO {
    encode gzip
    # webhook do ChatGuru e endpoints da automação → serviço obs-automacao (3001)
    handle_path /webhook/* {
        reverse_proxy $AUTOMACAO_ALVO
    }
    # todo o resto → API principal (3000)
    handle {
        reverse_proxy $API_ALVO
    }
}
EOF
echo "==> /etc/caddy/Caddyfile escrito (app + api + webhook)."

# 4) Firewall
if command -v ufw >/dev/null 2>&1 && ufw status | grep -qi active; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
fi

# 5) Recarrega o Caddy
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
sleep 2
systemctl --no-pager --lines=0 status caddy | head -n 3 || true

echo ""
echo "==> Agora publique o app:  bash deploy-app.sh"
echo "==> Teste:  curl -s https://$API_DOMINIO/api/health   e abra https://$APP_DOMINIO"
