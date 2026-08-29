/* Contadores fiscais — SEEDS de 29/08/2026 (docs/regras-negocio.md).
   A fonte da verdade em produção será a tabela no Postgres (`fiscal_contadores`);
   estes valores servem só para inicializá-la UMA vez. Nunca ler do OPHOS a lista
   filtrada para descobrir o último valor (regra do §6 — listas dele enganam). */
'use strict';

const SEEDS = {
  cteSerie001: 6469,       // último CT-e emitido na série 001
  mdfeSerie002: 1186,      // último MDF-e emitido na série 002
  requisicaoCiot: 64559,   // última requisição CIOT (TruckPad)
  averbacaoSeguro: 757,    // último nº de averbação (apólice Allianz)
};

const APOLICE_ALLIANZ = '517720243Y540000497';

// Dados bancários do pagamento formal (CIOT e MDF-e)
const BANCO_PAGAMENTO = { banco: '341', agencia: '8866', conta: '158820' };

module.exports = { SEEDS, APOLICE_ALLIANZ, BANCO_PAGAMENTO };
