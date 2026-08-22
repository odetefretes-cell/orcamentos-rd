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
    case 'CARTAO_PIX': {
      // misto: uma parte paga no PIX, o restante no link do cartão (Rede)
      const parte = round2(Math.min(Math.max(Number(opts.pixParte) || v / 2, 0.01), v - 0.01));
      const resto = round2(v - parte);
      return [
        { data_vencimento: opts.vencPix || hoje, valor: parte },
        { data_vencimento: opts.venc2 || opts.previsaoChegada || hoje, valor: resto },
      ];
    }
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
 * @param {object} refs    ids já resolvidos:
 *   { idCliente, idServico, idCategoria, idCentroCusto, idVendedor?, idNatureza?, opcaoCondicao? }
 */
export function mapVenda(input, refs) {
  const hoje = input.data || hojeISO();
  const brutas = computeParcelas(input.formaPagamento, input.valor, {
    hoje,
    previsaoChegada: input.previsaoChegada,
    vencimento: input.vencimento,
    pixParte: input.pixParte,
    vencPix: input.vencimentoPix,
    venc2: input.vencimento2,
  });

  // Estrutura REAL da parcela lida via GET /v1/venda/{id}:
  // { numero, valor, data_vencimento, descricao }
  const parcelas = brutas.map((p, i) => ({
    numero: i + 1,
    valor: p.valor,
    data_vencimento: p.data_vencimento,
    descricao: `Venda ${input.frete}`,
  }));

  // PIX usa tipo_pagamento PIX_PAGAMENTO_INSTANTANEO; cartão/faturamento PJ omitem
  // (valor exato do env não confirmado na conta — ver suposições no relatório).
  const isPix = input.formaPagamento === 'PIX_50_50' || input.formaPagamento === 'PIX_100';

  return {
    id_cliente: refs.idCliente,
    numero: Number(input.frete),
    situacao: 'APROVADO', // obrigatório — senão não gera financeiro
    data_venda: hoje,
    itens: [
      { id: refs.idServico, quantidade: 1, valor: round2(input.valor) },
    ],
    condicao_pagamento: {
      // Enum REAL: "1x" / "2x" (nº de parcelas), NÃO A_VISTA/A_PRAZO.
      opcao_condicao_pagamento: refs.opcaoCondicao || `${parcelas.length}x`,
      ...(isPix ? { tipo_pagamento: 'PIX_PAGAMENTO_INSTANTANEO' } : {}),
      parcelas,
    },
    ...(refs.idVendedor ? { id_vendedor: refs.idVendedor } : {}),
    ...(refs.idNatureza ? { id_natureza_operacao: refs.idNatureza } : {}),
    ...(refs.idCategoria ? { id_categoria: refs.idCategoria } : {}),
    ...(refs.idCentroCusto ? { id_centro_custo: refs.idCentroCusto } : {}),
    observacoes: descricaoVenda(input),
  };
}
