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
 * O endpoint EXIGE data_vencimento_de e data_vencimento_ate (dá 400 sem eles),
 * então usamos um intervalo amplo (±120 dias de hoje) além do codigo_referencia.
 */
export async function buscarContasAPagarPorReferencia(codigoReferencia) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const hoje = new Date();
  const de = new Date(hoje);  de.setDate(de.getDate() - 120);
  const ate = new Date(hoje); ate.setDate(ate.getDate() + 120);
  const { data } = await ca.get(
    '/v1/financeiro/eventos-financeiros/contas-a-pagar/buscar',
    {
      codigo_referencia: codigoReferencia,
      data_vencimento_de: iso(de),
      data_vencimento_ate: iso(ate),
    }
  );
  return Array.isArray(data) ? data : (data?.items || data?.itens || data?.content || []);
}

/** Lista parcelas de um evento financeiro (para sincronizar baixas/status). */
export async function listarParcelas(idEvento) {
  const { data } = await ca.get(`/v1/financeiro/eventos-financeiros/${idEvento}/parcelas`);
  return Array.isArray(data) ? data : (data?.items || data?.itens || data?.content || []);
}

/** Exclui uma conta a pagar pelo id, tentando os caminhos possíveis de DELETE. */
async function deletarPorId(id) {
  const caminhos = [
    '/v1/financeiro/eventos-financeiros/contas-a-pagar/' + id,
    '/v1/financeiro/eventos-financeiros/' + id,
  ];
  const tentativas = {};
  for (const p of caminhos) {
    try { const r = await ca.del(p); tentativas[p] = r.status; return { ok: true, via: p, status: r.status, tentativas }; }
    catch (e) { tentativas[p] = (e.status || '?') + ' ' + (e.message || ''); }
  }
  return { ok: false, tentativas };
}

/**
 * Cancela (exclui) a(s) conta(s) a pagar de um frete (codigo_referencia = nº do frete).
 * @param {string|number} frete
 * @param {boolean} aplicar  false = só acha e mostra (não exclui); true = exclui.
 */
export async function cancelarContaAPagarPorFrete(frete, aplicar = false) {
  const f = String(frete).trim();
  const itens = await buscarContasAPagarPorReferencia(f);
  // filtra client-side: bate o codigo_referencia OU a descrição contém #frete
  const bate = (x) => {
    const cr = String(x.codigo_referencia || x.codigoReferencia || '');
    const dsc = String(x.descricao || '');
    return cr.split(',').map((s) => s.trim()).includes(f) || dsc.includes('#' + f) || new RegExp('(^|\\D)' + f + '(\\D|$)').test(dsc);
  };
  const alvo = itens.filter(bate);
  const achados = alvo.map((x) => ({ id: x.id || x.uuid, descricao: x.descricao, total: x.total, status: x.status }));
  if (!aplicar) return { aplicar: false, encontrados: achados.length, achados };

  const resultados = [];
  for (const x of alvo) {
    const id = x.id || x.uuid;
    if (!id) continue;
    const r = await deletarPorId(id);
    resultados.push({ id, descricao: x.descricao, ...r });
  }
  return { aplicar: true, encontrados: achados.length, achados, resultados };
}
