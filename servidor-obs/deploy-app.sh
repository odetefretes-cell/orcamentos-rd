#!/usr/bin/env bash
# ============================================================================
#  Publica o APP (index.html) no Hostinger — substitui o deploy do Firebase.
#  Puxa o index.html da branch do app e coloca em /opt/obs-app/index.html.
#  Rodar na VPS (como root ou obsrobo com permissão em /opt/obs-app):
#      bash deploy-app.sh
#  Branch de origem configurável em BRANCH (padrão: a branch do app).
# ============================================================================
set -euo pipefail

REPO="${REPO:-$HOME/obs-repo}"
BRANCH="${BRANCH:-claude/automate-transport-contract-form-tgvad2}"
APP_DIR="/opt/obs-app"

[ -d "$REPO/.git" ] || { echo "ERRO: repositório não encontrado em $REPO (defina REPO=...)"; exit 1; }
mkdir -p "$APP_DIR"

echo "==> Atualizando o app de $BRANCH ..."
cd "$REPO"
git fetch origin "$BRANCH"
git show "origin/$BRANCH:index.html" > "$APP_DIR/index.html"
# assets locais que o app ainda referencia (se existirem na branch)
for f in logo.svg tabela-fretes.json cidades-coords.json; do
  git show "origin/$BRANCH:$f" > "$APP_DIR/$f" 2>/dev/null || true
done
chmod -R a+r "$APP_DIR"

echo "==> Publicado em $APP_DIR:"
ls -la "$APP_DIR" | sed -n '1,8p'
echo "==> Pronto. Recarregue o app (Ctrl+Shift+R) para pegar a versão nova."
