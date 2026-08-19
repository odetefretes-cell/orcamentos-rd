# OBS Automação — versão STANDALONE (VPS Hostinger)

Roda **o mesmo pipeline** das Cloud Functions (webhook.js, chatguru-webhook.js,
claude-extrator.js, orcamento-resposta.js, precadastro.js, chatguru-api.js,
calc-fretes.js, pg-api.js) **sem alterá-los** — só troca a plataforma:

| Firebase | Aqui (VPS) |
|---|---|
| Cloud Functions HTTPS | **Express** em `127.0.0.1:3001` |
| Cloud Scheduler (1/min) | **node-cron** (TZ America/Sao_Paulo) |
| Gatilhos onDocumentUpdated do Firestore | **driver.js** encadeia os handlers na ordem |
| Firestore | **PostgreSQL** via a API do servidor (pg-api.js + pg-compat.js) |
| `require('firebase-functions/*')` / `firebase-admin/*` | **stubs vendorizados** em `stubs/` |

Nada do pipeline muda: os arquivos em `integracao/` seguem byte-idênticos e
servem de **rollback** para as Cloud Functions.

## Como os requires resolvem

`orquestrador.js` coloca `./stubs` e `./node_modules` no `NODE_PATH` e chama
`Module._initPaths()` **antes** de `require('../webhook.js')`. Então:

- `firebase-functions/v2/{https,scheduler,firestore}` → devolvem o **handler cru**
  (não registram gatilho); o Express/cron/driver os chamam direto.
- `firebase-admin/app` → `initializeApp()` no-op.
- `firebase-admin/firestore` → `getFirestore()`/`FieldValue` da **pg-compat.js**
  (grava no PostgreSQL via a API).
- `@anthropic-ai/sdk` → dependência normal em `node_modules`, achada via NODE_PATH.

## A cadeia de gatilhos (driver.js)

A cada minuto o cron chama `drivePipelineOnce()`:

1. `fecharLeadsCompletos()` — fecha os intakes parados > 60s (`statusIntake='completo'`).
2. para cada intake `completo` e `!iaProcessado` → `processarLeadCompleto(event)` (IA extrai + decide).
3. para cada intake `automatico`/`aguardando_humano` e `!leadCriado` → `criarLeadNoCrm(event)` (cria o lead + calcula a média no backend).
4. `enviarPendentesPG()` — manda a média / o aviso humano pendentes (trava atômica `/claim`).

Os handlers são **idempotentes** (guards `iaProcessado`, `leadCriado`,
`respostaEnviada`/claim), então re-execuções não duplicam nada.

## Deploy

```bash
# 1) dependências
cd integracao/vps
npm install

# 2) variáveis de ambiente (arquivo protegido, fora do repo)
sudo mkdir -p /etc/obs-automacao /var/log/obs-automacao
sudo cp .env.example /etc/obs-automacao/.env   # e edite os valores reais
sudo chmod 600 /etc/obs-automacao/.env

# 3) sobe com PM2
pm2 start ecosystem.automacao.cjs
pm2 save
pm2 logs obs-automacao

# health
curl -s http://127.0.0.1:3001/webhook/health
```

Aponte o Nginx (ou o webhook do ChatGuru) para as rotas:

| Rota | Handler |
|---|---|
| `POST /webhook/chatguru` | `chatguruWebhook` (entrada de leads / encaminhador / botão) |
| `POST /cotar` · `POST /interesse` | `obsIntegracao` (ponte legada) |
| `POST /precadastro` | `preCadastrarLead` (formulário do site) |
| `POST /opener` | `openerDisparou` |
| `GET /webhook/health` | status |

## Variáveis de ambiente (`/etc/obs-automacao/.env`)

| Var | Obrigatória | Observação |
|---|---|---|
| `OBS_USAR_PG` | sim | `true` — este serviço sempre usa PostgreSQL |
| `OBS_API_URL` | sim | URL da API do servidor (ex.: `https://api.obstransportes.com.br`) |
| `OBS_API_TOKEN` | sim | token da API do servidor |
| `ANTHROPIC_API_KEY` | sim | chave da Anthropic (Claude) |
| `ANTHROPIC_MODEL` | não | padrão `claude-opus-5` |
| `CHATGURU_API_KEY` | sim | API do ChatGuru |
| `CHATGURU_ACCOUNT_ID` | sim | conta s22 |
| `CHATGURU_PHONE_ID` | sim | phone_id |
| `CHATGURU_API_URL` | não | padrão `https://s22.chatguru.app/api/v1` |
| `LIMITE_VALOR_HUMANO` | não | padrão `500000` |
| `LEAD_JANELA_SEGUNDOS` | não | padrão `60` (janela de silêncio) |
| `MAX_PERGUNTAS` | não | padrão `2` (Fase C) |
| `VENDEDORES` | não | padrão `Yasmim Freitas,Thiago Lucca,Flavia Ottati` |
| `TELEFONE_OBS` | não | telefone nas mensagens |
| `PORT` / `HOST` | não | padrão `3001` / `127.0.0.1` |

O **liga/desliga do envio real** continua sendo `crm_config/config.envioAtivo`
(no PostgreSQL) — não precisa reiniciar o serviço para ligar/desligar.

## Teste rápido (sem tocar em produção)

```bash
node selftest.mjs
```

Roda o pipeline REAL em memória (firebase/anthropic/pg-api/chatguru/calc mockados),
empurra 1 webhook e confirma: lead criado em `crm_leads`, envio exatamente 1x,
e sem reenvio no re-run (idempotência).
