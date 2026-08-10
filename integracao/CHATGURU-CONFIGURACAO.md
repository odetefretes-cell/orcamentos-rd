# OBS Transportes — Configuração ChatGuru (resumo técnico)

**Conta:** s22.chatguru.app — "Obs Transportes"
**Chatbot ID:** `67e2f6b3198069809dfaf169`
**Base de edição dos diálogos:** `https://s22.chatguru.app/chatbot/67e2f6b3198069809dfaf169/dialog/{id}/edit`
**Última atualização:** 10/08/2026 (mantida pela equipe/Cowork; esta é a cópia versionada no repo)

---

## 1. Objetivo

Integrar o ChatGuru ao backend da OBS e organizar o fluxo de orçamento:

1. **Captura do lead** (formulário) → POST automático pro backend.
2. **Envio da estimativa** → automático (backend, leads do formulário) ou manual (botão do atendente).
3. **Captura das respostas do cliente** (encaminhador) → o backend acumula e cota.
4. **Resposta de interesse** e **pedido de atendente** → tratados por diálogo.

---

## 2. Endpoints do backend usados

| Uso | URL | Método |
|---|---|---|
| Captura de lead (formulário) | `https://southamerica-east1-obs-fretes.cloudfunctions.net/chatguruWebhook` | POST |
| Geração/envio da estimativa (média) | `https://chatguruwebhook-5xdjufaxua-rj.a.run.app` | POST |

> **Payload:** a ação "POST PARA URL" do ChatGuru envia o **payload nativo** (nome,
> telefone/celular, `chat_id`, texto da mensagem e Campos Personalizados). Não dá
> pra renomear campos pela UI — o backend lê o formato nativo.

---

## 3. Diálogos (grupo "ChatGuru Integrações")

### 3.1. Webhook Lead Novo (Formulário) — ID `6a75e9a15ffa7455b9ce5033`
- Contínuo · Gatilho `!word=='Solicitação de orçamento'` · POST → `.../chatguruWebhook`.
- **Contexto de Saída:** `Cotando = Sim` (liga o encaminhador — §11).

### 3.2. Gerar Orçamento (Backend OBS) — botão manual — ID `6a764da144d8d8cf0d70356a`
- Manual · Invocável · POST → `.../chatguruwebhook-5xdjufaxua-rj.a.run.app`.
- **Campo Origem = `fechar`** → chega como `origem: "fechar"`; o backend trata como "processar na hora".
- **Contexto de Saída:** `MediaEnviada = Sim`.
- Acionar: conversa → "..." → "Acionar um diálogo" → "Gerar Orçamento (Backend OBS)".

### 3.3. Interesse pós-média (DENTRO do expediente) — ID `6a765e9e60ffafe1d1349210`
- Gatilho: frases de interesse + `!word=='sim'`, **AND `$MediaEnviada=='Sim'`**, AND horário comercial.
- Ações: STATUS `AGUARDANDO` + RESPONDER `/confirmar` (base a base × coleta/entrega).
- **Contexto de Saída:** `MediaEnviada = Respondido`.

### 3.4. Interesse (FORA do expediente) — ID `6a7667370f1264e13e5bfac2`
- Igual ao 3.3, mas fora do horário → mensagem de retorno + `AGUARDANDO`.
- **Contexto de Saída:** `MediaEnviada = Respondido`.
- (3.3 e 3.4 são mutuamente exclusivos pela lógica de horário.)

### 3.5. Opener – Saudação / Pedido de orçamento — ID `6a76382343ec83dc260744f7`
- Invocável. Envia o formulário de intake ("Para emissão de um orçamento, por favor me informe: …") e liga `Cotando=Sim`.
- **Gatilho (3 travas):**
  `(saudações/intenções) AND !new_chat AND $Template!='True' AND $Template!='1'`.
  - Saudações/intenções (ampliadas 10/08): bom dia, boa tarde, boa noite, preciso de um orçamento, **oi, olá, ola, opa, boa, orçamento, orcamento, cotação, cotacao, guincho, cegonha, transporte, frete**.
  - ⚠️ Editar essa condição pelos **chips** do builder (o textarea avançado não persiste — o ChatGuru reconstrói dos chips no submit).
- **As 3 travas:**
  1. `!new_chat` — só a primeira interação (não dispara em contato já em tratativa).
     ⚠️ Antes era `!new_chat OR !status=='ABERTO'`; o `!status=='ABERTO'` fazia o intake disparar em qualquer contato aberto — removido.
  2. Contatos existentes (follow-up) não são `new_chat` → já ficam de fora.
  3. `$Template!='True' AND $Template!='1'` — **contatos incluídos por template** (equipe manda "Olá {nome}… Aqui é da OBS" + tag "Emitir orçamento") passam pelo diálogo **"URA - Template"** (ID `681b5fd9b26db46921d0c1ec`), que grava `$Template`. Sem essa trava, o Opener disparava junto e mandava o intake por engano (caso "Alex"). Com ela, o contato segue só pelo fluxo da URA.
- **Limitação (retorno de cliente antigo):** o chat reabre como ABERTO (não é `new_chat`), então o Opener **não** dispara sozinho no retorno — o atendente aciona manualmente (Invocável). Leads do formulário não são afetados (3.1 liga o `Cotando` sempre).

---

## 4. Horário de atendimento (fuso America/Sao_Paulo)

| Dia | Aberto | Fechado |
|---|---|---|
| Seg–Sex | 09:00 – 17:59 | resto |
| Sábado | 08:00 – 11:59 | resto |
| Domingo | — | dia todo |

Sintaxe: dias `!monday`…`!sunday`; hora `!current_time>='HH:MM'` (string, 2 dígitos).
⚠️ Conferir que o fuso da conta ChatGuru = **America/Sao_Paulo**.

---

## 9. `MediaEnviada` via API (leads do formulário) — CONFIRMADO EM PRODUÇÃO

`MediaEnviada` é **variável de contexto** (`$MediaEnviada`). O botão 3.2 grava por
Contexto de Saída; nos leads do formulário o **backend grava via API** logo após
enviar a média, com `action=chat_update_context` + `var__MediaEnviada=Sim` — assim
os gatilhos 3.3/3.4 disparam também nos envios automáticos. **Validado no log**
(`[prepararResposta] MediaEnviada=Sim marcada...`).

Credenciais (segredos do backend): endpoint `https://s22.chatguru.app/api/v1`,
`account_id=67e2e2f7895b4e2e2ed944b0`, `phone_id=67ec49e82415efebeb055070`, `key` SECRETA.

**Ações da API v1 (referência):** `chat_update_context` (variável),
`chat_update_custom_fields` (campo), `chat_update_name`, `note_add`, `chat_add`,
`chat_add_status`, `message_send`, `message_file_send`, `message_status`,
`dialog_execute`. **Não existe** ação de tag; **não existe** ação de status/
responsável/não-lido via API (por isso §12 é diálogo).

---

## 10. Aviso de fora de expediente (backend) — IMPLEMENTADO

O backend anexa um aviso ao final das mensagens automáticas (média e aviso ao
cliente) quando enviadas fora do horário (fuso America/Sao_Paulo). Feito no
momento do envio, uma única vez. Texto:

```
🕐 Estamos fora do horário de atendimento no momento (seg a sex das 9h às 18h,
e sáb das 8h às 12h). Sua solicitação já está registrada — assim que retornarmos,
damos sequência por aqui. 😉
```

---

## 11. Encaminhador de Respostas (chavinha `Cotando`)

Enquanto um orçamento está sendo montado, as respostas soltas do cliente são
repassadas ao backend, que acumula (~60s) e cota.

- **`Cotando=Sim`** ligado em: 3.1 Formulário (`6a75e9a15ffa7455b9ce5033`) e Opener (`6a76382343ec83dc260744f7`).
- **Diálogo "Encaminhar Resposta (Backend OBS)"** — ID `6a776678cb274c43e5f40945`:
  - Contínuo · Automático · Gatilho: `anything_else and $Cotando=='Sim' and $MediaEnviada!='Sim' and $MediaEnviada!='Respondido'`.
  - Ação: POST → webhook, **Campo Origem VAZIO** (pra acumular, não processar na hora).
- **Parada automática:** quando a média sai, o backend grava `MediaEnviada=Sim` → o gatilho para sozinho; 3.3/3.4 assumem.

---

## 12. Diálogo "Falar com Atendente" — ID `6a79d1af3217110db81943a6`

Cliente pede uma pessoa → **AGUARDANDO + delegar ao Comercial (rodízio) + não lido**.

- Contínuo · Automático · Gatilho: frases "atendente/humano/pessoa/me liga/…".
- **Ações:** RESPONDER (aviso curto) · **LEITURA = não lido** · **DELEGAR = Comercial + rodízio** (opções `autodelegate_to_group` + `autodelegate_jump_if_offline`) · **STATUS = AGUARDANDO**.
- **Contexto de Saída:** `Cotando = Nao` (para o encaminhador).
- Depto **Comercial** = Flavia Ottati, Yasmin Freitas, Thiago Lucca (rodízio segue o departamento).
- ⚠️ Sobreposição: "quero um atendente" contém "quero"; se `MediaEnviada=='Sim'`, o 3.3 também dispara (sai uma mensagem a mais, mas o humano assume mesmo assim).
- **Backend:** a IA marca `pediuAtendente=true` → decisão humano, sem perguntar dados (`motivo="cliente pediu atendente"`).

---

## 13. URA de Orçamento — passo "Valor do veículo" (10/08/2026)

A URA (máquina de estados que coleta os dados antes de passar pro atendente) ganhou
um passo **Valor do veículo** entre *Modelo* e *Data de envio*. Guarda no campo
personalizado **"Valor do veículo"** (ID `6a79f48aa4fd7f150cf35681`).

- **Pergunta:** `1.1.1.1.1.1.1 - Modelo -> Valor` (`680a8df296644d68e2f5d6bb`) — `$URA='OrcamentoValor'` + "Qual o valor do veículo?".
- **Captura:** `1.1.1.1.1.1.1.V` (`6a79f4e85fcfd9cdf7e6196b`) — grava o valor no campo, avança pra Data de envio.
- **Lembrete 5 min:** `T - Valor` (`6a7a0ab97ada0f9bd240abde`) — reenvia a pergunta se o cliente não respondeu (`$URA=='OrcamentoValor' e $Timer=='False'`), depois escala pro atendente.

> **Backend:** o campo "Valor do veículo" é lido no acionamento do botão (harvest —
> `CAMPO_RELEVANTE` casa "valor"). Complementa a regra do backend de cotar a média
> **mesmo sem valor** (contatos livres que não passam pela URA): URA coleta quando dá,
> e o backend cota como estimativa quando não tem o valor.

---

## O que o BACKEND faz (resumo, não mexer sem sincronizar)

- Acumula mensagens por telefone (janela ~60s) e fecha o lead.
- Junta o **texto da conversa**; colhe **campos personalizados só no botão** (fonte secundária — a conversa tem prioridade sobre campos velhos).
- Botão `origem=fechar` → processa na hora.
- **Reinicia o ciclo** quando o mesmo número volta a pedir (formulário/botão).
- Calcula a média (Fase B) e envia; grava **`MediaEnviada=Sim`** via API.
- **Cota a média mesmo SEM o valor** do veículo (origem+destino+veículo bastam; estimativa).
- Entende valor em vários formatos ("Fipe 419k", "419 mil", "50k").
- Aviso de **fora de expediente**.
- **`pediuAtendente`** → humano sem perguntar.
- **Fase C** reativa o encaminhador (liga `Cotando`, limpa `MediaEnviada`) ao pedir dado que falta.
