// Cobranças do Conta Azul (boleto / Pix cobrança / link de pagamento).
// A cobrança é gerada A PARTIR DA PARCELA de uma conta a receber (a venda).
//   POST /v1/financeiro/eventos-financeiros/contas-a-receber/gerar-cobranca
//   { id_conta, id_parcela, tipo: 'BOLETO'|'PIX_COBRANCA'|'LINK_PAGAMENTO',
//     data_vencimento, descricao_fatura, atributos?{maximo_parcelas} }
// id_conta: a "Conta PJ Conta Azul IP" (tipo CONTA_CORRENTE) — a mesma do resto.
import { ca } from './client.js';
import { config } from '../config.js';

export async function gerarCobranca({ idParcela, tipo, vencimento, descricao, atributos }) {
  const body = {
    id_conta: config.contaAzul.idContaFinanceira,
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
