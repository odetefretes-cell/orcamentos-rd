# obs-fiscal-service — Emissão fiscal OBS ⇄ OPHOS

Serviço de emissão automatizada de CT-e, CIOT, MDF-e, DC-e (e GNRE) a partir da ficha
do frete do CRM, via Integrador OPHOS. Projeto completo: `docs/ARQUITETURA.md`.

## Status (11/09/2026)

| Peça | Estado |
|---|---|
| `docs/ARQUITETURA.md` | ✅ aprovado pelo Luiz · **§2 reescrita em 11/09** (o canal descrito antes estava errado) |
| `docs/regras-negocio.md` (§6 vivo) | ✅ extraído do documento — manter atualizado a cada aprendizado |
| `src/validators/` (regras do §6 como funções puras) | ✅ implementado · **16 testes passando** |
| `docs/ophos-layouts/` | ⛔ **BLOQUEANTE** — faltam `cte.json` e `mdfe.json`. São **públicos**; instruções de download na pasta |
| Builders (CT-e/MDF-e) | ⏳ só após as specs chegarem (nunca por suposição) |
| Transmissão / driver | ⏳ hoje o driver ativo é a automação de navegador (skill `ophos-obs-documentos-fiscais`) |
| Fixture real do frete 1702/1703 | ⏳ aguardando dump do Postgres (há um `frete-1702.exemplo.json` provisório) |
| **Decisão comercial** | 🔸 **É O QUE TRAVA DE VERDADE** — proposta de 31/08 sem resposta da OBS até 11/09 |

## Canal de integração — resolvido em 31/08/2026

É **API REST** (`developer.ophos.com.br`), não o Integrador Windows/TXT que a §2 original previa.
Detalhes completos, escopo e custo: **`docs/ARQUITETURA.md` §2**. Em uma tela:

- ✅ **CT-e e MDF-e**, eventos (cancelamento, carta de correção, encerramento) e download de PDF/XML.
- ⛔ **CIOT e GNRE ficam FORA** — seguem manuais. `src/validators/ciot.js` continua valendo para
  a emissão na tela, mas o CIOT **não entra no pipeline automatizado**.
- ⚠️ **Sem webhook**: duas chamadas (emitir / consultar). Exige fila, reconsulta e um estado
  "aguardando autorização" visível ao operador.
- ⚠️ **A numeração passa a ser nossa** — emitir pela tela e pela API ao mesmo tempo fura a série.
- 💰 **R$ 340 de ativação + R$ 295,12/mês** (faixa de 100, a que serve ao nosso volume de ~122
  CT-e/mês). Sem fidelidade nem multa. O plano WEB atual continua cobrado à parte.

### O que falta perguntar antes do "ok"

1. **Autenticação**: Basic Auth em cada chamada ou troca por token? Se token, qual validade?
2. **DC-e**: endpoint próprio ou anexo do CT-e?
3. **Averbação**: nossa apólice é AT&M, Porto Seguro, ELT Seguro ou Smart Load? (Só esses voltam o número.)
4. **Intervalo de reconsulta** recomendado, e o que fazer quando a consulta não resolve.
5. **PDF/XML**: base64 no corpo ou URL? Por quanto tempo fica disponível do lado deles?
6. **Numeração duplicada**: a OPHOS rejeita número repetido ou gera documento duplicado?
7. **Prazo de liberação** das credenciais de homologação, em dias úteis.
8. **Valor do plano WEB atual**, para fechar o custo da coexistência.

## Decisões de implementação

- **Node.js puro (CommonJS), sem TypeScript/Redis/Fastify** — mesmo padrão dos serviços
  que já rodam na VPS (`contaazul/`, `integracao/`): a equipe já sabe operar (PM2/systemd,
  deploy por script). A arquitetura do documento (§3) se mantém; muda só a stack.
- Testes com `node:test` nativo (sem dependência externa): `node --test test/`.
- Contadores fiscais (fonte da verdade = nosso banco): seeds em `src/domain/contadores.js`.

## Rodar os testes

```
cd obs-fiscal-service && node --test
```

⚠️ **Não use `node --test test/`** — no Node 22 ele tenta carregar `test` como módulo e quebra
com `MODULE_NOT_FOUND`, parecendo defeito no código quando não é. `node --test` sozinho descobre
os arquivos; `node --test test/*.test.js` também funciona. E **não há `package.json`**, então
`npm test` não existe neste serviço.
