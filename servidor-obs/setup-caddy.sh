#!/usr/bin/env bash
# ============================================================================
#  Fase 3 — expõe a API da OBS na internet com HTTPS, via Caddy.
#  O Caddy pega o certificado SSL (Let's Encrypt) sozinho e faz proxy pra
#  API local (127.0.0.1:3000). Endereço: api.obstransportes.com.br
#
#  PRÉ-REQUISITO: o DNS de api.obstransportes.com.br já deve apontar (registro
#  A) para o IP deste servidor. Sem isso, o Caddy não consegue o certificado.
#
#  Rodar como root:  bash setup-caddy.sh
# ============================================================================
set -euo pipefail

DOMINIO="${1:-api.obstransportes.com.br}"
ALVO="127.0.0.1:3000"

echo "==> Fase 3 — HTTPS para $DOMINIO  ->  $ALVO"

# 1) Instala o Caddy (repositório oficial), se ainda não tiver
if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Instalando o Caddy..."
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y >/dev/null
  apt-get install -y caddy >/dev/null
else
  echo "==> Caddy já instalado."
fi

# 2) Configuração: proxy reverso com HTTPS automático
cat > /etc/caddy/Caddyfile <<EOF
$DOMINIO {
    encode gzip
    # página de teste (estática) — separada da produção
    @teste path /teste /teste.html
    handle @teste {
        root * /opt/obs-api/publico
        try_files /teste.html
        file_server
    }
    # cópia de teste do SISTEMA (index.html + ponte para a API) — modo teste
    @app path /app /app.html
    handle @app {
        root * /opt/obs-api/publico
        try_files /app.html
        file_server
    }
    # todo o resto vai pra API
    handle {
        reverse_proxy $ALVO
    }
}
EOF
echo "==> /etc/caddy/Caddyfile escrito."

# 3) Libera as portas 80/443 no firewall (se o ufw estiver ativo)
if command -v ufw >/dev/null 2>&1 && ufw status | grep -qi active; then
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  echo "==> Portas 80/443 liberadas no ufw."
fi

# 4) Recarrega o Caddy (ele valida o Caddyfile e busca o certificado)
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
sleep 2
systemctl --no-pager --lines=0 status caddy | head -n 3 || true

echo ""
echo "==> Pronto. O Caddy vai emitir o certificado no primeiro acesso (pode levar ~30s)."
echo "==> Teste:  curl -s https://$DOMINIO/api/health"
