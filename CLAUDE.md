# OBS Transportes — Sistema de Orçamentos + Automação de Leads

Contexto do projeto para o Claude Code. Última atualização: **07/08/2026**.

> **Resumo em uma frase:** app single-file (`index.html`) de CRM/orçamentos que roda
> no Firebase (Firestore + Hosting), mais um backend de **Cloud Functions** (pasta
> `integracao/`) que automatiza a entrada de leads pelo ChatGuru, calcula a média do
> frete e envia o orçamento no WhatsApp — 24h, sem depender do navegador aberto.

---

## 1. Onde as coisas rodam

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

Grupo de diálogos "ChatGuru Integrações":

1. **Webhook Lead Novo (Formulário)** — gatilho `!word=='Solicitação de orçamento'` →
   POST para `.../chatguruWebhook`. (Automático.)
2. **Gerar Orçamento (Backend OBS)** — diálogo **manual** (o atendente aciona em
   "**...**" → "Acionar um diálogo"). POST para o webhook + grava `MediaEnviada=Sim`.
   Usado nos **contatos diretos** (atendente coleta as infos e aciona).
3. **Interesse pós-média (dentro do expediente)** — gatilho: frases de interesse +
   `$MediaEnviada=='Sim'` + horário comercial → responde `/confirmar` (base a base ×
   coleta/entrega) + status AGUARDANDO.
4. **Interesse (fora do expediente)** — igual, mas manda mensagem de retorno.

**`MediaEnviada`** é uma **variável de contexto** do ChatGuru. O botão [2] grava via
"Contexto de Saída"; nos leads do formulário (envio automático), o **backend grava via
API** (`chat_update_context`, em `prepararResposta` após enviar a média) — assim os
diálogos 3/4 disparam nos dois caminhos.

⚠️ **Conferir:** fuso da conta ChatGuru = **America/Sao_Paulo** (senão os horários 3/4 saem deslocados).

---

## 8. Botão no CRM (app)

No modal do lead existe **"🤖 Enviar automático"** (`crmForcarAutomatico` no `index.html`):
limpa marcas de atenção humana, usa o valor já calculado (só recalcula se faltar) e salva
→ dispara `prepararResposta` (envia). Serve pra empurrar manualmente um lead pro fluxo.

---

## 9. Ligar/desligar e testar

- **Ligar o envio real:** `crm_config/config.envioAtivo = true`. Desligar: `false`.
- **Teste automático 24h:** com o navegador **fechado**, dispare um lead pelo formulário →
  a média deve chegar sozinha. Log: `firebase functions:log --only criarLeadNoCrm` (procure
  `média backend R$ ...`).
- Roteiro completo: `integracao/ROTEIRO-DE-TESTE.md`.
- Logs úteis: `firebase functions:log --only prepararResposta` (procure `ENVIADO`,
  `ERRO ao enviar`, `AVISO HUMANO`, `enviando para 55...`).

---

## 10. Pendências / próximas melhorias (a partir daqui)

- [ ] **Múltiplos veículos / frota** numa mesma cotação (hoje o cálculo é por 1 veículo; a IA extrai 1). Cliente Muve Locadora foi o caso real (PJ, ~38 veículos).
- [ ] **Sincronizar responsável no ChatGuru** no fluxo 100% automático (a API não reatribui responsável de chat existente; hoje o responsável certo fica no CRM. Nos contatos diretos, o Cowork delega na tela).
- [ ] **Fase C em produção:** decidir se o robô pergunta sozinho (fase C automática) ou se fica só o botão do atendente (recomendado hoje, pra não falar por cima do atendente).
- [ ] Limpar leads **duplicados antigos** (`lead_wpp_{número completo}`) criados antes da correção de chave.
- [ ] Manter `calc-fretes.js` **em sincronia** com a lógica de cálculo do `index.html` (é uma cópia fiel; se mudar a regra no app, atualizar aqui).

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
