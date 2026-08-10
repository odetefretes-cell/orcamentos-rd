# OBS — Ligar `Cotando=Sim` em TODOS os fluxos de orçamento (spec Cowork)

## Por que

O backend colhe os dados da **conversa** (não só do formulário) e lança no CRM pra
cotar — MAS ele só recebe as mensagens do cliente pelo **encaminhador** (diálogo
"Encaminhar Resposta (Backend OBS)"), que só dispara quando **`$Cotando=='Sim'`**.

Se um fluxo coleta dados por **conversa livre** (o cliente digita as respostas) e
**NÃO liga `Cotando=Sim`**, o encaminhador não repassa nada → o backend nunca recebe
a conversa → a IA fica sem os dados → o lead entra **vazio** (caso **Matheus**:
preencheu tudo por texto, mas veio pelo guincho, onde o `Cotando` não é ligado).

**Regra de ouro:** todo ponto que começa a coletar um orçamento por **conversa
livre** tem que ligar `Cotando=Sim` (Contexto de Saída).

---

## Já ligam `Cotando=Sim` (OK)

| Fluxo | ID | Observação |
|---|---|---|
| Formulário do site (3.1) | `6a75e9a15ffa7455b9ce5033` | confirmado no log (`bot_context: {"Cotando":"Sim"}`) |
| Opener – Saudação (3.5) | `6a76382343ec83dc260744f7` | contatos diretos que caem no Opener |

---

## Precisam ligar `Cotando=Sim` (auditar/corrigir)

### 1. Guincho → quando é transporte de veículo
- Entrada guincho: `69d7ae5b68a0815f5a78ca71` (+ cadeia `Guincho - Primeira Pergunta` `69d7aebb…`).
- Guincho é serviço à parte (o backend NÃO cota guincho). **Mas** quando o contato
  que entrou pelo guincho na verdade quer **transporte de veículo** (caso Matheus),
  o atendente redireciona pro orçamento — e esse redirecionamento precisa **ligar
  `Cotando=Sim`** (ou acionar o Opener, que já liga).

### 2. Campanha
- Entrada campanha: `69d7b0d71081c653ccc62508` (`$URA=Campanha_Orcamento`).
- Se a campanha coleta dados de veículo por conversa livre → ligar `Cotando=Sim`
  no diálogo que faz a pergunta.

### 3. URA / Template
- URA-Template: `681b5fd9b26db46921d0c1ec`. A URA coleta passo a passo em CAMPOS
  personalizados (não é conversa livre), então o backend lê pelo **botão** no fim.
- **Porém**, se o cliente responde algo **fora do passo** (texto livre no meio da
  URA), isso se perde sem `Cotando`. Recomendado: ligar `Cotando=Sim` no início da
  URA (quando começa a coletar), como rede de segurança.

### 4. Intake enviado MANUALMENTE pelo atendente
- Se o atendente digita/cola o texto "Para emissão de um orçamento, por favor me
  informe: …" **na mão**, o `Cotando` NÃO é ligado.
- **Regra operacional:** para mandar o intake manual, usar sempre o **Opener** via
  menu **"…" → Acionar um diálogo → "Opener – Saudação"** (ele já liga `Cotando=Sim`)
  — em vez de digitar o texto.

---

## Alternativa mais robusta (opcional, decisão do Cowork)

Em vez de caçar cada fluxo, ligar `Cotando=Sim` num ponto **comum** a todos os
orçamentos — por exemplo, um diálogo que dispara quando a tag **"Emitir orçamento"**
é adicionada (ou outro marcador único que todo lead de orçamento recebe). Assim
qualquer caminho de orçamento habilita o encaminhador automaticamente.

---

## Como testar (por fluxo)

Num contato **novo**, entrar pelo fluxo (guincho→veículo / campanha / URA / manual),
responder os dados **em texto livre** e esperar ~1-2 min: o backend deve **cotar
sozinho** (lead preenchido no CRM + média). Se vier vazio, o `Cotando` daquele fluxo
ainda não está ligado.

> **Diagnóstico:** no Firestore `chatguru_webhook_log`, o POST daquele contato deve
> ter o `texto_mensagem` com os dados **e** `bot_context: {"Cotando":"Sim"}`. Se o
> `Cotando` não estiver "Sim", o encaminhador não repassou.

---

## Estrutura do payload (confirmada no log 10/08)

A ação "POST PARA URL" manda:
- `texto_mensagem` — a mensagem do cliente (é daqui que a IA colhe).
- `bot_context` — as variáveis de contexto: **`{"Cotando":"Sim", "MediaEnviada":"…"}`**.
- `campos_personalizados` — os campos (lidos pelo backend só no botão).
- `celular`, `email`, `nome`, `chat_id`, `origem` (o `origem=fechar` do botão), etc.
