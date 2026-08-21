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

/**
 * Exclui uma conta a pagar. A exclusão no Conta Azul é POR PARCELA
 * (DELETE /v1/financeiro/eventos-financeiros/parcelas/{parcela_id}).
 * `id` é o id do EVENTO (vindo da busca) → pegamos as parcelas e excluímos cada uma.
 */
async function deletarPorId(id) {
  const delParcela = async (pid) => {
    const path = `/v1/financeiro/eventos-financeiros/parcelas/${pid}`;
    // 502 às vezes é transitório: tenta até 3x
    for (let i = 0; i < 3; i++) {
      try { const r = await ca.del(path); return { status: r.status }; }
      catch (e) { if (e.status !== 502 || i === 2) return { status: e.status || '?', erro: e.message }; await new Promise((r) => setTimeout(r, 1500)); }
    }
  };

  const tentativas = {};
  // 1) parcelas do evento
  let parcelaIds = [];
  try { const ps = await listarParcelas(id); parcelaIds = ps.map((p) => p.id || p.uuid || p.id_parcela).filter(Boolean); }
  catch (e) { tentativas['listarParcelas'] = (e.status || '?') + ' ' + (e.message || ''); }

  // 2) exclui cada parcela; se não achou parcela, tenta o próprio id como parcela
  const ids = parcelaIds.length ? parcelaIds : [id];
  let okCount = 0;
  for (const pid of ids) {
    const r = await delParcela(pid);
    const chave = `DELETE parcelas/${pid}`;
    tentativas[chave] = r.status + (r.erro ? ' ' + r.erro : '');
    if (r.status >= 200 && r.status < 300) okCount++;
  }
  const ok = okCount > 0 && okCount === ids.length;
  return { ok, parcelaIds, excluidasParcelas: okCount, tentativas };
}

/**
 * Cancela (exclui) a(s) conta(s) a pagar de um frete (codigo_referencia = nº do frete).
 * @param {string|number} frete
 * @param {boolean} aplicar  false = só acha e mostra (não exclui); true = exclui.
 */
/** Busca AMPLA de contas a pagar (±120 dias), paginando até esgotar. */
async function buscarContasAPagarAmplo() {
  const iso = (d) => d.toISOString().slice(0, 10);
  const hoje = new Date();
  const de = new Date(hoje); de.setDate(de.getDate() - 120);
  const ate = new Date(hoje); ate.setDate(ate.getDate() + 120);
  const todos = [];
  for (let pag = 1; pag <= 20; pag++) {
    const { data } = await ca.get('/v1/financeiro/eventos-financeiros/contas-a-pagar/buscar', {
      data_vencimento_de: iso(de), data_vencimento_ate: iso(ate), tamanho_pagina: 500, pagina: pag,
    });
    const arr = Array.isArray(data) ? data : (data?.items || data?.itens || data?.content || []);
    todos.push(...arr);
    if (arr.length < 500) break;   // última página
  }
  return todos;
}

export async function cancelarContaAPagarPorFrete(frete, aplicar = false) {
  const f = String(frete).trim();
  // busca AMPLA + filtra aqui (não confia no filtro do CA, que pode ignorar codigo_referencia)
  const itens = await buscarContasAPagarAmplo();
  const bate = (x) => {
    const cr = String(x.codigo_referencia || x.codigoReferencia || '');
    const dsc = String(x.descricao || '');
    return cr.split(',').map((s) => s.trim()).includes(f) || dsc.includes('#' + f) || new RegExp('(^|\\D)' + f + '(\\D|$)').test(dsc);
  };
  const alvo = itens.filter(bate);
  const achados = alvo.map((x) => ({ id: x.id || x.uuid, descricao: x.descricao, total: x.total, status: x.status }));
  if (!aplicar) return { aplicar: false, brutos: itens.length, encontrados: achados.length, achados };

  const resultados = [];
  for (const x of alvo) {
    const id = x.id || x.uuid;
    if (!id) continue;
    const r = await deletarPorId(id);
    resultados.push({ id, descricao: x.descricao, ...r });
  }
  return { aplicar: true, encontrados: achados.length, achados, resultados };
}
