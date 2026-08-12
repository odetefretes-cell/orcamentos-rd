# OBS Transportes — Configuração ChatGuru (resumo técnico)

**Conta:** s22.chatguru.app — "Obs Transportes"
**Chatbot ID:** `67e2f6b3198069809dfaf169`
**Base de edição dos diálogos:** `https://s22.chatguru.app/chatbot/67e2f6b3198069809dfaf169/dialog/{id}/edit`
**Última atualização:** 12/08/2026 (mantida pela equipe/Cowork; esta é a cópia versionada no repo)

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
- **Tipo:** **Padrão (`standard`)** ⚠️ **— a correção FINAL (v14, 11/08).** · **Máx. Execuções por chat: 1** · Invocável.
- **Gatilho (ATUAL): gatilho de PALAVRA "contém" (lista ampla).**
  Lista (contém): `bom dia, boa tarde, boa noite, oi, ola, olá, opa, eae, orçamento, orcamento, cotação, cotacao, cotar, frete, mudança, mudanca, transporte, transportar, guincho, cegonha, carro, veículo, veiculo, moto, preciso, gostaria, quero, quanto, valor, preço, preco, buscar, levar, custa`
  `+ $Cotando!='Sim' AND $MediaEnviada!='Sim' AND $MediaEnviada!='Respondido' AND $Template!='True' AND $Template!='1' + exclusões !text!= (guincho/campanha/'Solicitação de orçamento')`
  - **🎯 CAUSA RAIZ FINAL — era o TIPO do diálogo.** No ChatGuru, diálogo **"Contínuo" (soft) NÃO dispara na mensagem FRIA de um contato novo — só o tipo "Padrão" dispara.** O Opener estava como "Contínuo" o tempo todo → por isso NENHUMA condição (palavra, `new_chat`, `anything_else`) disparava a frio. Confirmado pelo caso "josé" (funcionou porque veio pela URA, cujos diálogos são "Padrão"). **Fix: Tipo → "Padrão".** (Salvar o tipo só gravou via `form.submit()` — os cliques em "Salvar Alterações" não submetiam.)
  - **Sobre "Palavra":** casa quando a mensagem **CONTÉM** a palavra (não é frase exata) → pega "Bom diaa", "Preciso de um frete", "Queria uma cotação".
  - **Handoff com o encaminhador:** `$Cotando!='Sim'` evita redisparo; depois o encaminhador (`anything_else + $Cotando=='Sim'`) assume. `Máx. Execuções=1`.
  - **Exclusões `!text!=`:** evitam disparar sobre guincho/campanha (canned) e formulário.
  - **Efeito colateral aceito:** contato que escreve uma dessas palavras sobre outro assunto também recebe o intake (recuperável).
  - ⚠️ Editar: **"Gatilho Avançado" → `manual_trigger_input` → "✓ Salvar" → "Salvar Alterações"**. Trocar o TIPO: pode precisar de `form.submit()` (o botão às vezes não submete).
- **Limitação (retorno de cliente antigo):** conversa já aberta não reprocessa; o atendente aciona o Opener manual (Invocável).

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

## 14. Entradas por mensagem-canned do site (Guincho / Campanha) — 10/08/2026

Botões de WhatsApp no site abrem a conversa com um texto pronto; cada um tem um
diálogo de entrada com gatilho `!text==` (match exato da mensagem inteira):

| Texto canned | ID entrada | `$URA` |
|---|---|---|
| `Olá! Estou procurando orçamento de guincho.` | `69d7ae5b68a0815f5a78ca71` | `Guincho` → cadeia Guincho |
| `Olá! Estou no site e quero solicitar um orçamento.` | `69d7b0d71081c653ccc62508` | `Campanha_Orcamento` |

- **Bug corrigido:** a entrada do guincho estava `node_type=manual` (não disparava sozinha) → mudada pra `standard` (caso Matheus).
- **Anti-conflito com o Opener:** como o Opener reconhece "olá/orçamento/guincho", foram adicionadas exclusões ao gatilho dele: `and !text!='Olá! Estou procurando orçamento de guincho.' and !text!='Olá! Estou no site e quero solicitar um orçamento.'` — assim mensagem-canned → só o fluxo dedicado; saudação espontânea → Opener.

---

## 15. `Cotando=Sim` em TODOS os fluxos de orçamento — 10/08/2026

O encaminhador (`6a776678cb274c43e5f40945`) só repassa a conversa ao backend quando
**`$Cotando=='Sim'`**. Fluxo que coleta orçamento sem ligar `Cotando` → o backend
nunca recebe a conversa → lead **vazio** (caso Matheus, via guincho). Correção: ligar
`Cotando=Sim` em **todos** os pontos de entrada.

| Fluxo | ID entrada | Cotando=Sim |
|---|---|---|
| Formulário (3.1) | `6a75e9a15ffa7455b9ce5033` | ✅ (já tinha) |
| Opener (3.5) | `6a76382343ec83dc260744f7` | ✅ (já tinha) |
| Guincho | `69d7ae5b68a0815f5a78ca71` | ✅ adicionado |
| Campanha | `69d7b0d71081c653ccc62508` | ✅ adicionado |
| URA / Template | `681b5fd9b26db46921d0c1ec` | ✅ adicionado (rede de segurança) |

- **Guincho = conversa livre** → precisava do `Cotando` (era o bug do Matheus).
- **Campanha/URA = estruturados** (campos + botão) → `Cotando` é rede de segurança: o
  `anything_else` só repassa texto **fora do roteiro**, sem atrapalhar os passos.
- **Diagnóstico:** no `chatguru_webhook_log`, o POST do contato deve ter `texto_mensagem`
  com os dados **e** `bot_context: {"Cotando":"Sim"}`.

---

## 16. Interesse (/confirmar) disparando durante atendimento humano — 12/08/2026

**Problema:** os diálogos **3.3** (`6a765e9e60ffafe1d1349210`) e **3.4**
(`6a7667370f1264e13e5bfac2`) mandam o `/confirmar` sempre que o cliente diz "sim"/"quero"
e `$MediaEnviada=='Sim'` — **mesmo com o operador já atendendo** (caso Alipio: a Yasmin
atendia, o "Sim" era pra ela, e o bot injetou o /confirmar).

**Solução (validada) — trava `!status=='ABERTO'`** no gatilho dos dois. Significado dos
status na OBS: **ABERTO** = bot no controle (média enviada, ninguém assumiu);
**AGUARDANDO / EM ATENDIMENTO** = operador atendendo. O passo 3.2 **não mexe no status**,
e o AGUARDANDO só é setado pelo próprio diálogo de interesse **depois** de disparar — então,
no "sim" do fluxo normal, o chat está ABERTO.

Condição alvo (3.3 e 3.4): `(…palavras…) and $MediaEnviada=='Sim' and !status=='ABERTO'`
- "sim" no fluxo normal (ABERTO) → dispara ✓. Operador já assumiu (AGUARDANDO/EM ATEND.) → não dispara ✓.

> ⚠️ **Adicionar SÓ pelo builder nativo** (GATILHO → "Adicionar Gatilho" → "Status do Chat"
> = ABERTO, ligado por **AND**). Texto cru é descartado no save. Repetir em 3.3 **e** 3.4.
> **Requisito de processo:** operador tira o chat de ABERTO ao assumir (já é o hábito da equipe).
> **Opção global (perguntar ao suporte):** pausar o bot quando o atendente assume.

## 17. Horário — almoço 12:30–13:30 (seg a sex) — 12/08/2026

Não há "Horário de Atendimento" central nesta conta — o expediente está **hardcoded em
~13 diálogos** (família "FH – Fora de Horário" + interesse fora + fora de horário), com
condições **não uniformes**. Decisão: aplicar o almoço só nos **2 diálogos que o cliente
encosta** e levar a **consolidação central** pro suporte.

| Diálogo | ID |
|---|---|
| Interesse FORA de expediente | `6a7667370f1264e13e5bfac2` |
| Fora de horário – Em atendimento / Aguardando | `67e2f6c26628887da6f35028` |

Em cada um, no **Gatilho Avançado**, trocar `!current_time>='18:00'` por:
`!current_time>='18:00' or (!current_time>='12:30' and !current_time<'13:30')` → **Salvar**.
Resultado: **12:30–13:30 conta como fora do expediente**. Os outros 11 diálogos "FH –
Resposta Inválida" (edge-cases mid-URA) ficam sem o almoço até a centralização pelo suporte.

---

## 18. Opener parou de gravar `Cotando=Sim` (contato direto não cota) — 12/08/2026

**Sintoma:** contato direto (edson) — o Opener mandou o intake certo, o cliente
respondeu os dados por texto (Celta 2015, R$25.000, Orós/CE → Guarulhos), mas
**nenhum lead / nenhuma média**. Painel vazio, "Ninguém Delegado".

**Diagnóstico (log, confirmado):** a resposta do edson **não chegou** ao backend
(`gcloud logging` na janela dele = vazio; nada no `chatguruWebhook`). Comparando:
o **Antonio** (mesmo horário) entrou pela **URA/Template** com **`bot_context:
{"Cotando":"Sim"}`** e foi recebido normal. Ou seja: o encaminhador
(`anything_else and $Cotando=='Sim'`) **funciona** — o que faltou foi o
**`Cotando=Sim` não estar ativo** no fluxo do Opener.

**Causa provável:** o **Contexto de Saída `Cotando=Sim` do Opener se perdeu** quando
o diálogo foi trocado pro tipo **"Padrão"** (correção da §3.5). Backend/IA/cálculo
estão OK — o furo é o dado do cliente não ser repassado.

**Correção:** Opener (`6a76382343ec83dc260744f7`) → **Contexto de Saída** →
confirmar/re-adicionar **`Cotando = Sim`** → Salvar.

**Blindagem (recomendada):** ligar `Cotando=Sim` também por um ponto ÚNICO — um
diálogo que dispara quando a **tag "Emitir orçamento"** é adicionada (todo lead de
orçamento recebe). Assim não depende só do Opener; qualquer caminho de orçamento
habilita o encaminhador. (Era a "alternativa não aplicada" da §15.)

**Teste:** contato novo → "bom dia" → intake → responder dados → ~1-2 min → média
sozinha. Conferir no log: `firebase functions:log --only chatguruWebhook | grep bot_context`
→ tem que ter **`"Cotando":"Sim"`**.

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
