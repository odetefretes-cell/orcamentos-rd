# CRM se preenche sozinho a partir do ChatGuru — via MAKE (sem Firebase CLI)

Objetivo: quando o ChatGuru capta o lead, ele chama um cenário do **Make**, que
**grava o lead direto no CRM** (coleção `crm_leads` do Firebase). O app já escuta
essa coleção em tempo real → o lead aparece na hora na coluna **Novo Lead** e o
app **calcula o frete sozinho**.

Por que funciona sem função na nuvem: a coleção `crm_leads` aceita escrita direta
(é o mesmo caminho que o formulário do site já usa). O Make só precisa fazer uma
chamada HTTP para a **API REST do Firestore**.

```
ChatGuru (HTTP POST) → Make (webhook) → HTTP PATCH no Firestore → lead no CRM
```

---

## Parte A — Cenário no Make (uma vez só)

### 1) Gatilho: Webhook
- Novo cenário → módulo **Webhooks → Custom webhook** → **Add** → dê um nome
  (ex.: `chatguru-crm`) → **Save**.
- O Make mostra uma **URL** (ex.: `https://hook.us2.make.com/xxxxxxxx`).
  **Copie** — o ChatGuru vai chamar essa URL.
- Deixe o webhook "escutando" (**Determine data structure**) e faça um POST de
  teste (a Parte B faz isso) para o Make aprender os campos.

### 2) Ação: gravar no Firestore (HTTP)
Adicione o módulo **HTTP → Make a request** ligado ao webhook, com:

- **URL** (troque nada — o número do telefone entra sozinho):
  ```
  https://firestore.googleapis.com/v1/projects/obs-fretes/databases/(default)/documents/crm_leads/lead_wpp_{{replace(1.telefone; "/[^0-9]/g"; "")}}?key=AIzaSyC4rDP5_lQ6o_ASjM_ndauC2HCq4JxnKuQ
  ```
- **Method:** `PATCH`
- **Headers:** `Content-Type` = `application/json`
- **Body type:** `Raw` → **Content type:** `JSON (application/json)`
- **Request content** (cole; os `{{1.campo}}` são os campos que o ChatGuru manda):
  ```json
  {
    "fields": {
      "id":            { "stringValue": "lead_wpp_{{replace(1.telefone; "/[^0-9]/g"; "")}}" },
      "nome":          { "stringValue": "{{1.nome}}" },
      "telefone":      { "stringValue": "{{1.telefone}}" },
      "email":         { "stringValue": "{{1.email}}" },
      "veiculoDesc":   { "stringValue": "{{1.veiculo}}" },
      "valorVeiculo":  { "stringValue": "{{1.valorVeiculo}}" },
      "funciona":      { "stringValue": "{{1.funciona}}" },
      "blindado":      { "stringValue": "{{1.blindado}}" },
      "origem":        { "stringValue": "{{1.origem}}" },
      "destino":       { "stringValue": "{{1.destino}}" },
      "empresa":       { "stringValue": "{{1.tipo}}" },
      "etapa":         { "stringValue": "novo" },
      "prioridade":    { "stringValue": "quente" },
      "origemLead":    { "stringValue": "whatsapp" },
      "interesse":     { "stringValue": "" },
      "vendedor":      { "stringValue": "" },
      "valorEstimado": { "stringValue": "" },
      "dataEntrada":     { "stringValue": "{{formatDate(now; "YYYY-MM-DD")}}" },
      "ultimaInteracao": { "stringValue": "{{formatDate(now; "YYYY-MM-DDTHH:mm:ssZ")}}" }
    }
  }
  ```
- **Parse response:** Yes.

### 3) Ligar o cenário
Salve e ligue o cenário (**Scheduling ON**).

> **Idempotente:** o ID do lead é `lead_wpp_` + o telefone (só dígitos). Se o mesmo
> cliente vier de novo, atualiza o mesmo lead — não duplica.
> **Dica:** deixe o ChatGuru chamar isto **uma vez**, na captação do lead (para
> não sobrescrever o cálculo que o app já fez).

---

## Parte B — ChatGuru (uma vez só)

No **diálogo** que capta o pedido (nome/telefone/veículo/origem/destino), adicione
uma ação de **HTTP POST** para a **URL do webhook do Make** (a que você copiou):

- **Método:** `POST` · **Cabeçalho:** `Content-Type: application/json`
- **Corpo (JSON)** — mapeie para as variáveis do ChatGuru:
  ```json
  {
    "nome": "*nome*",
    "telefone": "*telefone*",
    "email": "*email*",
    "veiculo": "*veiculo*",
    "valorVeiculo": "*valor_veiculo*",
    "funciona": "*funciona*",
    "blindado": "*blindado*",
    "origem": "*origem*",
    "destino": "*destino*",
    "tipo": "*tipo_cliente*"
  }
  ```
  (Só `nome` e `telefone` são essenciais. `origem`/`destino` no formato
  "Cidade UF", ex.: "São Paulo SP".)

---

## Parte C — Testar

1. No Make, deixe o cenário rodando (ou use **Run once**).
2. Dispare o diálogo no ChatGuru (ou mande um POST de teste pra URL do Make com o
   JSON acima).
3. Veja no Make se o módulo HTTP ficou **verde** (status 200).
4. Abra o **CRM** → o lead deve aparecer na coluna **Novo Lead**, e em segundos o
   app calcula o frete.

### Se der erro
- **403 / PERMISSION_DENIED** no Make: as regras do Firestore podem estar
  fechadas ou com App Check. Me avise — a regra da coleção precisa ser
  `match /crm_leads/{id} { allow read, write: if true; }`.
- **Lead não aparece:** confira se `origemLead` ficou `whatsapp` e se `etapa`
  ficou `novo`. Mande print do módulo HTTP do Make que eu ajusto o mapeamento.

---

## Resumo do fluxo final

```
Cliente → formulário do site → WhatsApp (envia) → ChatGuru
   → ChatGuru chama o Make (POST)
   → Make grava o lead no Firestore (crm_leads)
   → app mostra o lead na hora e calcula o frete sozinho
   → equipe responde o orçamento na conversa (janela já aberta) ✅
```
