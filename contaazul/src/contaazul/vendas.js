// Vendas (a receita do frete). POST /v1/venda cria a venda com parcelas.
// A venda é SÍNCRONA: o POST devolve o registro criado com id e número.
import { ca } from './client.js';
import { log } from '../logger.js';

/**
 * Cria uma venda no Conta Azul.
 * @param {object} payload  já no formato da API (ver domain/mapVenda.js)
 * @returns {Promise<{id:string, numero:number, raw:object}>}
 */
export async function criarVenda(payload) {
  const { data } = await ca.post('/v1/venda', payload);
  const id = data?.id || data?.uuid;
  const numero = data?.numero ?? payload.numero;
  if (!id) {
    log.warn('Venda criada mas sem id no retorno', { retorno: data });
  }
  return { id, numero, raw: data };
}

/**
 * Busca uma venda pelo número (para sincronizar status / evitar duplicidade).
 */
export async function buscarVendaPorNumero(numero) {
  const { data } = await ca.get('/v1/venda/busca', { numero });
  const lista = Array.isArray(data) ? data : (data?.itens || data?.content || []);
  return lista.find((v) => String(v.numero) === String(numero)) || null;
}
