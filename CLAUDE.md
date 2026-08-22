# OBS Transportes — Sistema de Orçamentos + Automação de Leads

Contexto do projeto para o Claude Code. Última atualização: **22/08/2026**.

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

**Deploy hoje:**
- **App:** editar `index.html` (branch de dev) → na VPS `bash ~/obs-repo/servidor-obs/deploy-app.sh`.
- **Automação:** editar `integracao/` (branch de dev) → na VPS `bash ~/obs-repo/servidor-obs/deploy-automacao.sh`.
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
- Branch de desenvolvimento desta automação: **`claude/obs-leads-automation-backend-kaga7q`** (PRs #3 e #4 já mesclados na main).

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
  em atendimento é pulado de propósito — trava anti-"falar por cima do atendente").
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
