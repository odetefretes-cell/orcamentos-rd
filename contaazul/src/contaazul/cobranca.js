// Cobranças do Conta Azul (boleto / Pix cobrança / link de pagamento).
// A cobrança é gerada A PARTIR DA PARCELA de uma conta a receber (a venda).
//   POST /v1/financeiro/eventos-financeiros/contas-a-receber/gerar-cobranca
//   { id_conta, id_parcela, tipo: 'BOLETO'|'PIX_COBRANCA'|'LINK_PAGAMENTO',
//     data_vencimento, descricao_fatura, atributos?{maximo_parcelas} }
// id_conta: a "Conta PJ Conta Azul IP" (tipo CONTA_CORRENTE) — a mesma do resto.
import { ca } from './client.js';
import { config } from '../config.js';

export async function gerarCobranca({ idParcela, tipo, vencimento, descricao, atributos }) {
  // Schema OFICIAL (GerarCobrancaRequestDto): required = [conta_bancaria,
  // descricao_fatura, id_parcela, data_vencimento, tipo]. O campo da conta é
  // "conta_bancaria" (NÃO "id_conta" — esse era o 400 genérico).
  // Mínimo do Conta Azul: R$ 10,00 por cobrança.
  const body = {
    conta_bancaria: config.contaAzul.idContaFinanceira,
    id_parcela: idParcela,
    tipo,
    data_vencimento: vencimento,
    descricao_fatura: descricao,
    ...(atributos ? { atributos } : {}),
  };
  const { status, data } = await ca.post(
    '/v1/financeiro/eventos-financeiros/contas-a-receber/gerar-cobranca',
    body
  );
  return { status, data };
}

/** Busca uma cobrança pelo id (a emissão é assíncrona — o link/url sai aqui). */
export async function buscarCobranca(idCobranca) {
  const { data } = await ca.get(
    `/v1/financeiro/eventos-financeiros/contas-a-receber/cobranca/${idCobranca}`
  );
  return data; // { id, status, url, ... }
}

/** Espera a cobrança confirmar e devolve a versão com URL (até ~12s). */
export async function esperarUrlCobranca(idCobranca, tentativas = 6, esperaMs = 2000) {
  let ultima = null;
  for (let i = 0; i < tentativas; i++) {
    await new Promise((r) => setTimeout(r, esperaMs));
    try {
      ultima = await buscarCobranca(idCobranca);
      if (ultima && ultima.url) return ultima;
    } catch (_) { /* tenta de novo */ }
  }
  return ultima;
}
