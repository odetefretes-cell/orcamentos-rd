# OBS Transportes — Sistema de Orçamentos + Automação de Leads

Contexto do projeto para o Claude Code. Última atualização: **05/09/2026**.

> **Resumo em uma frase:** app single-file (`index.html`) de CRM/orçamentos + backend de
> automação (pasta `integracao/`) que recebe leads pelo ChatGuru, calcula a média do frete
> e envia o orçamento no WhatsApp — 24h, sem navegador aberto. **Desde 20/08/2026 tudo roda
> numa VPS Hostinger (fora do Firebase/Cloud):** app estático + login próprio + PostgreSQL +
> automação em PM2, atrás do Caddy (HTTPS automático).

---

## 0. ⚡ ARQUITETURA ATUAL — migração para a Hostinger (20/08/2026)

O sistema saiu **100% do Google/Firebase** no dia a dia. O que roda hoje:

| Peça | Onde roda agora | Detalhe |
|---|---|---|
| App / CRM | VPS Hostinger — `https://sistema.obstransportes.com.br` | `index.html` estático em `/opt/obs-app`, servido pelo Caddy |
| Login | VPS (login próprio, tabela `usuarios`) | scrypt + JWT HS256 no `crypto` nativo — **sem Firebase Auth** |
| Banco | **PostgreSQL 16** na VPS (db `obs`, user `obs_app`) | substitui o Firestore; mesmas "coleções" viram tabelas `(id text, data jsonb, updated_at)` |
| API do app | VPS — `https://api.obstransportes.com.br` → `obs-api` (:3000) | `servidor-obs/api/server.mjs` (Express). Delta sync `?since=`, saves por campo `?merge=1` |
| Automação | VPS — `obs-automacao` (:3001) | mesmo pipeline `integracao/` rodando via `integracao/vps/` (stubs Firebase + facade PG + cron). Webhook do ChatGuru → `https://api.obstransportes.com.br/webhook/chatguru` |
| Formulário do site | github.io (não-Google) | `integracao/obs-cotacao.js` — pré-cadastra no ChatGuru pela VPS (`/webhook/precadastro`) e leva o cliente pro WhatsApp. **Não grava mais no Firestore.** |
| Firebase / Cloud Functions | **Só rollback** (plano B) | manter alguns dias; NÃO desligar até estabilizar |

**VPS:** IP `187.127.53.211`, Ubuntu 24.04, usuário app `obsrobo`. Processos no **PM2 do `obsrobo`**
(`pm2 list` como root vem vazio — use `su - obsrobo -c "pm2 ..."`). Reverse proxy **Caddy**
(`/etc/caddy/Caddyfile`): `sistema.*` → estático; `api.*` → `/webhook/*` ao 3001, resto ao 3000.
⚠️ O Caddy usa **`handle /webhook/*`** (NÃO `handle_path`) — o serviço espera o caminho completo.

**Segredos na VPS:** `/etc/obs-db/.env` (Postgres + `SESSION_SECRET`), `/etc/obs-automacao/.env`
(Anthropic/ChatGuru/`OBS_API_TOKEN`), `/etc/obs-robo/.env` (service account do Firebase p/ scripts).

**Scripts de operação:** pasta `servidor-obs/` (branch `obs-servidor-bootstrap`, clonada na VPS em `~/obs-repo`):
- `deploy-app.sh` — publica o `index.html` em `/opt/obs-app`.
- `deploy-automacao.sh` — extrai `integracao/` da branch de dev, roda selftest e sobe o `obs-automacao`.
- `setup-hosting.sh` — (re)escreve o Caddyfile (app + api + webhook).
- `seed-usuarios.mjs` — cria/reseta os usuários do login próprio.
- `copiar-para-postgres.mjs` / `pg-para-firebase.mjs` — cópia Firestore↔Postgres (migração / rollback).
- `VIRADA-HOSTINGER-RUNBOOK.md` — passo a passo da virada + rollback.

> ⚠️ **BRANCH DE DEPLOY = `claude/automate-transport-contract-form-tgvad2`.** É a branch
> que a VPS publica de verdade (padrão do `deploy-automacao.sh`) e a **única** que tem o
> `integracao/vps/` (orquestrador, lembretes, stubs). **É AQUI que se mexe na automação
> e no app daqui pra frente.** A antiga `claude/obs-leads-automation-backend-kaga7q` ficou
> paralela (não tem `integracao/vps/`, não deployaria) — não usar pra deploy.

**Deploy hoje** (tudo a partir da branch **`…-tgvad2`**):
- **App:** editar `index.html` → na VPS `bash ~/obs-repo/servidor-obs/deploy-app.sh`.
- **Automação:** editar `integracao/` → na VPS `bash ~/obs-repo/servidor-obs/deploy-automacao.sh`
  (publica a `…-tgvad2` por padrão; pra outra branch: `BRANCH=<nome> bash …/deploy-automacao.sh`).
- **Formulário:** `integracao/obs-cotacao.js` é servido pelo **github.io a partir da `main`** — publicar exige atualizar esse arquivo na `main` (o github.io propaga em ~minutos).

**Kill switch do envio:** `crm_config/config.envioAtivo` (linha no Postgres). Ligar:
`su - postgres -c "psql -d obs -c \"UPDATE crm_config SET data = data || '{\\\"envioAtivo\\\":true}'::jsonb WHERE id='config';\""`.
O log da automação mostra `[envioEstaAtivo] LIGADO/DESLIGADO` a cada ciclo.

**Rollback rápido (se precisar do Google de volta):** reverter as 3 URLs de webhook no ChatGuru
para as Cloud Functions + o DNS de `sistema.*` para o Firebase. Detalhes no RUNBOOK.

> As seções abaixo (§1–§11) descrevem a lógica de negócio, o fluxo e a config do ChatGuru,
> que **continuam válidos**. Onde citam "Firebase/Firestore/Cloud Functions/Cloud Shell",
> leia como a peça equivalente da §0 (PostgreSQL / VPS / PM2 / terminal da Hostinger).

---

## 1. Onde as coisas rodam

> ⚠️ **Histórico (pré-migração).** Esta tabela descreve a infra **antiga** no Firebase, hoje
> mantida só como rollback. A infra **atual** (Hostinger/PostgreSQL) está na **§0**.

| Peça | Onde | Observações |
|---|---|---|
| App / CRM (Kanban, orçamentos, tabela de fretes) | `index.html` (single-file) | Publicado no **Firebase Hosting** → https://obs-fretes.web.app (e github.io) |
| Backend de automação | `integracao/` (Cloud Functions v2, Node 20) | Projeto Firebase **obs-fretes**, região **southamerica-east1** |
| Banco | **Firestore** (projeto obs-fretes) | Coleções em §4 |
| WhatsApp | **ChatGuru** (conta s22, "Obs Transportes") | Config dos diálogos em §7 |
| IA de extração/decisão | **Anthropic (Claude)** | Modelo padrão `claude-opus-5` |

**Deploy:**
- **App (`index.html`)**: automático via GitHub Actions (`.github/workflows/firebase-deploy.yml`) a cada push na branch **`main`** → publica no Hosting.
- **Backend (`integracao/`)**: manual, pelo Cloud Shell:
  ```
  cd ~/orcamentos-rd
  git fetch origin && git checkout <branch> && git reset --hard origin/<branch>
  firebase deploy --only functions
  ```
- Branch de desenvolvimento desta automação: **`claude/automate-transport-contract-form-tgvad2`**
  (é a branch de deploy — ver o aviso na §0). A antiga `claude/obs-leads-automation-backend-kaga7q`
  (PRs #3 e #4 já mesclados na main) ficou paralela e **não** é usada pra deploy.
  ⚠️ Este trecho `firebase deploy --only functions` é do fluxo **antigo (rollback Firebase)**;
  o deploy atual é o `deploy-automacao.sh` na VPS (§0).

---

## 2. Fluxo de ponta a ponta (leads automáticos)

```
Cliente → ChatGuru → webhook (chatguruWebhook)
  → crm_leads_intake/{telefone}  (acumula mensagens, statusIntake='recebendo')
  → fecharLeadsCompletos (agendada, a cada 1 min): após 60s de silêncio → 'completo'
  → processarLeadCompleto (IA Claude): extrai campos + decide automático/humano/faltando_dados
  → criarLeadNoCrm: cria crm_leads/lead_wpp_{últimos8díg} + CALCULA a média no backend
  → prepararResposta: envia a média (ou aviso humano) pelo ChatGuru + marca MediaEnviada
```

**Chave do lead:** `lead_wpp_` + **últimos 8 dígitos** do telefone (mesma do formulário
do site em `integracao/obs-cotacao.js`) — evita duplicar site × ChatGuru e ignora
+55/DDD/9º dígito.

---

## 3. Arquivos do backend (`integracao/`)

| Arquivo | O que faz |
|---|---|
| `webhook.js` | Ponto de entrada: `initializeApp()` + `require` de todas as funções. Também tem a função legada `obsIntegracao` (rotas /cotar, /interesse). |
| `chatguru-webhook.js` | `chatguruWebhook` (recebe o POST do ChatGuru, acumula no intake) + `fecharLeadsCompletos` (agendada, fecha após 60s). Extrai campos tolerante a vários nomes. |
| `claude-extrator.js` | `processarLeadCompleto` — chama a IA (Claude, structured output), extrai campos e **decide**. Fase C: se faltam dados essenciais, pergunta ao cliente. |
| `orcamento-resposta.js` | `criarLeadNoCrm` (cria lead + chama o cálculo backend) e `prepararResposta` (monta e envia a mensagem; marca `MediaEnviada`). Contém o rodízio de vendedor e os templates de mensagem. |
| `calc-fretes.js` | **Cálculo da média NO BACKEND (Fase B)** — port fiel da lógica do `index.html`. Lê a tabela do Firestore (`fretes/_tabela`) ou do arquivo empacotado. |
| `chatguru-api.js` | Cliente da API do ChatGuru: `enviarMensagem` (message_send) e `atualizarContexto` (chat_update_context → grava `MediaEnviada`). Normaliza número p/ `55+DDD+número`. |
| `tabela-fretes.json` / `cidades-coords.json` | Cópias empacotadas (fallback do cálculo). A fonte real é o Firestore. |
| `obs-cotacao.js` | Widget do formulário do site (cria lead `lead_wpp_{últimos8}` + manda pro WhatsApp). |

**Funções implantadas:** `chatguruWebhook`, `fecharLeadsCompletos`, `processarLeadCompleto`,
`criarLeadNoCrm`, `prepararResposta`, `obsIntegracao`.

---

## 4. Firestore — coleções e configs

| Coleção/doc | Uso |
|---|---|
| `crm_leads` | Leads do CRM (o app escuta em tempo real). IDs: `lead_wpp_{últimos8}`, `lead_{timestamp}` (manuais). |
| `crm_leads_intake/{telefone}` | Buffer de entrada (acumula mensagens até fechar). Campos: statusIntake, mensagens[], extraido, iaProcessado, leadCriado, vendedorAtribuido, perguntasFeitas… |
| `chatguru_webhook_log` | Caixa-preta: todo POST cru recebido do ChatGuru. |
| `crm_config/config` | **`envioAtivo`** (boolean) — liga/desliga o envio real pelo WhatsApp. Aceita true/"true"/1. |
| `crm_config/rodizio` | Contador do rodízio de vendedor (`contador`, `ultimo`). |
| `fretes/_tabela` (+ `_tabela_p1`…) | **Tabela de fretes** (gzip base64), atualizada quando o admin **importa a planilha** no app. O backend lê daqui. |

**`statusIntake` possíveis:** `recebendo` → `completo` → `automatico` | `aguardando_humano` | `faltando_dados`.

---

## 5. Segredos (Firebase functions:secrets)

- `ANTHROPIC_API_KEY` — API da Anthropic (Claude).
- `CHATGURU_API_KEY`, `CHATGURU_ACCOUNT_ID`, `CHATGURU_PHONE_ID` — API do ChatGuru.
  - account_id = `67e2e2f7895b4e2e2ed944b0` · phone_id = `67ec49e82415efebeb055070` · endpoint `https://s22.chatguru.app/api/v1`.
- Variáveis opcionais (env): `ANTHROPIC_MODEL`, `LIMITE_VALOR_HUMANO` (500000), `LEAD_JANELA_SEGUNDOS` (60), `MAX_PERGUNTAS` (2), `VENDEDORES`, `TELEFONE_OBS`.

Conferir/gravar valor de um segredo: `firebase functions:secrets:access NOME` / `:set NOME`.
Após trocar um segredo, **redeploy** (`firebase deploy --only functions:prepararResposta` etc.).

---

## 6. Regras de negócio (extração/decisão da IA)

**Vai para HUMANO** (não cota automático): valor acima de **R$ 500.000**; sem valor
informado; valor claramente errado. (Frota/PJ com vários veículos: tratar como humano — o
cálculo automático é por 1 veículo.)

**Cotam a MÉDIA, mas marcam estimativa** (`precisaAjuste=true`): leilão, veículo não
funciona, carro + mudança.

**Moto elétrica** → automático, orça como **moto 300cc** (`orcarComo="moto 300cc"`).

**Fase C — contatos diretos:** se faltam origem/destino/veículo/valor, a IA gera uma
pergunta e o backend pede ao cliente (até `MAX_PERGUNTAS`); quando responde, reprocessa e cota.

**Rodízio:** todos entram "Ninguém Delegado" no ChatGuru → o backend atribui o vendedor
(Yasmim Freitas, Thiago Lucca, Flavia Ottati) por rodízio no CRM.

**Fase A / B:** "Fase A" era calcular a média no navegador (app aberto). **"Fase B"
(atual)** calcula no backend (`calc-fretes.js`), 24h. Validação: Yasmim (Santo André→Betim,
Carro passeio) = **R$ 1.040**; Alan (Guanhães→Viçosa, moto 300cc) = **R$ 2.414,40** — batem
ao centavo com o app.

---

## 7. Configuração do ChatGuru (conta s22, chatbot `67e2f6b3198069809dfaf169`)

> **Config completa e atual:** `integracao/CHATGURU-CONFIGURACAO.md` (IDs, gatilhos,
> ações). Abaixo, o resumo. A config é mantida pela equipe/Cowork na tela do ChatGuru.

Grupo de diálogos "ChatGuru Integrações":

1. **Webhook Lead Novo (Formulário)** (`6a75e9a1…`) — gatilho `!word=='Solicitação de orçamento'`
   → POST `.../chatguruWebhook`. Contexto de Saída `Cotando=Sim`.
2. **Gerar Orçamento (Backend OBS)** (`6a764da1…`) — **manual** ("**...**" → "Acionar um diálogo").
   POST + `MediaEnviada=Sim`. Campo **Origem=`fechar`** → backend processa **na hora**.
3. **Interesse pós-média (dentro)** (`6a765e9e…`) — interesse + `$MediaEnviada=='Sim'` + horário →
   `/confirmar` + AGUARDANDO. → `MediaEnviada=Respondido`.
4. **Interesse (fora do expediente)** (`6a766737…`) — igual, mensagem de retorno.
5. **Opener – Saudação** (`6a763823…`) — intake do contato direto ("Para emissão de um orçamento…")
   + `Cotando=Sim`. Gatilho: saudações **AND `!new_chat`** (não dispara em contato já em tratativa;
   retorno de cliente antigo = atendente aciona manual).
6. **Encaminhar Resposta (Backend OBS)** (`6a776678…`) — `anything_else and $Cotando=='Sim' and
   $MediaEnviada!='Sim' and $MediaEnviada!='Respondido'` → POST (Origem **vazio**, pra acumular).
   Faz as **respostas soltas** do cliente chegarem ao backend (Fase C, contatos diretos).
7. **Falar com Atendente** (`6a79d1af…`) — frases "quero atendente/humano" → **AGUARDANDO +
   DELEGAR Comercial (rodízio) + não lido** + `Cotando=Nao`. (No backend, IA marca `pediuAtendente`.)

> ⚠️ **Pós-migração (20/08/2026):** os 3 diálogos que fazem POST pro backend — **[1] Webhook
> Lead Novo**, **[2] Gerar Orçamento** e **[6] Encaminhar Resposta** — agora apontam para
> **`https://api.obstransportes.com.br/webhook/chatguru`** (VPS), não mais pra Cloud Function.
> Rollback = voltar essas 3 URLs pras Cloud Functions. O pré-cadastro do formulário virou
> **`https://api.obstransportes.com.br/webhook/precadastro`**.

**`MediaEnviada`** é **variável de contexto**. Botão [2] grava por "Contexto de Saída"; nos leads do
formulário o **backend grava via API** (`chat_update_context` em `prepararResposta`) — **confirmado em
produção**. `Cotando` liga/desliga o encaminhador [6].

⚠️ **Conferir:** fuso da conta ChatGuru = **America/Sao_Paulo** (horários 3/4 e o aviso de fora de expediente).

---

## 8. Botão no CRM (app)

No modal do lead existe **"🤖 Enviar automático"** (`crmForcarAutomatico` no `index.html`):
limpa marcas de atenção humana, usa o valor já calculado (só recalcula se faltar) e salva
→ dispara `prepararResposta` (envia). Serve pra empurrar manualmente um lead pro fluxo.

---

## 9. Ligar/desligar e testar

> Comandos **atuais (VPS)**. Os antigos `firebase functions:log` valem só se voltar pro rollback.

- **Ligar o envio real:** ver o comando de `envioAtivo` na §0. Desligar = `false` no mesmo lugar.
- **Ver o log da automação (na VPS):** `su - obsrobo -c "pm2 logs obs-automacao"` (ao vivo) ou
  `su - obsrobo -c "pm2 logs obs-automacao --lines 200 --nostream"` (histórico). Procure
  `LEAD RECEBIDO`, `média backend R$ ...`, `ENVIADO`, `AVISO HUMANO`, `enviando para 55...`,
  `[envioEstaAtivo]`. ⚠️ Os processos estão no **PM2 do `obsrobo`** (o do root vem vazio).
- **Teste automático 24h:** dispare um lead pelo formulário → a média deve chegar em ~2-3 min
  (acúmulo 60s + cron + IA + envio). Use um número **sem responsável** no ChatGuru (contato já
  em atendimento é pulado de propósito — trava anti-"falar por cima do atendente"). Além do
  responsável, o backend também pula quando o **status do chat não é `ABERTO`** (AGUARDANDO/
  EM ATENDIMENTO/resolvido/fechado) — 3ª trava (05/09); no log: `chat EM ATENDIMENTO (status …) — pula`.
- **Saúde dos serviços:** `curl -s https://api.obstransportes.com.br/api/health` (app) e
  `curl -s https://api.obstransportes.com.br/webhook/health` (automação).
- Roteiro completo: `integracao/ROTEIRO-DE-TESTE.md` (fluxo) e `servidor-obs/VIRADA-HOSTINGER-RUNBOOK.md` (infra).

---

## 10. Pendências / próximas melhorias (a partir daqui)

- [ ] **Múltiplos veículos / frota** numa mesma cotação (hoje o cálculo é por 1 veículo; a IA extrai 1). Cliente Muve Locadora foi o caso real (PJ, ~38 veículos).
- [x] **Responsável no ChatGuru:** o diálogo "Falar com Atendente" delega ao Comercial por rodízio (a API não reatribui responsável; resolvido por diálogo). No fluxo de média o responsável certo segue no CRM.
- [x] **Fase C em produção:** ativa. As respostas do cliente chegam ao backend pelo **encaminhador** (diálogo [6], chavinha `Cotando`). Escopo controlado (só enquanto cota) evita falar por cima do atendente.
- [ ] **Retorno de cliente antigo (contato direto):** o Opener não dispara sozinho (`!new_chat`); o atendente aciona manual. Avaliar automação melhor no futuro.
- [ ] Limpar leads **duplicados antigos** (`lead_wpp_{número completo}`) criados antes da correção de chave.
- [ ] Manter `calc-fretes.js` **em sincronia** com a lógica de cálculo do `index.html` (é uma cópia fiel; se mudar a regra no app, atualizar aqui).
- [x] **Sair do Firebase/Cloud (20/08/2026):** migrado 100% pra VPS Hostinger (ver §0). Firebase mantido só como rollback (aposentar depois de estabilizar). ⇒ a pendência do Node 20 das Functions deixou de ser bloqueante.
- [x] **Contato direto restaurado (22/08 tarde):** a causa raiz dos leads "perdidos na automação" (LF, Isis, André Bonfanti) era o POST do **Opener** apontando pra rota errada/morta → `Cotando=Sim` nunca ligava → o encaminhador [6] não repassava as respostas. Corrigido: Opener → **`/webhook/opener`** (rota dedicada que liga o Cotando; retry 6x). Cowork validou por análise estática que o bloco preenchido cai só no [6] (os `!word=='sim'` têm trava `MediaEnviada`). Decisão: **NÃO ampliar o gatilho do [6]** (risco de quebra em runtime > janela de corrida de segundos; pior caso vira lead aguardando_humano). Ver item 10 do histórico.
- [ ] **Aposentar o Google:** depois de alguns dias estável, desligar Cloud Functions + Firestore (e migrar/parar o Firebase Hosting). Rotacionar senhas dos 7 usuários e as chaves de API (foram exibidas na instalação).
- [ ] **Saldo WABA (ChatGuru):** manter recarregado — se zerar, o WhatsApp para de entregar as estimativas mesmo com tudo funcionando.
- [ ] (Baixado de prioridade) **Node 20** das Functions descontinua em 30/10/2026 — só relevante se o rollback pro Firebase virar permanente.

---

## 11. Histórico resumido (o que já foi entregue)

1. Webhook de entrada + acúmulo (60s) + IA (extração/decisão) + fail-safe pra humano.
2. Criação do lead no CRM + rodízio de vendedor + templates de mensagem (modelo OBS).
3. Envio pela API do ChatGuru (liga/desliga por `crm_config/config.envioAtivo`).
4. Correções de produção: chave da Anthropic, `envioAtivo` no doc certo, **dedup por
   últimos 8 dígitos**, número com **+55** (senão o ChatGuru não entrega), phone_id que
   estava vazio.
5. **Fase B**: cálculo da média no backend (24h). **Ponto 2**: aviso "atendente vai
   preparar" (com texto **personalizado p/ alto valor**). **Fase C**: perguntar dados
   que faltam (contatos diretos). Marcação `MediaEnviada` via API pra ligar o follow-up
   de interesse também nos leads do formulário.
6. **Ciclo completo (10/08/2026):**
   - Webhook lê **campos personalizados** do ChatGuru (contatos diretos) + junta ao texto pra IA.
   - Botão do atendente com **Origem=`fechar`** → processa **na hora** (sem esperar 60s).
   - **Reinício de ciclo**: mesmo número que volta a pedir é cotado de novo (antes travava em `iaProcessado`/`respostaEnviada`).
   - **Aviso de fora de expediente** anexado às mensagens automáticas (fuso Brasília).
   - **Encaminhador** (`Cotando`): respostas soltas do cliente chegam ao backend (acumula ~60s e cota).
   - **`pediuAtendente`**: cliente que pede pessoa vai pra humano sem o robô perguntar dados.
   - `MediaEnviada` via API **confirmada em produção** (log `MediaEnviada=Sim marcada`).
   - Config completa do ChatGuru versionada em `integracao/CHATGURU-CONFIGURACAO.md`.
7. **Migração para a Hostinger (20/08/2026) — saída do Firebase/Cloud (ver §0):**
   - App servido pela VPS (`sistema.obstransportes.com.br`) + **login próprio** (scrypt+JWT, sem Firebase Auth).
   - **PostgreSQL** no lugar do Firestore; API `server.mjs` com **delta sync** (`?since=`) e **saves por campo** (`?merge=1`) — resolve o "não salva" (flood de polling / concorrência) da versão Firestore.
   - Automação idêntica (`integracao/`) rodando na VPS via `integracao/vps/` (stubs Firebase + facade PG + driver/cron), no **PM2 do `obsrobo`**.
   - **Caddy** (HTTPS automático) com `handle /webhook/*` → 3001. Bug corrigido no dia: era `handle_path` (cortava o `/webhook` → 404 no webhook do ChatGuru).
   - **Formulário do site** tirado do Google: pré-cadastro agora em `/webhook/precadastro` (VPS) e **sem gravação no Firestore** (o lead entra pela automação).
   - Validado em produção com leads reais (médias corretas + `ENVIADO`). Firebase/Cloud mantidos só como rollback.
8. **Integração Conta Azul + correção dos leads do site (22/08/2026):**

   **Conta Azul (serviço `obs-contaazul`, porta 3002, systemd — ver `contaazul/`):**
   - Backend Node (Express + SQLite) que lança **despesa do prestador** (conta a pagar) e **venda** no Conta Azul Pro pela API v2 (`api-v2.contaazul.com`, OAuth2/Cognito). Token no SQLite (refresh persistente).
   - **Proxy seguro:** o app chama `obs-api` (`/api/ca/*`, JWT) que injeta o `X-OBS-Secret` e repassa ao 3002. O segredo (`OBS_SHARED_SECRET`) fica só no servidor (`/etc/obs-db/.env` + `/opt/obs-contaazul/.env`), **nunca no navegador nem no GitHub**.
   - Botões no app (tela **Financeiro → Prestadores**): **☁ lançar** (1 prestador), **☁ lançar juntos** (várias placas do mesmo prestador num lançamento só — acerto semanal/mensal; dedup de par frete+placa), **↩ cancelar** (Plano B: desmarca no sistema + você exclui manual no CA), campo **🔑 chave PIX** (vai na observação/nota da parcela). Placa vazia do prestador → usa a do veículo transportado.
   - **Quirks da API v2 descobertos:** listas vêm em `items` (inglês); `tamanho_pagina` ∈ {10,20,50,100,200,500,1000}; despesa (conta a pagar) usa `contato` (não `id_pessoa`), `observacao` (singular), `rateio[{id_categoria, rateio_centro_custo:[{id_centro_custo,valor}]}]`, `condicao_pagamento.parcelas[{descricao, data_vencimento, nota, conta_financeira, detalhe_valor:{valor_bruto,valor_liquido,...}}]`; o POST volta **202 sem id** (a busca depois traz o **id da PARCELA**, e `parcela.evento.id` é o id do EVENTO). **A API NÃO deixa excluir conta a pagar** (DELETE evento=404, DELETE parcela=502) nem cadastrar PIX no fornecedor → por isso cancelar/PIX são "assistidos" (manual no CA). UUIDs reais (vendedor, conta, categorias, centros, serviços) fixados em `contaazul/src/config.js`.
   - **Baixa em massa:** `servidor-obs/baixa-prestadores.mjs` deu baixa (marcou pago no sistema, sem tocar no CA) em **167 prestadores** de fretes ≤ 31/05 (backup automático antes).

   **Leads do site que sumiam — CORRIGIDO:** o formulário já mandava pro `/webhook/precadastro`, mas o backend **só criava o contato no ChatGuru e NÃO salvava o lead** → o lead se perdia. Corrigido em `integracao/precadastro.js`: agora o pré-cadastro **cria o lead no CRM (Postgres)** (`getFirestore→pg-compat`, merge por `lead_wpp_{últimos8}`). `integracao/obs-cotacao.js` reforçado com **`keepalive`** (sobrevive ao pulo pro WhatsApp) + corpo completo. **Testado: `leadCriado:true`** e lead aparece no CRM com média. O `main` (GitHub Pages) já serve o form com a URL nova; falta só o reforço do keepalive lá se quiser (push no `main`).
   - **Recuperação:** `servidor-obs/recuperar-leads-firebase.mjs` trouxe 6 leads presos no Firebase (só os que faltavam, sem sobrescrever). Os ~29 anteriores à correção têm os **dados completos no RD Station** (o form manda pro RD via Make c/ keepalive) → recuperar com a skill **`preencher-frete-rd-crm`**.
   - Diagnóstico do funil: `servidor-obs/diag-intake.mjs` (status do `crm_leads_intake`, presos, webhook_log, busca por telefone).
9. **Fluxo de pagamento no Financeiro — fila de liberação (22/08/2026):**

   **Fase 1 (UI/fluxo, no `index.html`):** a fila **"🚦 Aguardando liberação → Operacional"** virou linha **fechada** (igual ao operacional) que **abre ao clique** (`liberAbertos`/`toggleLiber`). Ao abrir, a 1ª escolha é a **forma de pagamento** (Cartão / Boleto (Empresa) / PIX), cada uma com seu painel:
   - **💳 Cartão:** link da plataforma **Rede** (colado pelo operador, `cartaoLink`), **valor com taxas** (`valorComTaxas`), data de pagamento do link → **compensação automática = pagamento + 1 dia** (`setPagLinkCartao`→`dataCompensacao`). Botão registra a **venda no CA** + envia a mensagem c/ link **direto no ChatGuru**.
   - **📄 Boleto:** `dataFaturamento` + `boletoVencimento`; pode **liberar ao operacional sem faturar** → entra na **"📄 Fila de faturamento (boleto)"** (card novo, `#finFaturar`): fatura-se **no embarque**; quando o operacional marca `embarqueFeito` (`setMarco`), o frete **acende em vermelho** na fila + alerta. Botões: ☁ CA (venda + **emite o boleto**), 📱 ChatGuru, ✉️ Gmail (compose pronto via `gmailFaturamento`).
   - **⚡ PIX:** `pixTipo` = **50/50** (padrão) ou **Integral** (→ `PIX_100` na venda CA), `pixVenc1`/`pixVenc2`. Botão: venda CA + **cobrança PIX** + link direto no ChatGuru.

   **Fase 2 (integrações):**
   - **Cobrança pelo CA:** `POST /obs/cobranca` no obs-contaazul (`contaazul/src/contaazul/cobranca.js`) → `gerar-cobranca` da API v2 (`{id_conta, id_parcela, tipo: BOLETO|PIX_COBRANCA|LINK_PAGAMENTO, data_vencimento, descricao_fatura}`), 1 cobrança **por parcela em aberto** da venda (PIX 50/50 → 2). Proxy: `POST /api/ca/cobranca` (obs-api, JWT).
   - **Envio direto no ChatGuru:** `POST /webhook/enviar-cliente` no obs-automacao (exige `X-OBS-Secret` = `OBS_SHARED_SECRET`, agora também em `/etc/obs-automacao/.env`) → `enviarMensagem` da API ChatGuru. Proxy: `POST /api/chatguru/enviar` (obs-api injeta o segredo; navegador nunca vê). No app: `chatguruEnviar()` com fallback de **copiar** a mensagem se o envio falhar.
   - **Validado em produção (22/08):** PIX (1697/1699) e CARTÃO (1698) de ponta a ponta. Estado **"⏳ AGUARDANDO PGTO"** + trava da forma após cobrança enviada (`cobrancaEnviada`; destrava no botão "✏️ Alterar faturamento"). Campo do CPF na pessoa é **`cpf`/`cnpj`** (não `documento` — schema CriarPessoa em `/_bundle/open-api-docs/open-api-person.json?download`). Envio ChatGuru tenta a **variante com/sem 9º dígito** quando "Chat não encontrado". Vendas manuais antigas entram no radar da baixa via **`POST /obs/venda/adotar {fretes:[...]}`** (acha pelo número OU por "Venda <n>" na descrição das contas a receber).
   - **Baixa do CARTÃO no CA (22/08, validada):** "✔ recebi" de frete cartão (ou 2ª parte do misto) marca no sistema **e** dá a baixa na parcela do CA via `POST /obs/baixa` → `POST /v1/financeiro/eventos-financeiros/parcelas/{id}/baixa` (`BaixaCriacaoRequestDTO`: data_pagamento, conta_financeira, composicao_valor{valor_bruto,...}, metodo_pagamento=CARTAO_CREDITO_VIA_LINK). Conta do cartão = **ITAU** (`idContaItau` em config.js — a Rede deposita lá). Estorno: DELETE `/parcelas/baixa/{baixa_id}` ou pela tela.
   - **Fase 3 (baixa automática) NO AR:** job `contaazul/src/jobs/sync-baixas.js` (a cada 3 min): parcela paga no CA → preenche Pago1/2+data no frete (via obs-api c/ `OBS_API_TOKEN`); PIX pago c/ frete no financeiro → **libera ao operacional sozinho**; cartão fica fora (Rede). Pendente: cartão baixado no sistema → baixa no CA.
   - **Cobrança VALIDADA em produção (frete 1697):** venda → cobrança PIX 1ª parcela → link no WhatsApp. Regras descobertas: campo da conta é **`conta_bancaria`** (não `id_conta` — schema `GerarCobrancaRequestDto`, spec em `developers.contaazul.com/_bundle/docs/*-openapi.json?download`, acessível da VPS); **mínimo R$ 10,00** por cobrança; emissão **assíncrona** (`AGUARDANDO_CONFIRMACAO` → url via GET `/contas-a-receber/cobranca/{id}`; INVALIDO = cadastro do cliente incompleto); **cliente precisa de CPF + endereço completo + telefone** (`telefone_celular` DDD+número SEM 55; `enderecos:[{cep,logradouro,numero,...}]`); busca de pessoa por documento **ignora o filtro** → conferir o CPF no resultado; venda com nº já usado → **adota a existente**; financeiro cobra **só a 1ª parcela** (botão), a 2ª é o operacional (⚡ Cobrar saldo, `apenas:'ultima'`). No app, CPF/endereço que faltam na ficha vêm do **cadastro CLIENTES** automaticamente.

10. **Contato direto restaurado + boleto na fila + manual do operador (22/08 tarde):**
   - **Boleto reorganizado:** na fila de liberação, boleto só tem **✅ Liberar** (sem campos). O faturamento inteiro mora na **📄 Fila de faturamento**: vencimento → **☁ Faturar (CA + ChatGuru)** → emite o boleto, envia o link ao cliente, **preenche "faturado em" sozinho** (sem edição manual) e sai da fila; ✉️ Gmail sai com o **link do boleto** no corpo (`boletoLink`).
   - **Contato direto (causa raiz):** Opener postava em rota morta → `Cotando` não ligava → respostas não chegavam → botão [2] gerava lead vazio. Correções: Opener → **`/webhook/opener`** (Cowork, verificado); retry do Cotando **6x** com espera crescente; **rede de segurança na IA** (decisão vazia/≠automatico → `aguardando_humano`, cria o lead — nunca mais trava em `completo`); 4 presos destravados (1 automático c/ média, 3 em atendimento humano).
   - **Travas anti-robô validadas (4 cenários):** (1) conversa antiga não recebe o bloco (`!new_chat`, bloco só no Opener — varrido nos 35 diálogos); (2) chat com responsável humano → backend pula (`em_atendimento_humano`, provado em produção); (3) "quero atendente" → [7] põe `Cotando=Nao` e o robô silencia; (4) pós-média → `MediaEnviada` bloqueia o [6]. Decisão: sem trava extra no ChatGuru (fragilidade > ganho).
   - **Casos antigos (mensagens perdidas antes da correção):** sem recuperação retroativa — fechar manual: preencher o lead no CRM + **🤖 Enviar automático**.
   - **Manual do operador financeiro** (artifact p/ compartilhar/imprimir): rotina, cobrança por forma, o que é automático, erros comuns, regras de ouro — https://claude.ai/code/artifact/93be47d8-6fd3-43af-8af0-b89b59efbffb
   - Pendente de carimbo: **teste real positivo** do contato direto (olá → bloco → resposta → média em ~2 min, número sem responsável).
   - **Acabamento da tela Financeiro/Operacional (22/08 fim de tarde):** dashboards do **A receber** e do **Lucro** redesenhados (hero "Em aberto"/"Lucro do mês" + barra de composição da receita + KPIs clicáveis — classes `fd*`; atenção: `.rel-resumo` é flex, o painel usa wrapper `.fdWrap`); **Entradas programadas** com barra proporcional por dia; card **Prestadores movido pra 3ª posição**; **Fila de faturamento colapsada** (clique abre as ações, `fatAbertos`/`toggleFat`); no card do operacional o bloco financeiro é **SOMENTE LEITURA** (`finViewOperacionalHTML`) + botão **"📄 Enviar p/ faturamento (antes do embarque)"** (`faturamentoSolicitado` → destaca âmbar na fila); **TRAVA DE ENTREGA** (`travaEntregaDe`): selo/faixa "⛔ NÃO ENTREGAR" enquanto boleto não faturado ou PIX/cartão sem baixa (boleto faturado = 🟢 OK p/ entrega). Baixas manuais de fretes antigos pagos por fora: UPDATE em `fretes` (pago1=valorFrete + obs 'baixa manual').

11. **Módulo Fiscal — esqueleto pronto, PROJETO PAUSADO (22/08/2026 — aguardando o Luiz autorizar o início; NÃO avançar sem ele pedir):** projeto completo em `fiscal/PROJETO-CTE-MDFE-AVERBACAO.md` (CT-e + MDF-e + averbação; contexto regulatório ANTT 10/03/2026; Focus NFe + AT&M). Serviço **`obs-fiscal`** (porta **3003**, systemd, `servidor-obs/deploy-fiscal.sh`, segredos em `/etc/obs-fiscal/.env`): tabela `fiscal_docs` no Postgres, cliente Focus NFe (homolog/prod), `mapCte` monta o JSON do CT-e a partir do frete do CRM, proxy `GET/POST /api/fiscal/cte/{preview,emitir,status}` no obs-api. **Sem FOCUS_TOKEN roda em MODO PREVIEW** (`/obs/cte/preview?frete=N` monta o JSON + lista avisos — pra validar campos com o CONTADOR na Fase 0). Emissão só libera com Fase 0 completa (`prontoParaEmitir`: token + EMIT_* + FISCAL_CFOP_*/ICMS). Pendências Fase 0 (com o Luiz): emissor atual, seguradora/averbadora (corretora), UF da IE, contador p/ CFOP/ICMS/série; certificado **e-CNPJ A1**.

12. **Lembretes do operacional (25/08/2026) — VALIDADO EM PRODUÇÃO (frete 1706: anotação + AGUARDANDO + não lido, sem mensagem ao cliente):** campo **🔔 Lembrete para dia** nos marcos do frete (`lembreteEm`). Job `integracao/lembretes.js` (cron `5 8-19 * * *` no orquestrador): no dia marcado pega a **última atualização interna** (`histInterno`), lança como **ANOTAÇÃO** no ChatGuru (`action=note_add` — não é mensagem ao cliente) e executa o diálogo **"Lembrete OBS"** (`dialog_execute`, id `6a8dba3ae0851bb664a42ac7` em `CHATGURU_DIALOG_LEMBRETE`) que põe a conversa em **AGUARDANDO + NÃO LIDO** (a API não faz isso direto; o diálogo é manual/invocável, sem mensagem ao cliente, sem tocar Cotando/MediaEnviada, max_executions 9999). Marca `lembreteEnviadoEm` (não repete).
   - **Telefone do chat:** envios e lembretes usam o telefone do **LEAD de origem** (`f.leadId` → `crm_leads.telefone`, número real da conversa) e só caem no telefone da ficha se não houver lead — o caso do frete 1703 (ficha com número diferente do chat) motivou isso. A confirmação da cobrança mostra o número de destino antes de enviar.
   - ⚠️ A API do ChatGuru **não busca chat por nome/número de frete** — toda ação exige `chat_number`. Por isso a origem confiável do número é o lead.
   - ⚠️ **Armadilha do ChatGuru (25/08):** todo **bloco de ação novo num diálogo nasce DESLIGADO** (toggle on_off). O diálogo executa e a API responde `{"result":"success","dialog_execution_return":"Diálogo Executado"}`, mas **nenhuma ação aplica** — foi o que aconteceu no "Lembrete OBS" (STATUS e LEITURA off). Ao criar/editar diálogo: **conferir o toggle verde de cada ação antes de salvar**. Confirmado também: blocos de ação são **imediatos** (delay 0), diálogo 100% silencioso aplica ações normalmente (não precisa de mensagem pra ancorar), `can_perform_manually=False` não bloqueia execução por API, e chat EM ATENDIMENTO **aceita** voltar pra AGUARDANDO por diálogo.
   - Anotação/diálogo tentam o número e a **variante com/sem o 9º dígito**; o diálogo usa o mesmo número que a anotação encontrou.

13. **Cálculo de rota e tabela de preços — auditoria a partir do relatório do comercial (04/09/2026):**

   **Como a tabela de preços vive hoje.** `fretes/_tabela` (Postgres, gzip+base64) é publicada pelo app (Configurações → planilha `.xlsx`, só admin) e **a importação SUBSTITUI a tabela inteira**. Em 04/09 a tabela em produção ainda era a de **14/08** — três semanas de reajustes (FMartins, Transmartins, bases TRANSPADRE, Rubens) nunca tinham entrado. Boa parte dos "bugs de valor" reportados era **dado não publicado**, não código.
   - Como a transportadora manda reajuste em **PDF/print** e o app só importa `.xlsx`, criamos **`servidor-obs/atualizar-tabela-precos.mjs`**: altera só as rotas/bases listadas, com **dry-run por padrão**, backup em `/root/` e `--restaurar`. Quedas de preço ficam **fora por padrão** (`--permitir-reducao` para forçar) — o PDF traz um "RETORNO" único por região, mas Natal/Fortaleza/Petrolina têm retorno mais caro cadastrado de propósito.
   - Cobre: preços por transportadora (`REAJUSTES`), preço avulso por rota (`PRECOS_ROTA`), **taxa de base por cidade** (`BASES` → `cidades[].recebimento`, cobrada na base de origem **e** na de destino), **inclusão de trechos** numa rota existente (`TRECHOS`) e **criação de rota** (`NOVAS_ROTAS`).
   - ⚠️ **Rodar de `/opt/obs-api`** (copiar o arquivo pra lá): o Node resolve `pg`/`dotenv` pela pasta do ARQUIVO, não pelo cwd.
   - ⚠️ **Reimportar a planilha pelo app desfaz** o que o script gravou. Manter a planilha-mestre em dia ou publicar só por um caminho.

   **Modelagem da tabela (importante pra entender os "valores errados").** Cada linha da planilha vira `{transportadora, rota:"Cidade (UF) - Cidade (UF)", valores:{categoria:preço}, trajetos:[pares o→d atendidos]}`. O **preço é da ROTA**, e os `trajetos` costumam repetir a mesma lista de cidades em várias linhas da transportadora. Consequência: um par (ex.: SBC→Foz) pode ser atendido pela rota nomeada "SBC - Foz do Iguaçu" (R$ 1.200) **e** pela guarda-chuva "SBC - Medianeira" (R$ 1.100), que lista Foz nos trajetos. Sem desempate, a mais barata vence e o frete sai abaixo da vaga.
   - **Confirmado pelo Luiz (04/09):** a linha guarda-chuva está certa para a cidade que dá nome a ela (Medianeira = R$ 1.100), mas **Foz é R$ 1.200** — a região de Foz aparece nos trajetos da linha de Medianeira por repetição de cadastro. Mesmo padrão no Pará: a linha "SBC - Marituba" (R$ 2.600) lista Marabá, cuja vaga é R$ 2.900.
   - **A regra final (em produção 04/09):** `rotaNomeadaPar()` marca de qual rota veio cada opção (`_rotaNome`) e o desempate roda em **`crmColetarOpcoes`, sobre o par REALMENTE pedido** — não dentro de `crmGerarOpcoes`. Havendo rota com o nome do par pedido, só ela vale **para aquela transportadora**; outras transportadoras e combinações seguem disputando pelo mais barato. ⚠️ Fazer o desempate só no par exato **não basta**: as tentativas por cidade vizinha (42 km) escapam dele — era assim que Foz saía por R$ 1.100 entregando em Santa Terezinha de Itaipu, a 25 km. `crmGerarOpcoes`/`crmColetarOpcoes` são **idênticas em `index.html` e `integracao/calc-fretes.js` — manter as duas em sincronia**.
   - **Ganho medido:** 6 rotas cotavam abaixo da vaga e só uma tinha sido reportada — Foz (−R$ 100), **Marabá (−R$ 300)** e quatro da Transcarro no RS: Três Passos (−R$ 200), Santa Rosa e Horizontina (−R$ 100), Santo Ângelo (−R$ 50). Regressão final: **180 pares, 176 iguais, 4 corrigidos para cima, 0 para baixo**.

   **🐞 Bug crítico introduzido e corrigido no mesmo dia (registrar pra não repetir):** a primeira versão do filtro fazia `const _diretas = size ? diretas.filter(...) : diretas;` seguido de `diretas.length=0`. Sem rota nomeada, `_diretas` era **a mesma referência** → o `length=0` esvaziava os dois e **TODAS as rotas diretas sumiam**, sobrando só combinações com transbordo (Rio→Betim virou Rio→SBC→Betim). Chegou a produção e só apareceu porque o Luiz estranhou o desvio por SP.
   - **Duas lições, ambas custaram retrabalho no mesmo dia:**
     1. **Nunca reatribuir/esvaziar o array que se está filtrando** — `filter` devolve novo array, mas o ramo "sem filtro" devolve a própria referência. Montar a lista nova numa variável e não mutar a original.
     2. **Testar o caminho em que o filtro NÃO se aplica.** A validação usou 103 pares, todos **com** rota nomeada — justamente o único conjunto onde o bug não aparecia. A regressão que valeu foi a que incluiu 120 pares **sem** rota nomeada.
   - ⚠️ Um "ganho" medido com o bug presente **não vale**: o teste que mostrou "Marabá 2.600 → 2.900" rodou com a lista de diretas vazia. Ao validar mudança no motor, conferir antes que o baseline está são.

   **🐞 O corte de 500 combinações escondia a melhor opção (09/09/2026) — CORRIGIDO:** o laço que monta as combinações para em `combos.length>500`, e saindo de um HUB a lista de trechos de saída é enorme (São Bernardo: **4.872**). O corte guardava 500 combinações QUAISQUER, na ordem em que a tabela foi lida — então o motor **enxergava um trecho ao CHEGAR no hub, mas não ao PARTIR dele**. Sintoma reportado pelo Luiz: São Paulo → Manaus comprava um embarque a mais (SP → SBC, R$ 500) em vez de sair de SBC direto.
   - Diagnóstico: `saemDaOrigem` continha o trecho bom (DOCARMO SBC→Marituba R$ 2.600) e `custo[marituba]` já era 1.500 — a combinação de R$ 4.100 simplesmente nunca era montada.
   - Correção: dedup + ordenação de `saemDaOrigem` por `valor + custo[dN]` (o total que a combinação teria; `custo` vem do Dijkstra, que não tem corte). O corte passa a guardar as **melhores**, não as primeiras. **Quando o corte não morde, o conjunto gerado é idêntico** — só muda a ordem de construção, e tudo é reordenado por preço no fim.
   - ⚠️ Feito SEM `saemDaOrigem.length=0`: monta lista nova (`saidas`) e deixa a original intacta. Foi o padrão oposto que sumiu com as diretas em 04/09.
   - Resultado: São Paulo → Manaus **R$ 5.520 (3 trechos) → R$ 4.910 (2 trechos)**. Regressão: 310 pares, 289 iguais, 9 mais baratos, **0 mais caros, 0 perderam rota**.
   - **`ferramentas/regressao-motor.js`** (`base` grava o snapshot, `comparar` confere) — a amostra mistura origens que passam pelo hub com pares regionais onde a mudança não pega, que é a lição do incidente de 04/09. Rodar SEMPRE antes de mexer no motor.

   **🐞 O mesmo padrão apareceu 3× no motor (09–11/09/2026): "recurso melhor existe, mas só é consultado quando não há alternativa nenhuma".** Ao mexer aqui, desconfiar de todo `if(!x.length){ … }` — é a assinatura do problema.
   1. **Corte de 500 combinações** — guardava as 500 PRIMEIRAS, na ordem da tabela. Corrigido com dedup + ordenação por `valor + custo[dN]`. São Paulo → Manaus: R$ 5.520 (3t) → R$ 4.910 (2t). Regressão 310 pares: 9 mais baratos, 0 mais caros.
   2. **A base só entrava se fosse uma das 2 vizinhas mais próximas** — numa origem cercada de cidades (Diadema, São Caetano…) São Bernardo ficava de fora e o motor COMPRAVA um trecho até a própria base. `comBaseObs()` põe a base sempre na lista quando está no raio, e `allBase` descarta opção cujo 1º trecho só serve para chegar nela. Guardas: só filtra se a base é alcançável E se sobrou opção saindo dela (nunca perder cotação). Confirmado pelo Luiz: **embarque da região metropolitana sai sempre de SBC, o cliente leva o carro** — a OBS não paga prestador para buscar dentro do raio. Regressão 576 pares: 0 mais caros, 0 sem rota.
   3. **Sub-trechos do corredor só como último recurso** — `crmAdjacencia` só conhece os pares o→d escritos, e rota de corredor é cadastrada com **1 embarque e N entregas** (Advaldo "SBC → João Pessoa": 1 origem, 175 destinos). Cidade do MEIO não tinha aresta para a frente. `crmArestasDaOrigem` (sub-trechos em ordem geográfica) só rodava se a cidade não tivesse NENHUMA aresta — Montes Claros tem 12 da IDEAL, todas para dentro de MG, então o Montes Claros → João Pessoa da Advaldo (R$ 1.900) era invisível e o frete voltava 824 km até SBC. Agora entram sempre; viável só por causa do item 1 (dedup+ordenação), senão estouraria o corte. **Custo: ~950 arestas por origem; 0,5–2,1 s por orçamento.** Regressão 576 pares: 0 mais caros, 0 sem rota.

   ⚠️ **LIMITE DESTA VALIDAÇÃO — ler antes de confiar nos números acima:** a regressão roda sobre `integracao/tabela-fretes.json` (cópia EMPACOTADA, 443 rotas), não sobre a tabela de produção (487). **Nenhum dos 3 sintomas relatados pelo Luiz se reproduziu localmente** — aqui os casos já saíam certos antes. Ou seja: as correções estão provadas como SEGURAS (não pioram nada), não como EFICAZES. Para reproduzir de verdade, puxar a tabela de produção primeiro:
   ```
   su - postgres -c "psql -d obs -At -c \"SELECT data->>'data' FROM fretes WHERE id='_tabela';\"" > /tmp/tab.b64
   node -e "const f=require('fs'),z=require('zlib');f.writeFileSync('/tmp/tabela-producao.json',z.gunzipSync(Buffer.from(f.readFileSync('/tmp/tab.b64','utf8').trim(),'base64')))"
   ```

   **✅ CONFIRMADO PELO LUIZ (11/09/2026) — a transportadora aceita embarcar no MEIO do corredor pelo MESMO preço da rota.** Isso transforma a correção nº 3 (sub-trechos sempre) de dedução geográfica em regra de negócio com respaldo: quando o motor oferece Montes Claros → João Pessoa pelo preço da rota "SBC → João Pessoa", está certo comercialmente, não só matematicamente.
   - **Por que NÃO cadastrar isso na tabela:** a rota SBC → João Pessoa tem 175 cidades; permitir embarque em cada uma para cada ponto à frente dá ~15 mil pares só nela, e mais de 1 milhão nas 443 rotas. Inviável de manter e de importar. O cálculo geográfico faz o mesmo sob demanda.
   - **Levantamento da assimetria (11/09):** das **1.187 cidades**, **1.068 (90%) só RECEBEM** — não podem carregar. Só 119 embarcam. São **17.385 pares cidade×rota** de embarque perdido. Inclui BH, Teresina, Anápolis, Canoas, Olinda, Feira de Santana. Medido em 148 cotações das 30 cidades mais movimentadas: **28 mais baratas (R$ 8.475), 107 iguais, 0 rotas perdidas**, 10 mais caras trocando um transbordo por trecho direto (dentro do teto de R$ 300).
   - ⚠️ **Lacuna conhecida, NÃO resolvida:** os sub-trechos entram só como PRIMEIRO trecho (`crmArestasDaOrigem` a partir da origem). O Dijkstra (`crmRevAdj`) segue só com os pares explícitos, então uma combinação cujo trecho DO MEIO seria um sub-trecho de corredor ainda não é montada. Incluir isso exigiria reconstruir o grafo com todos os sub-trechos — custo alto, ganho não medido.
   - ⚠️ **3 casos mais caros sem contrapartida (+R$ 80 a +R$ 180)**, todos em cidades que não existem como embarque e são resolvidas para uma âncora vizinha (Nossa Senhora do Socorro → Aracaju): com mais opções, o motor troca de âncora e a **taxa de base** daquela cidade muda o total. Não investigado até o fim.
   - ⚠️ **A 4ª mudança do dia (corte final pelas 60 MAIS BARATAS, commit 17784e4) NÃO altera preço nenhum.** Medido em 11/09: regressão de 576 pares → 576 iguais; 629 cotações instrumentadas → o corte é atingido em 586 (até 541 opções) e o preço final difere em **0**. A ordem de exibição põe as diretas primeiro já ordenadas por preço, então a mais barata cai na 1ª posição e nunca é cortada; só quebraria com >60 diretas E uma combinação com transbordo mais barata que todas. Mantida por ser a ordem logicamente correta, mas é **defesa, não conserto** — o ganho dos R$ 8.475 é das correções 1-3. O comentário original do código creditava a ela o caso Nossa Senhora do Socorro → Porto Alegre; **não se reproduz** (mesmo resultado com e sem). Lição: ao fazer várias mudanças no mesmo dia, medir cada uma ISOLADA antes de escrever no código o que ela resolveu.
   - **`ferramentas/corredores.js`** mede tudo isso (`<saida.json>` grava, `--diff a.json b.json` compara). Classifica à parte o "mais caro com um embarque a menos dentro do teto" — que é comportamento desejado, não defeito.

   **Regras de negócio confirmadas pelo Luiz (04/09):**
   - **Preço: sempre o mais barato**, mesmo que a vaga embarque/entregue numa **cidade vizinha** (o sistema aceita vizinha até 42 km, 2 candidatas).
   - **Transbordo** (ex.: RJ→SBC→Betim) é legítimo, mas prestador **direto** é preferível quando a condição é melhor — já existe `CRM_TETO_DIRETA = 300` (aceita pagar até R$ 300 a mais por um embarque a menos).
   - Como o preço mais barato pode ser de outra cidade, **a mensagem ao cliente passou a informar a base**: `basesDiferentes()` em `integracao/orcamento-resposta.js` acrescenta "🚚 Embarque na nossa base de X" / "🏁 Entrega na nossa base de Y" quando diferente do pedido. Era a causa real do reporte "SBC x Foz puxa 1.100, porém é 1.200" — o valor estava certo (vaga de Santa Terezinha), faltava dizer onde era a entrega. Também resolve o caso do cliente de Santo André que não sabia que precisava levar o carro até SBC.
   - ⚠️ **A cidade do trajeto é uma cidade ATENDIDA, não o pátio** (09/09/2026): a mensagem dizia "nossa base de São Paulo", mas não existe base na capital — são **104 rotas saindo de "São Bernardo do Campo (SP)" e nenhuma de "São Paulo (SP)"**. `nomeDaBase()` traduz pelo mapa `BASES_REAIS` **antes** de comparar com a cidade do cliente (traduzir depois faria o cliente de SBC receber "base de São Paulo", e o da capital não receber aviso nenhum — achando que entrega lá). Só afeta o texto; o cálculo segue pela cidade real do trajeto.
   - **Prestador em rota que não atende** (Selma RJ→Betim, Transmartins Cuiabá→Uberlândia, Beatriz Maceió→Sobral): **não reproduz mais** em produção (04/09) — não houve mudança de motor por isso.

   **Ferramentas de diagnóstico úteis (rodam na VPS, sem tocar em produção):**
   ```
   # tabela de produção em JSON legível
   su - postgres -c "psql -d obs -At -c \"SELECT data->>'data' FROM fretes WHERE id='_tabela';\"" > /tmp/tab.b64
   # rodar o cálculo REAL com ela (mostra prestador, trecho e valor escolhidos)
   cd /opt/obs-automacao/integracao && node -e "
     const fs=require('fs'),zlib=require('zlib'),M=require('module');
     process.env.NODE_PATH='vps/stubs'; M._initPaths();
     const db=JSON.parse(zlib.gunzipSync(Buffer.from(fs.readFileSync('/tmp/tab.b64','utf8').trim(),'base64')).toString());
     const {_internos:I}=require('./calc-fretes.js');
     (async()=>{ const c=await I.carregarCoords();
       const l={origem:'Rio de Janeiro RJ',destino:'Betim MG',categoria:'Carro Passeio',veiculoDesc:'Onix',valorVeiculo:'50000'};
       I.calcularFreteLead(l,db,c); (l.trajetos||[]).forEach(t=>console.log(t.transportadora,t.de,'>',t.para,t.valor)); })();"
   ```

16. **Relatório do comercial de 11/09/2026 — itens de tabela aplicados + o bug do recebimento.**

   **Taxa de recebimento de base: falta de cadastro entrava como ZERO — CORRIGIDO:** o orçamento oficial do cliente Carlos Eduardo (Salvador → SBC → Itajaí) saiu com Recebimento de R$ 100. O comercial reportou como "somou só uma das duas bases", mas o somatório está certo: Itajaí tem R$ 100 cadastrado e **Salvador está com `recebimento: null`**. Base sem cadastro contribuía 0 em silêncio, e o oficial saía abaixo do custo.
   - **Por isso o defeito voltou 6×** desde julho (João Pessoa e Natal 29/07, Porto Alegre 29/07, São Luís 30/07, Itajaí e São José 03/08, Curitiba 06/08): cada chamado era "resolvido" cadastrando aquela cidade, sem tratar a regra.
   - **Escala (11/09):** **25 das 173 cidades** sem recebimento — Rio, Salvador, Brasília, Goiânia, Recife, Curitiba, Manaus, Belém, Vitória, Campo Grande, Cuiabá, São Luís, Boa Vista, Macapá, Porto Velho, Rio Branco, Cruzeiro do Sul, Santarém, Alagoinhas, Betim/BH, Pato Branco, Tubarão, Uruguaiana, São Paulo e SBC. As outras 148 cobram (**127 delas R$ 150**).
   - **Correção:** `l._basesSemRec` guarda as bases do trajeto sem taxa; `crmEnviarOrcamento` exige confirmação explícita antes de emitir. **Não é bloqueio duro de propósito** — com 25 cidades pendentes, travar pararia a operação.
   - ✅ **CONFIRMADO PELO LUIZ (11/09):** a base da própria OBS (São Bernardo) **não cobra** recebimento — é pátio nosso. Fica fora do aviso; as outras 24 entram.
   - Corrigido junto um efeito colateral: quando NENHUMA das duas bases tinha valor, o `if(achou)` pulava o `setComp` e o campo ficava com o número do **cálculo anterior**, de outra rota.
   - ⚠️ **NÃO resolvido:** base do MEIO do trajeto (transbordo) não é considerada — só a primeira origem e o último destino. No caso do Carlos Eduardo o meio era SBC (isenta), mas com outro hub a conta ficaria incompleta. Falta decidir a regra comercial.
   - ⚠️ **Pendente de dado:** as 24 cidades de parceiro precisam do valor real de recebimento. Enquanto não vierem, o aviso dispara e o operador decide.

   - **APLICADO EM PRODUÇÃO 11/09/2026 17:32** (487 → **489 rotas**), backup em `/root/backup-tabela-2026-09-11T17-32-47-944Z.json`: Docarmo sem Brasília (2 trechos removidos das rotas SBC ↔ São Luís), Sydnei João Pessoa ↔ Campina Grande (2 rotas novas, 600 passeio/moto e 700 grande nos dois sentidos), Emerson/IDEAL 2 Goiânia → São Luís (Carro Passeio 2.800 → 2.900). O dry-run em produção listou **exatamente** as mesmas mudanças do teste local — as duas tabelas concordavam nesses itens.
   - **Rodada 2 (11/09, a aplicar):** **Angela = TRANSVELLA** (o comercial usa o nome da pessoa, a tabela o da empresa) — moto até 300cc de R$ 500 → R$ 700 nas **duas** rotas SBC ↔ Serra/ES, as únicas que ela tem. E a **vaga de Caruaru da Advaldo** (Carro Passeio R$ 1.900): Caruaru não tinha rota própria, era trajeto da rota "SBC - Natal" e herdava o preço dela.
   - ✔ **Rota nomeada só com UMA categoria é SEGURA.** Eu tinha avisado o contrário. `_nomeada` exige `preco(r)!=null` na categoria pedida (`crmGerarOpcoes`) e o desempate do `crmColetarOpcoes` tem a mesma guarda — então criar a vaga de Caruaru só com Carro Passeio não derruba as outras. Medido: passeio R$ 2.000 (Kroth) → **R$ 1.900** (Advaldo); Carro Grande R$ 2.100 e moto R$ 800 **sem mudança**.
   - **Caruaru como BASE já estava certa** (`recebimento: 150`) — o "base caruaru 150" do Luiz confirmou o que já havia, nada a alterar.
   - O script é **idempotente**: reaplicar um item já gravado não muda nada (rota nova que já existe vira ajuste de preço com valor igual; trecho já removido só gera aviso). Por isso os itens da rodada 1 ficaram no arquivo.
   - **`REMOVER_TRECHOS`** é um bloco NOVO do `atualizar-tabela-precos.mjs` (o oposto de `TRECHOS`): tira da rota uma cidade que ela não atende. Enquanto o trecho errado existe, o motor oferece uma vaga inexistente e o comercial só descobre ao tentar embarcar.
   - ⚠️ O script foi trazido para a branch de deploy (`servidor-obs/atualizar-tabela-precos.mjs`) e os blocos de agosto/04-09 foram **esvaziados** por já estarem aplicados. A versão da branch `obs-servidor-bootstrap` ficou para trás — ao mexer, usar a da branch de deploy.

18. **Coleta/entrega é por CIDADE, não por transportadora — limite da modelagem (11/09/2026):** o relatório do comercial trouxe as taxas de coleta e entrega do **AMOS/SOMA** (Goiânia 200, Aparecida de Goiânia 250, Anápolis 400, Brasília 250, Brasília Lago Norte/Colorado 350, Palmas 200), mas `tabela.cidades[x].coletaEntrega` é **um valor único por cidade, válido para todas as transportadoras** (ver o importador da planilha no `index.html`). Aplicar os números do SOMA mudaria o preço de todo mundo naquelas praças.
   - ✅ **CONFIRMADO PELO LUIZ (11/09):** essas taxas são **só do AMOS/SOMA**. Portanto **não foram aplicadas**.
   - Suportar isso exige `coletaEntrega` por transportadora — mexe na tabela, no importador da planilha e no motor. **Não feito**; anotado como próximo passo.
   - ⚠️ "Brasília Lago Norte e Colorado R$ 350" é **sub-região de cidade**, granularidade que a tabela também não tem (a chave é cidade+UF).
   - As 8 rotas do SOMA (SBC ↔ Goiânia/Brasília 1.200/1.300 e 700/800; Goiânia/Brasília ↔ Palmas idem) **já estavam cadastradas e com os preços certos** — o item 5 do relatório estava desatualizado nessa parte.

14. **3ª trava de segurança + lembrete que não repete (05/09/2026):**
   - **Branch de deploy esclarecida:** a automação/app rodam da **`claude/automate-transport-contract-form-tgvad2`** (padrão do `deploy-automacao.sh`, única com `integracao/vps/`). A `claude/obs-leads-automation-backend-kaga7q` ficou paralela e **não** deploya. Ver o aviso na §0.
   - **3ª trava (status ABERTO)** — reforço da proteção anti-"mensagem por cima do atendente" no fluxo de contato direto: `chatguru-webhook` grava `statusChatguru` no intake; `processarLeadCompleto` pula (não pergunta/cota/envia) quando o status é claramente "atendido" (AGUARDANDO/EM ATENDIMENTO/resolvido/fechado), **além** da trava do responsável. Fail-open seguro: `ABERTO`/vazio/desconhecido **não** bloqueia (não trava contato novo). Botão "Gerar Orçamento" (`fechadoManual`) é **isento**. Log: `chat EM ATENDIMENTO (status …) — pula`.
   - **Lembrete não repete quando o chat some** (`integracao/lembretes.js`): quando a anotação falha com "Chat não encontrado" (número sem conversa no ChatGuru — permanente), marca o frete como tratado + sinaliza **`lembreteChatAusente`** pro operador retomar por outro caminho, em vez de tentar de hora em hora pra sempre (caso frete 1535). Erro transitório (rede/HTTP) continua tentando no próximo ciclo.
   - Selftest da automação (`integracao/vps/selftest.mjs`) passou; deploy confirmado na VPS (obs-automacao reiniciado).

15. **Rastreamento de anúncio (gclid) + armadilhas do ChatGuru (07/09/2026) — VALIDADO EM PRODUÇÃO com lead real:**

   **O caminho do gclid, ponta a ponta:** `obs-cotacao.js` captura `gclid/gbraid/wbraid` + UTMs da URL (guarda 90 dias no localStorage, com fallback pro cookie `_gcl_aw`) → `/webhook/precadastro` → `integracao/precadastro.js` grava no lead **e** no contato do ChatGuru → ficha do lead no CRM mostra **GCLID** e **Campanha** (só leitura, seção "Origem do lead"). Sem o gclid guardado é impossível importar "frete fechado" como conversão offline no Google Ads.
   - Campos gravados no lead, em **snake_case** de propósito (repasse do corpo do POST e do formato do CSV do Ads): `gclid, gbraid, wbraid, utm_source, utm_medium, utm_campaign, utm_term, utm_content, pagina, data_lead`.
   - ⚠️ O save é `merge:true` → **campo vazio não pode sobrescrever valor guardado** (cliente que chega pelo anúncio, some, e volta pelo orgânico de outro aparelho não pode zerar a atribuição). `origemDoLead(b, leadAtual)` lê o lead antes e só grava '' onde não há nada a perder.
   - ⚠️ **`utm_medium`, `utm_term`, `utm_content` e `pagina` NÃO chegam ao backend**: o `obs-cotacao.js` tem DOIS blocos de envio, e a lista completa vai só pra ponte Make (aposentada). O `/webhook/precadastro` recebe apenas `gclid, gbraid, wbraid, utm_source, utm_campaign, data_lead`. Decidido não mexer: a marcação automática do Google manda só o gclid mesmo — `utm_campaign` vem vazio na maioria dos leads de anúncio, e é o Google que resolve campanha/palavra-chave a partir do gclid na importação.

   **⚠️ ChatGuru: contexto ≠ campo personalizado.** São dois armazéns distintos, e o backend só escrevia no primeiro:
   - **Variável de contexto** — `action=chat_update_context`, parâmetro `var__NOME`. Vive em `bot_context`. É o que os DIÁLOGOS leem. **Não aparece na ficha do atendimento.**
   - **Campo personalizado** — `action=chat_update_custom_fields`, parâmetro `field__NOME`. É o que o ATENDENTE VÊ na barra lateral. Resposta de sucesso: `Campos personalizados foram salvos`.
   - A ação e o parâmetro foram descobertos por **sondagem contra a API** (a documentação não é acessível da VPS): as candidatas erradas respondem `ação inválida`; a certa respondeu sobre o *chat*. Método reaproveitável para descobrir outras ações.
   - `ID_CRM` **não** é escrito pelo backend (zero ocorrências no repo) — deve vir de diálogo. Não usar como referência de "o backend já escreve campo personalizado".

   **⚠️ O 9º dígito quebra a busca de chat — e de forma inconsistente.** O WhatsApp guarda o chat sem o 9 em boa parte dos DDDs (45, 68, 31… e até 11), enquanto o formulário manda com. Pior: **as duas ações resolvem o MESMO contato por números diferentes** (no frete do lead guilherme, o contexto só achou SEM o 9 e os campos só COM o 9). `variante9()` já existia com o comentário "usada como 2ª tentativa", mas só a anotação e o diálogo a usavam.
   - Corrigido: `atualizarContexto` e `atualizarCamposPersonalizados` tentam o número normalizado e, no erro "Chat não encontrado", a variante.
   - **Impacto muito além do gclid:** é essa chamada que grava `Cotando=Sim`. Sem ele o encaminhador [6] não repassa a resposta do cliente e **o robô não cota**. O log mostrava dezenas de `chat_update_context falhou` por dia — falha silenciosa que só aparecia lendo o log.
   - Lição de log: o retry guardava o erro da tentativa que falhou e o imprimia junto com `cotando=true`, sugerindo falha onde houve sucesso. Erro agora é limpo quando uma tentativa posterior grava.

   **Telefone inválido não é tratado:** lead pago (DDD 31, 10 dígitos, faltando um) entrou no CRM com gclid mas sem conversa possível no WhatsApp — `chat_add` "sucedeu" e todo o resto falhou. Pendente: validar o formato na entrada e sinalizar no CRM pra contato por outro canal.

   **Pendente pra fechar a conversão offline:** (1) marcar a caixa de consentimento no Google Ads — declaração legal, é o Luiz que assina; (2) criar a ação de conversão **"OBS - Frete fechado"** (importação manual por cliques, valor variável, janela de 90 dias); (3) botão no CRM que exporta CSV dos fretes fechados com gclid nas colunas `Google Click ID, Conversion Name, Conversion Time, Conversion Value`.
