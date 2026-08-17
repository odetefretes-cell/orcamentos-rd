#!/usr/bin/env bash
# ============================================================================
#  OBS Transportes - Setup do servidor do robo de rotinas (VPS Ubuntu)
#  Instala: Node 20 LTS, PM2, Playwright + Chromium headless (com libs do S.O.)
#  Cria: usuario dedicado 'obsrobo', pasta /opt/obs-robo, /etc/obs-robo/.env
#
#  NAO instala nada relacionado ao Firebase Cloud Functions.
#  NAO contem nenhum segredo. Segredos vao SO no /etc/obs-robo/.env (chmod 600).
#
#  Como rodar (como root no VPS):
#     bash setup.sh
# ============================================================================
set -euo pipefail

APP_USER="obsrobo"
APP_DIR="/opt/obs-robo"
ENV_DIR="/etc/obs-robo"
ENV_FILE="$ENV_DIR/.env"
NODE_MAJOR="20"

# ---------- helpers ----------
c_ok()   { printf '\033[32m  OK  \033[0m %s\n' "$1"; }
c_info() { printf '\033[36m INFO \033[0m %s\n' "$1"; }
c_warn() { printf '\033[33m AVISO\033[0m %s\n' "$1"; }
c_err()  { printf '\033[31m ERRO \033[0m %s\n' "$1"; }
step()   { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  c_err "Rode como root:  sudo bash setup.sh"
  exit 1
fi

# ---------- 0. Diagnostico do ambiente ----------
step "0. Diagnostico do servidor"
. /etc/os-release 2>/dev/null || true
echo "  Sistema...: ${PRETTY_NAME:-desconhecido}"
echo "  Kernel....: $(uname -r)"
echo "  Arquitet..: $(uname -m)"
echo "  CPUs......: $(nproc)"
echo "  RAM.......: $(free -h | awk '/^Mem:/{print $2" total / "$7" disponivel"}')"
echo "  Disco (/).: $(df -h / | awk 'NR==2{print $4" livre de "$2}')"
echo "  Root/sudo.: sim"
if systemctl is-system-running >/dev/null 2>&1 || [ -d /run/systemd/system ]; then
  c_ok "systemd presente -> PM2 pode subir no boot (processo continuo permitido)"
else
  c_warn "systemd nao detectado. PM2 funciona, mas 'pm2 startup' pode falhar."
fi

AVAIL_KB=$(df -Pk / | awk 'NR==2{print $4}')
if [ "$AVAIL_KB" -lt 3000000 ]; then
  c_warn "Menos de ~3 GB livres. Playwright + Chromium precisam de ~1,5 GB. Libere espaco."
fi

# ---------- 1. Pacotes base + timezone ----------
step "1. Pacotes base do sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git build-essential unzip \
  fonts-liberation fonts-noto-color-emoji tzdata >/dev/null
timedatectl set-timezone America/Sao_Paulo 2>/dev/null || ln -sf /usr/share/zoneinfo/America/Sao_Paulo /etc/localtime
c_ok "Pacotes base instalados. Timezone: $(date '+%Z %:z')"

# ---------- 2. Node.js 20 LTS ----------
step "2. Node.js ${NODE_MAJOR} LTS"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  CUR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
  echo "  Node ja instalado: $(node -v)"
  [ "$CUR" -ge "$NODE_MAJOR" ] && NEED_NODE=0
fi
if [ "$NEED_NODE" -eq 1 ]; then
  c_info "Instalando Node ${NODE_MAJOR} via NodeSource..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
c_ok "Node $(node -v) / npm $(npm -v)"

# ---------- 3. PM2 ----------
step "3. PM2 (gerenciador de processo)"
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2@latest >/dev/null 2>&1
fi
c_ok "PM2 $(pm2 -v)"

# ---------- 4. Usuario dedicado + pastas ----------
step "4. Usuario dedicado e pastas"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$APP_USER"
  c_ok "Usuario '$APP_USER' criado (sem sudo, sem senha de login)"
else
  c_ok "Usuario '$APP_USER' ja existe"
fi
mkdir -p "$APP_DIR" "$ENV_DIR" "$APP_DIR/logs" "$APP_DIR/estado"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chown root:"$APP_USER" "$ENV_DIR"; chmod 750 "$ENV_DIR"
c_ok "Pastas: $APP_DIR (app)  |  $ENV_DIR (segredos, fora do repo)"

# ---------- 5. Bibliotecas de sistema do Chromium ----------
step "5. Bibliotecas de sistema do Chromium (Playwright --with-deps)"
c_info "Isso baixa ~200-400 MB de libs. Pode levar alguns minutos."
if npx --yes playwright@latest install-deps chromium >/tmp/pw-deps.log 2>&1; then
  c_ok "Libs do sistema instaladas (via playwright install-deps)"
else
  c_warn "playwright install-deps falhou. Tentando lista manual de libs..."
  apt-get install -y -qq \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 >/dev/null 2>&1 \
    || apt-get install -y -qq libasound2t64 >/dev/null 2>&1 || true
  c_ok "Libs instaladas pela lista manual (ver /tmp/pw-deps.log se der erro depois)"
fi

# ---------- 6. App: package.json + Playwright/Chromium + firebase-admin ----------
step "6. Dependencias do app (Playwright + Chromium + firebase-admin)"
# Navegadores num caminho compartilhado (nao no /root), para o usuario obsrobo achar
PW_PATH="/opt/pw-browsers"
mkdir -p "$PW_PATH"; chown -R "$APP_USER:$APP_USER" "$PW_PATH"
grep -q PLAYWRIGHT_BROWSERS_PATH /etc/environment 2>/dev/null || \
  echo "PLAYWRIGHT_BROWSERS_PATH=$PW_PATH" >> /etc/environment

if [ ! -f "$APP_DIR/package.json" ]; then
  cat > "$APP_DIR/package.json" <<'JSON'
{
  "name": "obs-robo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Robo de rotinas da OBS Transportes (ChatGuru + CRM) - roda no servidor",
  "scripts": {
    "teste-ambiente": "node test-ambiente.mjs",
    "start": "node index.mjs"
  },
  "dependencies": {
    "playwright": "^1.48.0",
    "firebase-admin": "^12.6.0",
    "dotenv": "^16.4.5"
  }
}
JSON
  chown "$APP_USER:$APP_USER" "$APP_DIR/package.json"
  c_ok "package.json inicial criado"
else
  c_ok "package.json ja existe (mantido)"
fi

c_info "Instalando dependencias npm como '$APP_USER'..."
sudo -u "$APP_USER" -H bash -lc "cd $APP_DIR && PLAYWRIGHT_BROWSERS_PATH=$PW_PATH npm install --no-audit --no-fund" \
  || { c_err "npm install falhou"; exit 1; }

c_info "Baixando o Chromium do Playwright (~150-300 MB)..."
sudo -u "$APP_USER" -H bash -lc "cd $APP_DIR && PLAYWRIGHT_BROWSERS_PATH=$PW_PATH npx playwright install chromium" \
  || { c_err "download do Chromium falhou"; exit 1; }
c_ok "Chromium instalado em $PW_PATH"

# ---------- 7. Arquivo de segredos ----------
step "7. Arquivo de variaveis de ambiente (segredos)"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'ENVEOF'
# ===========================================================================
#  SEGREDOS DO ROBO DA OBS - /etc/obs-robo/.env
#  NUNCA versionar este arquivo. Permissao 600, dono root:obsrobo.
#  Preencha os valores DEPOIS do = , sem espacos e sem aspas.
# ===========================================================================

# --- modo de operacao ---
# true  = SO LOGA o que faria (nao envia nada, nao grava nada). Comece sempre assim.
# false = executa de verdade.
DRY_RUN=true
TZ=America/Sao_Paulo

# --- Firebase (conta de servico do projeto obs-fretes) ---
# Cole o JSON convertido em base64 (recomendado, evita problema de quebra de linha):
#   cat chave.json | base64 -w0
FIREBASE_SERVICE_ACCOUNT_BASE64=
# (alternativa) JSON em uma unica linha:
FIREBASE_SERVICE_ACCOUNT=
FIREBASE_PROJECT_ID=obs-fretes

# --- ChatGuru API ---
CHATGURU_API_URL=https://s22.chatguru.app/api/v1
CHATGURU_API_KEY=
CHATGURU_ACCOUNT_ID=
CHATGURU_PHONE_ID=

# --- ChatGuru login (usuario DEDICADO do robo, nao de operador) ---
CHATGURU_LOGIN_URL=https://s22.chatguru.app/login
CHATGURU_LOGIN_USER=
CHATGURU_LOGIN_PASS=

# --- Anthropic ---
ANTHROPIC_API_KEY=
ENVEOF
  chown root:"$APP_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
  c_ok "Criado $ENV_FILE (modelo em branco). PREENCHA-O agora: nano $ENV_FILE"
else
  c_ok "$ENV_FILE ja existe (nao foi sobrescrito)"
fi
ln -sfn "$ENV_FILE" "$APP_DIR/.env"
chown -h "$APP_USER:$APP_USER" "$APP_DIR/.env"

# ---------- 8. PM2 no boot ----------
step "8. PM2 iniciando junto com o servidor"
if pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/tmp/pm2-startup.log 2>&1; then
  c_ok "PM2 configurado para subir no boot (usuario $APP_USER)"
else
  c_warn "Nao consegui configurar o boot automatico. Veja /tmp/pm2-startup.log"
fi

# ---------- resumo ----------
step "RESUMO"
printf '  %-34s %s\n' "Sistema"              "${PRETTY_NAME:-?}"
printf '  %-34s %s\n' "Node"                 "$(node -v)"
printf '  %-34s %s\n' "npm"                  "$(npm -v)"
printf '  %-34s %s\n' "PM2"                  "$(pm2 -v)"
printf '  %-34s %s\n' "Playwright (npm)"     "$(sudo -u $APP_USER -H bash -lc "cd $APP_DIR && node -e \"import('playwright/package.json').then(m=>console.log(m.default.version))\"" 2>/dev/null || echo '?')"
printf '  %-34s %s\n' "Chromium (Playwright)" "$(ls -d $PW_PATH/chromium-* 2>/dev/null | head -1 || echo 'NAO ENCONTRADO')"
printf '  %-34s %s\n' "Pasta do app"          "$APP_DIR"
printf '  %-34s %s\n' "Arquivo de segredos"   "$ENV_FILE ($(stat -c '%a %U:%G' $ENV_FILE))"
printf '  %-34s %s\n' "Usuario do robo"       "$APP_USER"

cat <<'FIM'

--------------------------------------------------------------------
PROXIMOS PASSOS (nesta ordem):

  1) Preencher os segredos:
        sudo nano /etc/obs-robo/.env

     Para a chave do Firebase, suba o JSON para o servidor e rode:
        sudo bash -c 'echo "FIREBASE_SERVICE_ACCOUNT_BASE64=$(base64 -w0 /caminho/chave.json)" >> /etc/obs-robo/.env'
        shred -u /caminho/chave.json     # apaga o JSON depois de converter

  2) Copiar o test-ambiente.mjs para /opt/obs-robo/ e rodar o teste:
        sudo cp test-ambiente.mjs /opt/obs-robo/
        sudo chown obsrobo:obsrobo /opt/obs-robo/test-ambiente.mjs
        sudo -u obsrobo -H bash -lc 'cd /opt/obs-robo && node test-ambiente.mjs'

  3) Mandar a saida do teste para o Claude (ela NAO imprime segredos).
--------------------------------------------------------------------
FIM
