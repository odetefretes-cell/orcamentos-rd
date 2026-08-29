# obs-fiscal-service — Emissão fiscal OBS ⇄ OPHOS

Serviço de emissão automatizada de CT-e, CIOT, MDF-e, DC-e (e GNRE) a partir da ficha
do frete do CRM, via Integrador OPHOS. Projeto completo: `docs/ARQUITETURA.md`.

## Status (29/08/2026)

| Peça | Estado |
|---|---|
| `docs/ARQUITETURA.md` | ✅ documento aprovado pelo Luiz |
| `docs/regras-negocio.md` (§6 vivo) | ✅ extraído do documento — manter atualizado a cada aprendizado |
| `src/validators/` (regras do §6 como funções puras) | ✅ implementado + testes (`npm test`) |
| `docs/ophos-layouts/` | ⛔ **BLOQUEANTE** — aguardando os arquivos de layout do Integrador (Luiz) |
| Builders TXT (CT-e/CIOT/MDF-e) | ⏳ só após os layouts chegarem (nunca por suposição) |
| Transmissão / driver Integrador | ⏳ fase posterior |
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
