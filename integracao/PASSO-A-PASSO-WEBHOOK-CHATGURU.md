# Etapa 1 + 2 — Receber o webhook do ChatGuru e salvar a mensagem

Esta é a **porta de entrada** da automação. Quando um lead chega no ChatGuru com
a conversa aberta, o ChatGuru faz um **POST** (webhook) para a nossa função na
nuvem, mandando o texto da mensagem do cliente. A função:

1. **recebe** esse POST;
2. **salva** a mensagem no Firestore, associada ao contato (telefone);
3. **loga** tudo que chegou, pra você conferir enquanto testa.

> Ainda **não** chamamos o Claude, **não** calculamos orçamento e **não**
> respondemos. Aqui a gente só valida que a entrada está chegando certinho.
> As próximas etapas vêm depois, uma de cada vez.

---

## Onde os dados vão parar (Firestore)

Duas coleções **novas** (não mexem no seu CRM atual `crm_leads`):

| Coleção | O que guarda |
|---|---|
| `crm_leads_intake/{telefone}` | Um documento por **contato**. Acumula as mensagens daquele cliente no array `mensagens`. É daqui que a Etapa 3 vai "fechar" o lead após 60s. |
| `chatguru_webhook_log/{auto}` | Um documento por **POST recebido**, com o corpo **cru** (`raw`) que o ChatGuru mandou. É a "caixa-preta" pra você ver o formato real dos campos. |

---

## Parte A — Subir a função (uma vez só)

Precisa ser feito por alguém com acesso ao Firebase da OBS (projeto
`obs-fretes`).

1. Instalar as ferramentas (se ainda não tiver):
   ```bash
   npm install -g firebase-tools
   firebase login
   ```
2. Na pasta do projeto (onde está o `firebase.json`):
   ```bash
   cd integracao && npm install && cd ..
   firebase deploy --only functions:chatguruWebhook
   ```
3. No fim, o terminal mostra a URL da função, algo como:
   ```
   https://southamerica-east1-obs-fretes.cloudfunctions.net/chatguruWebhook
   ```
   **Guarde essa URL** — é ela que o ChatGuru vai chamar.

> A função `obsIntegracao` que você já tinha continua funcionando normalmente —
> essa é uma função **nova e separada**. Se quiser subir as duas de uma vez:
> `firebase deploy --only functions`.

### (Opcional) Proteger com um segredo
Pra só o ChatGuru poder chamar a função:
```bash
firebase functions:secrets:set CG_WEBHOOK_SECRET
# digite um segredo qualquer, ex.: obs-2026-xyz
firebase deploy --only functions:chatguruWebhook
```
Depois, no ChatGuru, envie o cabeçalho `X-CG-Secret` com esse mesmo valor.
Pra **começar testando**, pode pular isso — sem o segredo, a função aceita o POST.

---

## Parte B — Testar SEM o ChatGuru (recomendado antes de tudo)

Antes de mexer no ChatGuru, garanta que a função está no ar e salvando.

1. **No navegador:** abra a URL da função. Deve responder:
   ```json
   {"ok":true,"servico":"chatguruWebhook","dica":"...","janelaSegundos":60}
   ```
   Se apareceu isso, a função está no ar. ✅

2. **Simular um lead** (POST de teste) — no terminal:
   ```bash
   curl -X POST \
     -H "Content-Type: application/json" \
     -d '{"nome":"João Teste","celular":"5511999998888","texto_mensagem":"Quero transportar meu Civic de SP pra Natal, valor 80 mil"}' \
     https://southamerica-east1-obs-fretes.cloudfunctions.net/chatguruWebhook
   ```
   Deve responder `{"ok":true,"salvo":"intake","telefone":"5511999998888","temTexto":true}`.

3. **Conferir no Firestore:** abra
   [Firebase Console → Firestore](https://console.firebase.google.com/project/obs-fretes/firestore).
   - Em `crm_leads_intake` deve aparecer o documento `5511999998888` com o array
     `mensagens`.
   - Em `chatguru_webhook_log` aparece o corpo cru.

4. **Ver o log:** Firebase Console → **Functions → Logs** (ou
   `firebase functions:log --only chatguruWebhook`). Você verá o bloco
   `===== [chatguruWebhook] LEAD RECEBIDO =====` com nome, telefone e mensagem.

---

## Parte C — Configurar o webhook no ChatGuru

No painel do ChatGuru (`s22.chatguru.app`):

1. Vá em **Configurações → Webhooks** (ou dentro do **diálogo/campanha** que
   recebe o lead, na ação de disparo — o ChatGuru chama de "Webhook" ou
   "Requisição HTTP").
2. Crie/edite um webhook com:
   - **URL:** a URL da Parte A
     (`https://southamerica-east1-obs-fretes.cloudfunctions.net/chatguruWebhook`)
   - **Método:** `POST`
   - **Cabeçalhos:** `Content-Type: application/json`
     (e `X-CG-Secret: SEU_SEGREDO` **se** você ativou a proteção)
   - **Gatilho:** quando a conversa **entra/abre** com um lead novo.
3. **Corpo (JSON):** mapeie as variáveis do ChatGuru. Use os nomes de variável
   do seu ChatGuru entre asteriscos. Exemplo:
   ```json
   {
     "nome": "*nome*",
     "celular": "*celular*",
     "email": "*email*",
     "texto_mensagem": "*mensagem*",
     "status": "aberto"
   }
   ```

> **Não sabe o nome exato das variáveis do ChatGuru?** Sem problema. Nossa
> função é "esperta": ela tenta vários nomes possíveis (`celular`, `telefone`,
> `phone`, `texto_mensagem`, `mensagem`, `texto`, `message`, etc.) **e** salva o
> corpo cru em `chatguru_webhook_log`. Então dispare um lead de teste real,
> abra esse log, veja **exatamente** como o ChatGuru nomeou os campos, e a
> gente ajusta o mapeamento se precisar.

---

## Parte D — Teste final com um lead real

1. Mande você mesmo uma mensagem pro WhatsApp da OBS (ou peça pra alguém) como
   se fosse um cliente.
2. Confira em `chatguru_webhook_log` o corpo cru que chegou.
3. Confira em `crm_leads_intake/{seu_telefone}` se a mensagem foi acumulada.
4. Me manda o conteúdo de um documento do `chatguru_webhook_log` (o `raw`). Com
   ele eu confirmo o mapeamento dos campos e a gente segue pra **Etapa 3**
   (acumular várias mensagens e fechar o lead após 60s).

---

## Resumo

```
Cliente manda mensagem no WhatsApp
   → ChatGuru dispara o webhook (POST) para chatguruWebhook
   → função salva no Firestore:
        • crm_leads_intake/{telefone}  (acumula as mensagens do contato)
        • chatguru_webhook_log/{auto}  (corpo cru, pra debug)
   → você confere no Firestore e nos Logs ✅
```

Próxima etapa (quando esta estiver validada): **acumular** múltiplas mensagens
do mesmo contato e considerar o lead **completo** após `LEAD_JANELA_SEGUNDOS`
(60s) sem mensagem nova.
