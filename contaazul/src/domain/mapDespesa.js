// Traduz o payload do OBS para o formato da DESPESA (conta a pagar) do Conta Azul.
// Suporta cobrança consolidada: uma despesa cobrindo VÁRIOS fretes/placas.
import { hojeISO, round2 } from './dates.js';

/**
 * Contrato de entrada (POST /obs/despesa):
 * {
 *   prestador: { nome, documento? },
 *   valor: 750.00,                   // total cobrado APROVADO
 *   modal?: 'cegonha'|'guincho',
 *   dataCompetencia?: '2026-08-18',
 *   vencimento?: '2026-08-18',       // à vista por padrão (prática da OBS)
 *   pixKey?: '+5588996959745',       // vai na observação (pagamento é pelo CA de Bolso)
 *   itens: [                          // 1 ou N linhas (consolidada)
 *     { frete: 1333, placa: 'EHY8E86' },
 *     { frete: 1489, placa: 'SNY5E24' }
 *   ]
 * }
 */

export function paresDespesa(input) {
  const itens = Array.isArray(input.itens) ? input.itens : [];
  return itens
    .map((i) => ({ frete: String(i.frete).trim(), placa: normalizaPlaca(i.placa) }))
    .filter((p) => p.frete && p.placa);
}

export function normalizaPlaca(placa) {
  return String(placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function descricaoDespesa(input, pares) {
  const fretes = [...new Set(pares.map((p) => p.frete))].join(', ');
  const placas = pares.map((p) => p.placa).join(', ');
  const nome = input.prestador?.nome || 'prestador';
  return `#${fretes} | ${placas} | ${nome}`.slice(0, 200);
}

/**
 * Monta o corpo do POST /v1/financeiro/eventos-financeiros/contas-a-pagar.
 * Corpo alinhado ao processo manual real: id_pessoa (fornecedor), total,
 * parcelas[{ data_vencimento, valor, id_conta_financeira }] à vista (1 parcela),
 * mais id_categoria, id_centro_custo, codigo_referencia, data_competencia.
 * @param {object} input
 * @param {object} refs { idFornecedor, idCategoria, idCentroCusto, idContaFinanceira }
 */
export function mapDespesa(input, refs) {
  const pares = paresDespesa(input);
  if (pares.length === 0) throw new Error('Despesa sem itens (frete+placa) válidos');
  const hoje = hojeISO();
  const total = round2(input.valor);

  const obs = [
    input.pixKey ? `PIX: ${input.pixKey}` : null,
    `placas: ${pares.map((p) => p.placa).join(', ')}`,
  ].filter(Boolean).join(' | ');

  const venc = input.vencimento || hoje;
  const desc = descricaoDespesa(input, pares);

  // Estrutura REAL da API (createpayablefinancialevent):
  //   contato (não id_pessoa), observacao (singular), valor, data_competencia,
  //   rateio[{ id_categoria, valor, rateio_centro_custo:[{ id_centro_custo, valor }] }],
  //   condicao_pagamento.parcelas[{ descricao, data_vencimento, conta_financeira,
  //     detalhe_valor:{ valor_bruto, valor_liquido, desconto, juros, multa, taxa } }]
  return {
    // fornecedor = "contato" no evento financeiro (id da pessoa criada/achada)
    contato: refs.idFornecedor,
    descricao: desc,
    valor: total,
    data_competencia: input.dataCompetencia || hoje,
    // liga a despesa ao(s) frete(s) → permite reconciliar/achar depois (campo real na tela do CA)
    codigo_referencia: [...new Set(pares.map((p) => p.frete))].join(','),
    observacao: obs,
    ...(refs.idContaFinanceira ? { conta_financeira: refs.idContaFinanceira } : {}),
    // rateio (obrigatório): categoria financeira + centro de custo ANINHADO.
    rateio: [
      {
        valor: total,
        ...(refs.idCategoria ? { id_categoria: refs.idCategoria } : {}),
        ...(refs.idCentroCusto
          ? { rateio_centro_custo: [{ id_centro_custo: refs.idCentroCusto, valor: total }] }
          : {}),
      },
    ],
    // à vista: 1 parcela. detalhe_valor = "composição de valor" (bruto=líquido, sem juros).
    condicao_pagamento: {
      parcelas: [
        {
          descricao: desc,
          data_vencimento: venc,
          ...(refs.idContaFinanceira ? { conta_financeira: refs.idContaFinanceira } : {}),
          detalhe_valor: {
            valor_bruto: total,
            valor_liquido: total,
            desconto: 0,
            juros: 0,
            multa: 0,
            taxa: 0,
          },
        },
      ],
    },
  };
}
