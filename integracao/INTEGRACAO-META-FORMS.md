# OBS — Integração Formulário do Meta (Lead Ads) → ChatGuru → automação de orçamento

**Objetivo:** o **formulário instantâneo do Meta Ads** (Facebook/Instagram Lead Ads)
entra no **ChatGuru** e roda **exatamente a mesma automação de hoje**: cálculo da
média no backend + criação do lead no CRM + envio pelo WhatsApp. Sem RD no meio.

> **A boa notícia:** o motor (cálculo + CRM + envio) **já está pronto**. Só precisamos
> fazer o dado do Meta **chegar ao ChatGuru no mesmo formato do formulário do site**.
> Se o dado entrar como o texto `*Solicitação de orçamento — OBS Transportes*` (abaixo),
> o backend trata **igual** ao lead do site — zero mudança de código.

---

## 1. Como o dado flui (visão geral)

```
Cliente preenche o Formulário do Meta (anúncio)
   → ChatGuru recebe o lead (integração Meta Lead Ads) e mapeia os campos
   → Diálogo "Meta Lead (Backend OBS)" dispara:
        • monta um TEXTO no formato do formulário do site
        • liga Cotando=Sim
        • POST → chatguruWebhook
   → chatguruWebhook (mesma função de hoje) → intake → IA → média → CRM → WhatsApp
```

**Chave do lead:** o backend usa os **últimos 8 dígitos** do telefone (igual site e
ChatGuru) — então um mesmo cliente que veio pelo Meta e depois pelo WhatsApp **não
duplica**.

---

## 2. Peça 1 — O Formulário do Meta (campos a coletar)

No formulário instantâneo do anúncio, colete (nomes livres, o que importa é o
conteúdo):

| Campo no formulário | Pra que serve | Obrigatório? |
|---|---|---|
| Nome | identificar o lead | sim |
| WhatsApp / Telefone | é a CHAVE do lead e pra onde vai a média | **sim** |
| Cidade/Estado de **origem** | cálculo | **sim (p/ média automática)** |
| Cidade/Estado de **destino** | cálculo | **sim (p/ média automática)** |
| **Veículo** (marca/modelo/ano) | cálculo (categoria) | **sim (p/ média automática)** |
| Valor do veículo | seguro (ajustável depois) | opcional |
| E-mail | contato/fallback | opcional |

> **Mínimo pra cotar sozinho:** origem + destino + veículo. Sem um desses, a IA
> pergunta o que falta (Fase C) OU vai pra humano — igual hoje. **Quanto mais o
> formulário coletar, mais vai automático.**

---

## 3. Peça 2 — Conectar o Meta ao ChatGuru (mapear campos)

Isto é **configuração dentro do ChatGuru** (integração nativa de Facebook/Meta Lead
Ads) — **é o ponto a validar com o ChatGuru** (foi o que a Sell.it pediu: "validar
com o chatguru como integra o formulário do meta"):

1. No ChatGuru → **Integrações** → conectar a **Página do Facebook** (a conta NOVA de
   anúncios que a Sell.it criou) e autorizar o acesso aos **Lead Ads / Formulários
   instantâneos**.
2. Selecionar o **formulário** do anúncio.
3. **Mapear cada campo do formulário → um Campo Personalizado do ChatGuru**, por ex.:
   - Origem do formulário → campo `Local de origem do transporte`
   - Destino do formulário → campo `Local de desdetino do transporte`
   - Veículo → campo `Modelo do veículo`
   - Valor → campo `Valor do veículo`
   - (Nome e telefone o ChatGuru já usa pra criar o contato.)
4. Definir o que dispara quando o lead chega (um bot/diálogo) — ver Peça 3.

> ⚠️ **Confirmar com o ChatGuru** se a integração Meta cria o contato **e** consegue
> **acionar um diálogo automaticamente** na entrada do lead (é isso que liga a
> automação). Se o ChatGuru só importar o lead sem disparar diálogo, usa-se um gatilho
> por chegada de lead / tag / campo preenchido.

---

## 4. Peça 3 — Diálogo "Meta Lead (Backend OBS)"

Quando o lead do Meta cai no ChatGuru, este diálogo dispara e manda pro backend **no
formato do formulário do site** (assim o backend trata idêntico — inclusive já
reinicia o ciclo pra não misturar com cotação antiga do mesmo número):

**Ações do diálogo:**
1. **Responder / Mensagem interna** montando o TEXTO abaixo com as variáveis dos
   campos mapeados (ajuste os nomes `$...` aos campos reais do ChatGuru):

   ```
   *Solicitação de orçamento — OBS Transportes*

   Nome: $nome
   Telefone: $celular
   Veículo: $modelo_do_veiculo
   Valor do veículo: $valor_do_veiculo
   Origem: $local_de_origem_do_transporte
   Destino: $local_de_desdetino_do_transporte

   Gostaria de receber o valor do transporte.
   ```

2. **POST PARA URL** → `https://southamerica-east1-obs-fretes.cloudfunctions.net/chatguruWebhook`
   (o payload nativo já leva `texto_mensagem` com esse texto + os campos).
3. **Contexto de Saída:** `Cotando = Sim`.

> **Por que "Solicitação de orçamento" no texto:** essa frase faz o backend tratar
> como **formulário** → ciclo LIMPO (zera qualquer cotação anterior do número) e média
> automática. É a mesma porta do lead do site, já testada em produção.

**Alternativa (se não der pra montar o texto no diálogo):** dá pra usar o **botão
Origem=`fechar`** (como o "Gerar Orçamento") que o backend lê os **Campos
Personalizados** direto. Mas o caminho do TEXTO acima é o mais fiel e o recomendado.

---

## 5. Atenção — primeiro contato no WhatsApp (template/HSM)

O lead do **formulário instantâneo NÃO manda mensagem no WhatsApp** (ele preenche o
form, não abre conversa). Pra OBS **falar primeiro** no WhatsApp, o ChatGuru precisa
disparar uma **mensagem de template aprovada (HSM)** — senão a janela de 24h não abre
e a média não sai.

- **Confirmar com o ChatGuru:** ao importar o lead do Meta, ele já dispara um
  **template de abertura** automaticamente? Se sim, a conversa abre e a média do
  backend é entregue normal. Se não, criar/apadrinhar um template de saudação que
  dispare na entrada do lead do Meta.
- (Leads de **anúncio "Click-to-WhatsApp"** são diferentes: aí o cliente já manda a 1ª
  mensagem e cai no **Opener** — esse caminho já funciona hoje.)

---

## 6. Como testar

1. Preencher o formulário do Meta de teste (com um número de WhatsApp real seu).
2. Ver o lead chegar no ChatGuru com os campos mapeados.
3. Conferir que o diálogo disparou e fez o POST (log no Firestore
   `chatguru_webhook_log`: `texto_mensagem` com o bloco "Solicitação de orçamento" e
   `bot_context: {"Cotando":"Sim"}`).
4. Em ~1 min: lead criado no CRM (coluna Novo Lead) + média calculada + (se
   `envioAtivo=true`) a média chegando no WhatsApp.
5. Log: `firebase functions:log --only criarLeadNoCrm` (procurar `média backend R$ ...`).

---

## 7. Resumo de responsabilidades

| Parte | Quem faz | Status |
|---|---|---|
| Motor (cálculo + CRM + envio + reinício de ciclo) | **backend (pronto)** | ✅ já funciona |
| Formulário do Meta com os campos certos | Sell.it / OBS (no Gerenciador de Anúncios) | a fazer |
| Conectar Meta → ChatGuru + mapear campos | **ChatGuru** (validar integração) | a validar |
| Diálogo "Meta Lead (Backend OBS)" (texto + Cotando + POST) | Cowork / ChatGuru | a criar |
| Template de abertura no WhatsApp (HSM) | **ChatGuru** (validar) | a validar |

> **Único ponto que depende de terceiro:** a integração Meta→ChatGuru e o template de
> abertura (itens do ChatGuru). O resto (motor) é nosso e já roda. Se o ChatGuru
> confirmar que entrega o lead do Meta com os campos + dispara um diálogo, a
> automação completa fica de pé sem mudar o backend.
