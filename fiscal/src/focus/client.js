// Cliente da API Focus NFe (https://focusnfe.com.br/doc/).
// Autenticação: HTTP Basic com o token como usuário e senha vazia.
// Homologação e produção têm hosts diferentes (config.focus.baseUrl).
import { config } from '../config.js';

async function focusFetch(method, path, body) {
  const auth = Buffer.from(config.focus.token + ':').toString('base64');
  const res = await fetch(config.focus.baseUrl + path, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok && res.status !== 202) {
    const e = new Error(`Focus ${method} ${path} => ${res.status}`);
    e.status = res.status; e.data = data;
    throw e;
  }
  return { status: res.status, data };
}

/** Emite um CT-e (assíncrono na Focus — consultar depois pela ref). */
export const emitirCte = (ref, payload) => focusFetch('POST', `/v2/cte?ref=${encodeURIComponent(ref)}`, payload);
/** Consulta um CT-e pela ref. */
export const consultarCte = (ref) => focusFetch('GET', `/v2/cte/${encodeURIComponent(ref)}`);
/** Cancela um CT-e (justificativa mín. 15 caracteres). */
export const cancelarCte = (ref, justificativa) => focusFetch('DELETE', `/v2/cte/${encodeURIComponent(ref)}`, { justificativa });
/** Carta de correção. */
export const cartaCorrecaoCte = (ref, correcao) => focusFetch('POST', `/v2/cte/${encodeURIComponent(ref)}/carta_correcao`, { correcao });
