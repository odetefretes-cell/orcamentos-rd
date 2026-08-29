# obs-fiscal-service — Emissão fiscal OBS ⇄ OPHOS

Serviço de emissão automatizada de CT-e, CIOT, MDF-e, DC-e (e GNRE) a partir da ficha
do frete do CRM, via Integrador OPHOS. Projeto completo: `docs/ARQUITETURA.md`.

## Status (29/08/2026)

| Peça | Estado |
|---|---|
| `docs/ARQUITETURA.md` | ✅ documento aprovado pelo Luiz |
| `docs/regras-negocio.md` (§6 vivo) | ✅ extraído do documento — manter atualizado a cada aprendizado |
| `src/validators/` (regras do §6 como funções puras) | ✅ implementado + testes (`npm test`) |
| `docs/ophos-layouts/` | ⛔ **BLOQUEANTE** — aguardando as specs da API (`developer.ophos.com.br/api/*.json`, doc pública) |
| Builders (CT-e/CIOT/MDF-e) | ⏳ só após as specs chegarem (nunca por suposição) |
| Transmissão / driver | ⏳ ver "Canal de integração" abaixo |

## Canal de integração (atualização 29/08/2026)

O suporte OPHOS indicou que a integração é por **API REST** (portal
`developer.ophos.com.br`, ex.: `?url=/api/cte.json`) — não pelo Integrador
Windows/TXT que o §2 da arquitetura previa. Situação:

- O contrato atual da OBS é **só emissão pela Web**; usar a API exige **contratação
  com o comercial** (contato na segunda-feira — perguntar preço, cobertura de
  CIOT/DC-e, homologação e autenticação).
- A **documentação é pública** → baixar as specs e construir o conector ANTES de
  contratar; liga-se no dia em que o contrato sair.
- **Enquanto isso, o driver é a automação de navegador** (skill que já emite no
  OPHOS web) — o fallback previsto no §2. Validação/regras/orquestração não mudam;
  só o motor de transmissão é trocado quando a API estiver ativa.
- Se o preço da API não compensar, o driver de navegador permanece como definitivo.
| Fixture real do frete 1702/1703 | ⏳ aguardando dump do Postgres (há um `frete-1702.exemplo.json` provisório) |

## Decisões de implementação

- **Node.js puro (CommonJS), sem TypeScript/Redis/Fastify** — mesmo padrão dos serviços
  que já rodam na VPS (`contaazul/`, `integracao/`): a equipe já sabe operar (PM2/systemd,
  deploy por script). A arquitetura do documento (§3) se mantém; muda só a stack.
- Testes com `node:test` nativo (sem dependência externa): `node --test test/`.
- Contadores fiscais (fonte da verdade = nosso banco): seeds em `src/domain/contadores.js`.

## Rodar os testes

```
cd obs-fiscal-service && node --test test/
```
