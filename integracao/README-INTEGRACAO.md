# Integração de atendimento — ChatGuru ⇄ SW Fretes ⇄ CRM

Desenho do fluxo que o sistema faz, do formulário no site até o orçamento
oficial enviado pelo WhatsApp.

## O fluxo (7 passos)

```
1. CLIENTE  →  preenche o formulário no site (página "Solicite seu orçamento")
2. SITE     →  abre o WhatsApp já com a mensagem montada (link wa.me)   ✅ pronto
3. CHATGURU →  recebe a mensagem no WhatsApp oficial (API)
4. CÁLCULO  →  ChatGuru chama nossa função → função chama a SW Fretes
5. RESPOSTA →  SW devolve o valor médio → ChatGuru responde ao cliente
               e a função cria o LEAD no CRM (já com todas as informações)
6. INTERESSE→  cliente clica SIM/NÃO (botão do WhatsApp) → marca no lead do CRM
7. OPERADOR →  confere/edita no CRM, emite o orçamento oficial e
               encaminha ao cliente pelo botão de WhatsApp                ✅ pronto
```

Os passos **1, 2 e 7 já estão prontos no `index.html`**. Os passos **3–6**
dependem do ChatGuru + de uma pequena função na nuvem (`webhook.js`), porque
uma página estática (GitHub Pages) **não pode**:

- guardar os tokens secretos da SW / do ChatGuru (ficariam públicos);
- receber webhooks do ChatGuru;
- chamar a API da SW direto do navegador (bloqueio de CORS + segurança).

Por isso a ponte roda como **Firebase Cloud Function** (mesmo projeto Firebase
que o app já usa). Grátis dentro do plano Spark/Blaze de baixo volume.

## Decisões (respondendo o desenho de fluxo)

- **Qual CRM?** → O **CRM próprio** (aba 🎯 CRM, Kanban). Não precisa de CRM
  externo: a função grava direto na coleção `crm_leads` e o app mostra na hora.
- **A SW tem API?** → **Sim.** `POST https://api.swweb.info/v1/freight-quotes/quote`
  (manual anexado). Então **não precisamos remontar a calculadora** — usamos a
  da SW, que já tem as tabelas e transportadoras da OBS.
- **Montar calculadora própria?** → Não é necessário. Fica como plano B só se a
  OBS quiser um valor estimado sem depender da SW.

## Página de orçamento (já no app)

Publique e divulgue este link (é o "formulário do site"):

```
https://odetefretes-cell.github.io/orcamentos-rd/#orc
```

O cliente preenche (nome, telefone, modelo, valor, origem, destino, data,
funciona?, blindado?) e o botão **💬 Calcular no WhatsApp** o leva ao WhatsApp
da OBS com a mensagem pronta.

> Ajuste o número em `index.html` → constante `WPP_NUMERO`
> (formato `55` + DDD + número, ex.: `5511999999999`).

## O que falta configurar (passos 3–6)

1. **Tokens da SW Fretes** — pedir à swweb o `AppToken` do app e o `Bearer` do
   usuário (seção *Segurança* do manual).
2. **Deploy da função** (uma vez):
   ```bash
   cd integracao && npm install
   firebase deploy --only functions:obsIntegracao
   ```
   Defina os segredos (não vão para o código):
   ```bash
   firebase functions:secrets:set SW_APPTOKEN
   firebase functions:secrets:set SW_BEARER
   firebase functions:secrets:set CG_SECRET
   ```
   A função sobe em algo como:
   `https://southamerica-east1-obs-fretes.cloudfunctions.net/obsIntegracao`
3. **ChatGuru** — no diálogo que recebe o pedido:
   - fazer um **HTTP POST** para `…/obsIntegracao/cotar` com os campos do cliente
     (nome, telefone, valorVeiculo, cepOrigem/cepDestino ou origem/destino,
     dataEnvio, funciona, blindado, veiculo), cabeçalho `X-CG-Secret`;
   - responder ao cliente com o `valor` e `prazo` devolvidos;
   - nos **botões SIM/NÃO**, chamar `…/obsIntegracao/interesse`
     com `{ telefone, interesse:"sim"|"nao" }`.
4. **Regra do Firestore** (para o CRM sincronizar com a equipe):
   ```
   match /crm_leads/{id} { allow read, write: if true; }
   ```

## Contrato da função (resumo)

**POST `/cotar`**
```json
{
  "nome":"João", "telefone":"11999999999", "email":"joao@x.com",
  "tipo":"Empresa", "veiculo":"HONDA/CIVIC 2020", "valorVeiculo":80000,
  "cepOrigem":"01001000", "cepDestino":"59000000",
  "origem":"São Paulo SP", "destino":"Natal RN",
  "dataEnvio":"2026-08-01", "funciona":"SIM", "blindado":"NÃO",
  "categoria":4
}
```
→ resposta `{ "ok":true, "leadId":"…", "cotou":true, "valor":1300, "prazo":11 }`
e cria o lead no CRM (etapa *novo*, origem *whatsapp*).

**POST `/interesse`**
```json
{ "telefone":"11999999999", "interesse":"sim" }
```
→ marca o interesse no lead (SIM → etapa *contato*; NÃO → *perdido*).

> A SW aceita **CEP** (`fromPostalCode`/`toPostalCode`) **ou** código IBGE
> (`fromCity`/`toCity`). Prefira coletar o **CEP** de origem/destino no ChatGuru
> para o cálculo sair mais preciso.
