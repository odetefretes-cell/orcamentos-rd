#!/usr/bin/env bash
# ============================================================================
#  Publica/atualiza a AUTOMAÇÃO do WhatsApp no Hostinger (serviço obs-automacao),
#  substituindo as Cloud Functions. Roda o mesmo pipeline (integracao/) via
#  PostgreSQL + Express + cron (integracao/vps/).
#
#  Pré-requisitos:
#    - Node + PM2 instalados; API (obs-api) rodando; PostgreSQL no ar.
#    - /etc/obs-automacao/.env preenchido (ver integracao/vps/.env.example):
#        OBS_USAR_PG=true, OBS_API_URL, OBS_API_TOKEN, ANTHROPIC_API_KEY,
#        ANTHROPIC_MODEL, CHATGURU_API_KEY/ACCOUNT_ID/PHONE_ID, LIMITE_VALOR_HUMANO,
#        LEAD_JANELA_SEGUNDOS, MAX_PERGUNTAS, VENDEDORES, TELEFONE_OBS
#
#  Rodar na VPS:  bash deploy-automacao.sh
# ============================================================================
set -euo pipefail

REPO="${REPO:-$HOME/obs-repo}"
BRANCH="${BRANCH:-claude/automate-transport-contract-form-tgvad2}"
DEST="/opt/obs-automacao"

[ -d "$REPO/.git" ] || { echo "ERRO: repositório não encontrado em $REPO (defina REPO=...)"; exit 1; }
[ -f /etc/obs-automacao/.env ] || echo "AVISO: /etc/obs-automacao/.env não existe ainda — crie a partir de integracao/vps/.env.example antes de subir o serviço."

echo "==> Baixando a automação de $BRANCH ..."
cd "$REPO"
# cria/atualiza a ref origin/<branch> (o fetch simples não cria → git archive falharia)
git fetch origin "$BRANCH:refs/remotes/origin/$BRANCH"

echo "==> Extraindo integracao/ para $DEST (sem tocar no git) ..."
mkdir -p "$DEST"
rm -rf "$DEST/integracao"
git archive "origin/$BRANCH" integracao | tar -x -C "$DEST"

echo "==> Instalando dependências (integracao/vps) ..."
cd "$DEST/integracao/vps"
npm install --no-audit --no-fund

echo "==> Rodando o selftest (em memória, não toca em produção) ..."
node selftest.mjs | tail -4 || { echo "SELFTEST FALHOU — NÃO suba o serviço; me chame."; exit 1; }

echo "==> Subindo/atualizando o serviço obs-automacao no PM2 (como obsrobo) ..."
# Sobe o ORQUESTRADOR direto pelo nome (o PM2 não trata .cjs como config em pacote
# ESM; e o orquestrador já lê o .env de /etc/obs-automacao/.env sozinho).
su - obsrobo -c "cd $DEST/integracao/vps && pm2 delete obs-automacao 2>/dev/null; pm2 delete ecosystem.automacao 2>/dev/null; pm2 start orquestrador.js --name obs-automacao --time --max-memory-restart 400M"
su - obsrobo -c "pm2 save" || true

echo ""
echo "==> Pronto. Teste:  curl -s http://127.0.0.1:3001/webhook/health"
echo "==> Depois aponte o webhook do ChatGuru para: https://api.obstransportes.com.br/webhook/chatguru"
echo "==> VIRADA SEGURA: 1 lead de teste + rollback (voltar a URL do webhook pra Cloud Function)."
