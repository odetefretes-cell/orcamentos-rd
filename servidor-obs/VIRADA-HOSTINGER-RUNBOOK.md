# Virada 100% Hostinger — Roteiro (runbook)

Objetivo: sair 100% do Firebase/Cloud. App, dados, login e automação no Hostinger.
Cada passo tem **rollback**. Fazer fora do horário de pico. Ordem: servidor → app →
hospedagem → (dados) → automação. Os 4 primeiros são baixo/médio risco; a automação
é o passo sensível (fazer com lead de teste + rollback do webhook).

Branches: **app** = `claude/automate-transport-contract-form-tgvad2` · **servidor/automação** = na VPS via `~/obs-repo` (bootstrap p/ o servidor; a automação usa `integracao/`).

---

## 0. Preparação (pode ser antes)
- **DNS**: baixar o TTL de `sistema.obstransportes.com.br` (hoje CNAME do Firebase). Na virada, trocar para **registro A → IP da VPS**. Rollback = voltar o CNAME do Firebase.
- **Segredo do login**: gerar e gravar `SESSION_SECRET` no `/etc/obs-db/.env` da VPS (ex.: `openssl rand -hex 32`). Sem ele o `/api/login` fica desligado.
- **Segredos da automação** no `.env` da VPS: `ANTHROPIC_API_KEY`, `CHATGURU_API_KEY/ACCOUNT_ID/PHONE_ID`, `OBS_API_URL`, `OBS_API_TOKEN`, `OBS_USAR_PG=true`.

## 1. Servidor (API) — login próprio + delta + schema
```
cd ~/obs-repo && git fetch origin obs-servidor-bootstrap && git reset --hard origin/obs-servidor-bootstrap
cp -f ~/obs-repo/servidor-obs/api/server.mjs /opt/obs-api/server.mjs
su - obsrobo -c 'pm2 restart obs-api'
```
No boot ele cria sozinho: índices `updated_at`, trigger, tabelas `usuarios`, `deletions`,
`crm_leads_intake`, `chatguru_webhook_log`. Testar: `curl -s https://api.obstransportes.com.br/api/health`.
**Rollback**: `git checkout <commit anterior> -- server.mjs` + `pm2 restart obs-api` (o schema novo é aditivo, não atrapalha o antigo).

## 2. Usuários do login próprio
```
cp -f ~/obs-repo/servidor-obs/seed-usuarios.mjs /opt/obs-api/ && cd /opt/obs-api && node seed-usuarios.mjs
```
Anota as senhas impressas e entrega a cada pessoa. (Admin entra com `atendimento@obstransportes.com.br`.)

## 3. Dados de hoje: Firestore → PostgreSQL (re-sync fresco, ANTES de virar o app)
```
cp -f ~/obs-repo/servidor-obs/copiar-para-postgres.mjs /opt/obs-api/ && cd /opt/obs-api && node copiar-para-postgres.mjs
```
Traz pro PostgreSQL tudo que a equipe fez no Firebase até agora. (Enquanto o app ainda
está no Firebase, ninguém para.)

## 4. Hospedagem do app no Caddy + publicar o app
```
cp -f ~/obs-repo/servidor-obs/setup-hosting.sh ~/obs-repo/servidor-obs/deploy-app.sh /opt/obs-api/ 2>/dev/null || true
bash ~/obs-repo/servidor-obs/setup-hosting.sh
bash ~/obs-repo/servidor-obs/deploy-app.sh
```
Depois trocar o **DNS** de `sistema.*` para o IP da VPS (Passo 0). O Caddy emite o SSL sozinho.
**Rollback**: voltar o DNS pro Firebase Hosting (o app do Firebase continua publicado como está).

## 5. Testar o app no Hostinger (antes de liberar a equipe)
- Abrir `https://sistema.obstransportes.com.br`, **login próprio** (e-mail+senha).
- Salvar um lead, **F5** → continua. Mover card → continua.
- 2 pessoas editando o MESMO lead (campos diferentes) → **as duas** persistem.
- Ver que a tela atualiza sozinha (delta) sem travar.

## 6. Automação no Hostinger (passo sensível — lead de teste + rollback)
> Enquanto não virar, a automação segue no atual (ou desligada). O robô de envio já
> está com as correções (não manda pra atendido, não duplica).
- Subir o serviço `obs-automacao` (PM2) e apontar o **webhook do ChatGuru** para
  `https://api.obstransportes.com.br/webhook/chatguru`.
- Disparar **1 lead de teste** pelo WhatsApp e conferir: cria no CRM, calcula a média,
  e (com `envioAtivo=true`) envia **uma vez**, **não** para quem já tem atendente.
- **Rollback (1 min)**: voltar a URL do webhook do ChatGuru para a Cloud Function atual.

## Kill-switch de envio
`crm_config/config.envioAtivo = false` (no PostgreSQL) desliga TODO envio automático,
em qualquer modo. Ligar só depois de validar.

## Rollback geral (voltar tudo pro Firebase)
1. DNS de `sistema.*` → Firebase Hosting.
2. App do Firebase já está publicado (`main`, `OBS_USAR_API_PADRAO=false`).
3. Webhook do ChatGuru → Cloud Function.
Os dados de hoje ficam nos dois lados enquanto durar a validação (sincronizados nos passos 3).
