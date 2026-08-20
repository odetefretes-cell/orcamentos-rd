# Arquitetura — integração OBS × Conta Azul

## Por que existe um backend

O sistema OBS é um site (agora na Hostinger). Site não pode guardar o
`client_secret` nem o `refresh_token` do Conta Azul — qualquer segredo no
JavaScript vira público. Por isso a integração tem um **backend** que:

1. guarda as credenciais e faz o OAuth2 (Authorization Code);
2. renova o `access_token` sozinho e persiste o `refresh_token` **rotativo**;
3. traduz o pedido do OBS para o formato do Conta Azul;
4. aplica as regras da OBS (duplicidade, categoria única, parcelas);
5. reconcilia o retorno assíncrono (202) das contas a pagar.

No VPS Hostinger o backend roda ao lado do site, no mesmo servidor, num
subdomínio. O banco é SQLite em disco persistente.

## Componentes

```
src/
  server.js            Express: monta rotas, CORS, sobe o reconciliador
  config.js            todas as configs vêm do .env
  auth/
    oauth.js           authorize URL, troca de code, refresh (com lock)
    tokenStore.js      persiste tokens; salva o refresh_token novo a cada renovação
  contaazul/
    client.js          HTTP autenticado: renova token, 401→refresh+retry, 429→backoff
    pessoas.js         acha/cria cliente e fornecedor por documento
    servicos.js        UUIDs dos serviços (a API exige serviço cadastrado)
    categorias.js      resolve id de categoria/centro de custo por nome (cache)
    vendas.js          POST /v1/venda (síncrono)
    financeiro.js      POST contas-a-pagar (202) + busca p/ reconciliar
  domain/
    mapVenda.js        OBS → payload de venda; regra das parcelas
    mapDespesa.js      OBS → payload de conta a pagar; consolida N fretes
    dates.js           utilidades de data puras
  store/
    db.js              SQLite + schema (tokens, ledger, trava de duplicidade)
    ledger.js          idempotência, trava placa+frete, fila de reconciliação
  routes/
    oauth.js           /oauth/start, /callback, /status
    obs.js             /obs/venda, /obs/despesa, /obs/status (protegidas por segredo)
  jobs/
    reconcile.js       preenche o ca_id das despesas 202 buscando pela referência
```

## Fluxo da receita (venda)

1. Operador clica "Registrar no Conta Azul" → site chama `POST /obs/venda`.
2. Backend checa o **ledger**: se o frete já tem venda, devolve a existente (não duplica).
3. Resolve cliente (acha/cria), categoria `Fretes recebidos`, centro de custo.
4. Monta a venda (`situacao: APROVADO`, nº = nº do frete, parcelas pela forma de pagamento).
5. `POST /v1/venda` (síncrono, devolve id) → grava no ledger → responde o número ao OBS.

## Fluxo da despesa (prestador)

1. Financeiro aprova a cobrança → site chama `POST /obs/despesa` (1 ou N fretes/placas).
2. **Trava de duplicidade**: se algum par placa+frete já foi lançado, responde 409.
3. Resolve fornecedor, categoria de prestador, centro de custo.
4. `POST contas-a-pagar` → responde **202 sem id** (assíncrono).
5. Grava no ledger como `pendente_reconciliacao`.
6. `jobs/reconcile.js` roda a cada X min, busca pela **referência (nº do frete)** e
   preenche o `ca_id`, marcando `reconciliado`.
7. O pagamento do PIX é aprovado por você no **CA de Bolso**.

## Decisões que espelham o spec do sistema OBS

- **Uma cobrança = uma despesa**, mesmo consolidada (N fretes) — o detalhe por
  frete fica no ledger; no Conta Azul é um pagamento só.
- **Categoria única de prestador**: `Materiais Aplicados na Prestação de Serviços`
  (decidido em 18/08/2026). Configurável em `CAT_DESPESA`.
- **Trava placa+frete** implementada na tabela `despesa_pairs`.
- **Número da venda = número do frete**, nunca o sequencial do Conta Azul.

## Limitações da API que moldam o código

- **Sem webhooks** → como quem dispara é o OBS, não precisamos de polling para
  empurrar. Só a reconciliação faz uma consulta pontual.
- **Conta a pagar responde 202 sem id** → reconciliação obrigatória.
- **Categorias são somente leitura** → têm que existir antes (o código só resolve o id).
- **Item de venda exige serviço cadastrado** → UUIDs no `.env`.
- **Refresh token rotativo, ~2 semanas, uso único** → persistir o novo sempre;
  não deixar parado por 2 semanas.
- **Rate limit** 600/min, 10/s → backoff em 429 (não chegamos perto disso).

## ⚠️ Campos a confirmar no sandbox (marcados no código como VERIFICAR)

Rode primeiro na **conta de teste** do portal e ajuste, cada um num lugar só:

| Onde | O quê |
|---|---|
| `domain/mapVenda.js` | `opcao_condicao_pagamento` (enum/uuid da condição de pagamento) |
| `domain/mapDespesa.js` | nomes: `id_fornecedor`, `codigo_referencia`, `data_competencia` |
| `contaazul/pessoas.js` | parâmetro de busca por documento e enum de `perfis` |
| `contaazul/financeiro.js` | filtro `codigo_referencia` na busca de contas a pagar |

Isso não é falha do desenho — é a forma correta de integrar: validar contra o
OpenAPI/sandbox antes de apontar para a contabilidade real.

## Decisões de negócio ainda em aberto (do spec)

1. **Vencimento da 2ª parcela** (PIX 50/50): hoje o padrão é previsão de chegada,
   com fallback de 15 dias (`PARCELA2_FALLBACK_DIAS`). Confirmar a política.
2. **Tolerância de divergência** cobrado × contratado: hoje a decisão é humana
   (fila do prestador no OBS). Se quiser aprovação automática até X%, entra na tela do OBS.
3. **Migrar o histórico** de categorias antigas para a categoria única.

## Roadmap sugerido

| Fase | O quê | Precisa deste backend? |
|---|---|---|
| 1 | Campo "valor contratado" no OBS (operacional) | não |
| 2 | Categoria única + migração de histórico | não |
| 3 | Painel do dia + fila de prestador com estados | não |
| 4 | Trava de duplicidade na tela do OBS | não |
| 5 | Botão "Registrar no Conta Azul" (venda) | **sim** — `POST /obs/venda` |
| 6 | Botão "Lançar no Conta Azul" (despesa) | **sim** — `POST /obs/despesa` |
| 7 | Sincronização de status/baixas | **sim** — estender `jobs/reconcile.js` |

As fases 1–4 são no sistema OBS e não dependem deste backend. Este projeto entrega
o motor das fases 5–7.
