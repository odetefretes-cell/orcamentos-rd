// Traduz o payload do OBS para o formato da VENDA do Conta Azul.
// Funções puras — sem rede, fáceis de testar.
import { config } from '../config.js';
import { hojeISO, addDias, round2 } from './dates.js';

/**
 * Contrato de entrada vindo do sistema OBS (POST /obs/venda):
 * {
 *   frete: 1523,                     // número do frete = número da venda
 *   modal: 'cegonha'|'guincho',
 *   valor: 1500.00,
 *   formaPagamento: 'PIX_50_50'|'PIX_100'|'CARTAO'|'FATURAMENTO_PJ',
 *   data?: '2026-08-16',             // data da venda (default hoje)
 *   previsaoChegada?: '2026-08-30',  // vencimento da 2ª parcela (PIX 50/50)
 *   vencimento?: '2026-09-10',       // faturamento PJ
 *   cliente: { nome, documento?, email?, telefone? },
 *   origem?, destino?, veiculo?, placa?, descricao?
 * }
 */

export function computeParcelas(forma, valor, opts = {}) {
  const hoje = opts.hoje || hojeISO();
  const v = round2(valor);
  switch (forma) {
    case 'PIX_50_50': {
      const p1 = round2(v / 2);
      const p2 = round2(v - p1); // garante que soma bate ao centavo
      const venc2 = opts.previsaoChegada || addDias(hoje, config.parcela2FallbackDias);
      return [
        { data_vencimento: hoje, valor: p1 },
        { data_vencimento: venc2, valor: p2 },
      ];
    }
    case 'PIX_100':
    case 'CARTAO':
      return [{ data_vencimento: hoje, valor: v }];
    case 'FATURAMENTO_PJ':
      return [{ data_vencimento: opts.vencimento || hoje, valor: v }];
    default:
      throw new Error(`Forma de pagamento desconhecida: ${forma}`);
  }
}

export function descricaoVenda(input) {
  if (input.descricao) return input.descricao;
  const partes = [`#${input.frete}`];
  if (input.origem || input.destino) partes.push(`${input.origem || '?'} > ${input.destino || '?'}`);
  const veic = [input.veiculo, input.placa].filter(Boolean).join(' ');
  if (veic) partes.push(veic);
  return partes.join(' | ');
}

/**
 * Monta o corpo do POST /v1/venda.
 * @param {object} input   payload do OBS (acima)
 * @param {object} refs    ids já resolvidos: { idCliente, idServico, idCategoria, idCentroCusto, opcaoCondicao? }
 */
export function mapVenda(input, refs) {
  const hoje = input.data || hojeISO();
  const parcelas = computeParcelas(input.formaPagamento, input.valor, {
    hoje,
    previsaoChegada: input.previsaoChegada,
    vencimento: input.vencimento,
  });

  return {
    id_cliente: refs.idCliente,
    numero: Number(input.frete),
    situacao: 'APROVADO', // obrigatório — senão não gera financeiro
    data_venda: hoje,
    itens: [
      { id: refs.idServico, quantidade: 1, valor: round2(input.valor) },
    ],
    condicao_pagamento: {
      // ⚠️ VERIFICAR o valor exato do enum no OpenAPI (A_VISTA / A_PRAZO / uuid).
      opcao_condicao_pagamento: refs.opcaoCondicao || (parcelas.length > 1 ? 'A_PRAZO' : 'A_VISTA'),
      parcelas,
    },
    ...(refs.idCategoria ? { id_categoria: refs.idCategoria } : {}),
    ...(refs.idCentroCusto ? { id_centro_custo: refs.idCentroCusto } : {}),
    observacoes: descricaoVenda(input),
  };
}
