# OBS — Encaminhador de Respostas (ChatGuru) — spec para montar

**Objetivo:** fazer as **respostas do cliente** chegarem ao backend enquanto um
orçamento está sendo montado. Hoje o backend só recebe o **formulário** (diálogo
3.1) e o **botão manual** (3.2); qualquer mensagem solta do cliente depois disso
**não chega** — por isso "o cliente responde e não acontece nada" (casos André e
Andres). O backend **já sabe acumular** várias mensagens e cotar depois de ~60s;
só falta o ChatGuru **encaminhar** essas mensagens.

**Não precisa de deploy** — é 100% configuração no ChatGuru. O backend já está pronto.

> **STATUS: MONTADO (08/08/2026).** IDs reais em produção:
> - Encaminhador "Encaminhar Resposta (Backend OBS)": `6a776678cb274c43e5f40945`
> - `Cotando=Sim` ligado em: 3.1 Formulário (`6a75e9a15ffa7455b9ce5033`) e Opener/Saudação (`6a76382343ec83dc260744f7`)
> - Gatilho usado: `anything_else and $Cotando=='Sim' and $MediaEnviada!='Sim' and $MediaEnviada!='Respondido'`
> - Falta: rodar o teste de ponta a ponta (contato direto multi-mensagem + Fase C).

---

## Dados de referência

- **Conta:** s22.chatguru.app — "Obs Transportes"
- **Chatbot ID:** `67e2f6b3198069809dfaf169`
- **Webhook do backend (a mesma dos outros diálogos):**
  `https://chatguruwebhook-5xdjufaxua-rj.a.run.app`  (método **POST**)
- **Diálogos já existentes (grupo "ChatGuru Integrações"):**
  - 3.1 Webhook Lead Novo (Formulário) — ID `6a75e9a15ffa7455b9ce5033`
  - 3.2 Gerar Orçamento (Backend OBS) — ID `6a764da144d8d8cf0d70356a`
  - 3.3 Interesse pós-média (dentro) — ID `6a765e9e60ffafe1d1349210`
  - 3.4 Interesse pós-média (fora) — ID `6a7667370f1264e13e5bfac2`

---

## Ideia (chavinha `Cotando`)

Usamos uma **variável de contexto** nova, `Cotando`:
- Liga (`Cotando=Sim`) **quando um orçamento começa**.
- O **encaminhador** só roda enquanto `Cotando=='Sim'` **e** `MediaEnviada!='Sim'`.
- Quando a média é enviada, o **backend grava `MediaEnviada=Sim`** (já funciona) →
  o encaminhador **para sozinho**. Depois entram os diálogos de interesse 3.3/3.4.

Assim, não encaminhamos a conversa de todo mundo — só a de quem está de fato
pedindo orçamento.

---

## Passo 1 — Ligar `Cotando=Sim` no início do orçamento

Adicionar, em **"Contexto de Saída"**, a variável `Cotando = Sim` em:

1. **Diálogo 3.1 — Webhook Lead Novo (Formulário)** (ID `6a75e9a15ffa7455b9ce5033`).
   - Ele já tem Contexto de Saída? Se sim, acrescenta a linha; se não, cria.
   - Variável: `Cotando`  ·  Valor: `Sim`

2. **Diálogo do "abridor" do contato direto** — aquele que manda
   *"Para emissão de um orçamento, por favor me informe: …"* (o atendente usa nos
   contatos que chegam sem formulário).
   - **Localizar** esse diálogo no grupo (ou onde estiver) e adicionar o mesmo
     `Cotando = Sim` no Contexto de Saída.
   - ⚠️ Se esse texto **não for um diálogo** (for uma "Resposta Rápida" manual do
     atendente), criar um diálogo contínuo simples com gatilho na frase de
     abertura (ou um botão manual "Iniciar Orçamento") cujo **único efeito** seja
     gravar `Cotando = Sim`. O importante é que, ao começar um atendimento de
     orçamento direto, `Cotando` fique `Sim`.

> **Observação de timing (ok, é o esperado):** a variável de Contexto de Saída
> passa a valer **a partir da próxima** mensagem do cliente — exatamente o que
> queremos (o encaminhador captura as respostas seguintes, não a mensagem inicial).

---

## Passo 2 — Criar o diálogo "Encaminhar Resposta (Backend OBS)"

Novo diálogo no grupo "ChatGuru Integrações":

- **Título:** `Encaminhar Resposta (Backend OBS)`
- **Tipo:** Contínuo · **Execução: Automático** · Máx. Execuções: 9999
- **Gatilho (Gatilho Avançado):** casar **qualquer mensagem** do cliente.
  - Confirmar a sintaxe de "qualquer mensagem" na interface (ex.: regex `.*`).
- **Condições adicionais (as duas juntas):**
  - `$Cotando == 'Sim'`
  - `$MediaEnviada != 'Sim'`
  - *(recomendado)* também `$MediaEnviada != 'Respondido'` — pra não reencaminhar
    depois que o cliente já demonstrou interesse.
- **Ação:** CRM → **POST PARA URL** → `https://chatguruwebhook-5xdjufaxua-rj.a.run.app`
  - **Campo ORIGEM: DEIXAR VAZIO** ⚠️ (NÃO colocar "fechar" — senão o backend
    processa na hora e não dá tempo de acumular as várias mensagens do cliente).
  - Sem Contexto de Saída aqui (não mexe em `Cotando`/`MediaEnviada`).

> Por que ORIGEM vazio: o `origem: "fechar"` é o sinal de "processar imediato"
> (usado só no botão 3.2). No encaminhador a gente QUER a janela de ~60s pra
> juntar as mensagens que o cliente manda em sequência (ex.: "carro velho",
> "ano 1997", "de Diadema pra Campina Grande"…).

---

## Passo 3 — Parada automática (já pronta, só conferir)

Nada a criar: quando a média é enviada, o backend grava `MediaEnviada=Sim` (via
API `chat_update_context` — já validado em produção). Como o gatilho do Passo 2
exige `MediaEnviada != 'Sim'`, o encaminhador **para sozinho** nesse momento, e os
diálogos 3.3/3.4 (interesse) assumem. Se um lead for para atendimento humano
(sem média), o backend não reprocessa em loop (há trava `iaProcessado`), então o
encaminhamento extra é inofensivo.

---

## Verificação (fazer 1 teste após montar)

1. **Contato direto (caso Andres):** num contato de teste, ligar `Cotando=Sim`
   (abridor). O contato manda os dados em **várias mensagens** (veículo, ano,
   origem, destino). Esperar ~1-2 min → o backend deve **cotar e responder**
   sozinho.
2. **Fase C (caso André):** disparar um formulário **sem valor** do veículo →
   o robô pergunta o valor → responder o valor → em ~1-2 min a **média** deve
   chegar sozinha.
3. **Conferir o payload (opcional, se algo falhar):** no Firestore, coleção
   `chatguru_webhook_log`, abrir o último documento e ver o campo `raw` — confirmar
   que o **texto da mensagem do cliente** veio no POST (o backend lê vários nomes
   de campo; o texto nativo do ChatGuru é reconhecido).

---

## O que o backend já faz (não mexer)

- Acumula as mensagens por telefone e fecha o lead após ~60s de silêncio.
- Junta **texto + campos personalizados** do ChatGuru pra IA extrair
  origem/destino/veículo/valor.
- Reinicia o ciclo quando o **mesmo número** volta a pedir (formulário/botão).
- Grava `MediaEnviada=Sim` ao enviar a média (liga o follow-up e desliga o
  encaminhador).
- Anexa aviso de "fora de expediente" quando envia fora do horário.

**Resumo pro Cowork:** criar a variável `Cotando`, ligá-la no início (Passo 1),
criar o diálogo encaminhador (Passo 2, **ORIGEM vazio**), e testar (Fase C +
contato direto). O resto o backend resolve.
