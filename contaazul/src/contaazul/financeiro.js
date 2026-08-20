// Financeiro — o custo do prestador (conta a pagar).
// ⚠️ POST de conta a pagar responde 202 e NÃO devolve o id do registro criado.
// É assíncrono. Por isso o id é preenchido depois pela reconciliação
// (jobs/reconcile.js), buscando pelo código de referência = número do frete.
import { ca } from './client.js';

/**
 * Cria uma conta a pagar (despesa do prestador).
 * @param {object} payload  já no formato da API (ver domain/mapDespesa.js)
 * @returns {Promise<{status:number, data:any}>}  status normalmente 202
 */
export async function criarContaAPagar(payload) {
  const { status, data } = await ca.post(
    '/v1/financeiro/eventos-financeiros/contas-a-pagar',
    payload
  );
  return { status, data };
}

/**
 * Busca contas a pagar pelo código de referência (nº do frete) para reconciliar
 * o id depois do 202.
 * ⚠️ VERIFICAR o nome do parâmetro de filtro no OpenAPI (codigo_referencia?).
 */
export async function buscarContasAPagarPorReferencia(codigoReferencia) {
  const { data } = await ca.get(
    '/v1/financeiro/eventos-financeiros/contas-a-pagar/buscar',
    { codigo_referencia: codigoReferencia }
  );
  return Array.isArray(data) ? data : (data?.itens || data?.content || []);
}

/** Lista parcelas de um evento financeiro (para sincronizar baixas/status). */
export async function listarParcelas(idEvento) {
  const { data } = await ca.get(`/v1/financeiro/eventos-financeiros/${idEvento}/parcelas`);
  return Array.isArray(data) ? data : (data?.itens || data?.content || []);
}
