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
 * Exclui uma conta a pagar. A busca devolve o id da PARCELA; a exclusão certa é
 * do EVENTO pai (DELETE /v1/financeiro/eventos-financeiros/{evento_id}). Pegamos
 * o evento.id lendo a parcela e excluímos o evento.
 * @param {string} parcelaId  id vindo da busca (é o id da parcela)
 */
async function deletarPorId(parcelaId) {
  const tentativas = {};
  const tenta = async (metodo, path) => {
    const chave = `${metodo} ${path}`;
    try {
      const r = metodo === 'DELETE' ? await ca.del(path) : await ca.post(path, {});
      tentativas[chave] = r.status;
      return r.status >= 200 && r.status < 300;
    } catch (e) { tentativas[chave] = (e.status || '?') + ' ' + (e.message || ''); return false; }
  };

  // id do EVENTO a partir da parcela
  let eventoId = null;
  try {
    const p = (await ca.get(`/v1/financeiro/eventos-financeiros/parcelas/${parcelaId}`)).data;
    eventoId = p?.evento?.id || (typeof p?.evento === 'string' ? p.evento : null);
  } catch (e) { tentativas['getParcela'] = (e.status || '?') + ' ' + (e.message || ''); }

  // 1) excluir o EVENTO (caminho correto)
  if (eventoId) {
    if (await tenta('DELETE', `/v1/financeiro/eventos-financeiros/${eventoId}`)) return { ok: true, via: 'evento', eventoId, tentativas };
    if (await tenta('DELETE', `/v1/financeiro/eventos-financeiros/contas-a-pagar/${eventoId}`)) return { ok: true, via: 'evento-cp', eventoId, tentativas };
  }
  // 2) fallback: excluir a parcela direto
  if (await tenta('DELETE', `/v1/financeiro/eventos-financeiros/parcelas/${parcelaId}`)) return { ok: true, via: 'parcela', parcelaId, tentativas };

  return { ok: false, eventoId, parcelaId, tentativas };
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

export async function cancelarContaAPagarPorFrete(frete, aplicar = false, diag = false) {
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

  if (diag) {
    const g = async (p) => { try { return (await ca.get(p)).data; } catch (e) { return { erro: (e.status || '?') + ' ' + e.message, data: e.data }; } };
    const out = [];
    for (const x of alvo) {
      const id = x.id || x.uuid;
      out.push({
        id,
        item_bruto: x,
        parcela_detalhe: await g(`/v1/financeiro/eventos-financeiros/parcelas/${id}`),
        evento_detalhe: await g(`/v1/financeiro/eventos-financeiros/${id}`),
        evento_parcelas: await g(`/v1/financeiro/eventos-financeiros/${id}/parcelas`),
      });
    }
    return { diag: true, encontrados: achados.length, detalhes: out };
  }

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

/**
 * Dá BAIXA numa parcela (schema oficial BaixaCriacaoRequestDTO):
 *   POST /v1/financeiro/eventos-financeiros/parcelas/{parcela_id}/baixa
 *   required: data_pagamento, conta_financeira, composicao_valor
 */
export async function darBaixaParcela({ parcelaId, valor, data, contaFinanceira, metodo, observacao }) {
  const v = Math.round(Number(valor) * 100) / 100;
  const body = {
    data_pagamento: data,
    conta_financeira: contaFinanceira,
    composicao_valor: { valor_bruto: v, valor_liquido: v, desconto: 0, juros: 0, multa: 0, taxa: 0 },
    ...(metodo ? { metodo_pagamento: metodo } : {}),
    ...(observacao ? { observacao } : {}),
  };
  const { status, data: d } = await ca.post(`/v1/financeiro/eventos-financeiros/parcelas/${parcelaId}/baixa`, body);
  return { status, data: d };
}
