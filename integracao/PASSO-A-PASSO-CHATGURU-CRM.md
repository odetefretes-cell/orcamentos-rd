# CRM se preenche sozinho a partir do ChatGuru — passo a passo

Objetivo: quando uma conversa entra no ChatGuru (com os dados do cliente), o
lead aparece **sozinho no CRM** (aba 🎯 CRM), na coluna **Novo Lead**, já com
nome, telefone, veículo, origem e destino — e o app **calcula o frete
automaticamente**. Não precisa mais digitar nada na mão.

Como funciona: o ChatGuru faz um **POST** para uma pequena função na nuvem
(`webhook.js`), que **grava o lead** na coleção `crm_leads` do Firebase. O app
já escuta essa coleção em tempo real (onSnapshot) → o lead surge na hora.

> **Não precisa da SW Fretes nem de tokens.** A função só cria o lead; quem
> calcula o valor é o próprio app (`crmAutoCalcSite`). Deixei a função pronta
> pra subir sem nenhum segredo.

---

## Parte A — Subir a função (uma vez só)

Precisa ser feito por alguém com acesso ao **Firebase da OBS** (projeto
`obs-fretes`) no computador. É rápido.

1. Instalar as ferramentas (se ainda não tiver):
   ```bash
   npm install -g firebase-tools
   firebase login
   ```
2. Na pasta do projeto (onde está o `firebase.json` que já deixei pronto):
   ```bash
   cd integracao && npm install && cd ..
   firebase deploy --only functions:obsIntegracao
   ```
3. No fim, o terminal mostra a URL da função, algo como:
   ```
   https://southamerica-east1-obs-fretes.cloudfunctions.net/obsIntegracao
   ```
   **Guarde essa URL** — é ela que o ChatGuru vai chamar.
4. Teste no navegador: abra a URL. Deve responder
   `{"ok":true,"servico":"obsIntegracao",...}`. Se aparecer isso, está no ar. ✅

> **Plano Firebase:** funções (2ª geração) pedem o plano **Blaze** (com cartão),
> mas o uso de vocês é baixíssimo e cabe **de graça** na cota mensal. Se o
> projeto ainda estiver no Spark, o próprio `firebase deploy` avisa e manda o
> link pra ativar o Blaze.

### (Opcional) Proteger com um segredo
Para só o ChatGuru poder chamar a função:
```bash
firebase functions:secrets:set CG_SECRET
# digite um segredo qualquer, ex.: obs-2026-xyz
firebase deploy --only functions:obsIntegracao
```
Depois, no ChatGuru, envie o cabeçalho `X-CG-Secret` com esse mesmo valor.

---

## Parte B — Configurar o ChatGuru (uma vez só)

No **diálogo** do ChatGuru que recebe o pedido de orçamento (o mesmo que hoje
capta nome/telefone/veículo/origem/destino), adicione uma ação de **HTTP POST**:

- **URL:** `…/obsIntegracao/cotar` (a URL do passo A + `/cotar`)
- **Método:** `POST`
- **Cabeçalhos:** `Content-Type: application/json`
  (e `X-CG-Secret: SEU_SEGREDO` se você ativou a proteção)
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
  Só `nome` e `telefone` são obrigatórios; o resto entra conforme o cliente
  informa. (`origem`/`destino` no formato "Cidade UF", ex.: "São Paulo SP".)

Pronto. Assim que o diálogo roda, o lead aparece no CRM.

### (Opcional) Botão SIM/NÃO de interesse
Nos botões de interesse do WhatsApp, aponte para `…/obsIntegracao/interesse`
com o corpo:
```json
{ "telefone": "*telefone*", "interesse": "sim" }   // ou "nao"
```
SIM move o lead para **Contato Feito**; NÃO move para **Perdido** — na hora, no
Kanban da equipe.

---

## Resumo do fluxo final

```
Cliente → formulário do site → WhatsApp (envia) → ChatGuru
   → ChatGuru chama a função (POST /cotar)
   → função grava o lead no CRM (coleção crm_leads)
   → app mostra o lead na hora e calcula o frete sozinho
   → equipe responde o orçamento na conversa (janela já aberta) ✅
```

Qualquer erro no deploy ou na configuração do ChatGuru, me chame com a mensagem
que apareceu que eu te oriento.
