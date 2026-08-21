// Cliente HTTP autenticado do Conta Azul.
//  - garante access_token válido (renova sozinho antes de vencer)
//  - em 401, tenta refresh 1x e repete
//  - em 429, backoff exponencial (rate limit: 600/min, 10/s)
import { config } from '../config.js';
import { log } from '../logger.js';
import { getTokens, hasValidAccessToken } from '../auth/tokenStore.js';
import { refresh } from '../auth/oauth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureAccessToken() {
  if (hasValidAccessToken()) return getTokens().access_token;
  await refresh();
  const t = getTokens();
  if (!t?.access_token) throw new Error('Não foi possível obter access_token. Refaça o login em /oauth/start.');
  return t.access_token;
}

/**
 * Chamada crua à API do Conta Azul.
 * @param {string} method
 * @param {string} path  ex.: '/v1/venda'
 * @param {object} [opts] { query, body }
 * @returns {Promise<{status:number, data:any, headers:Headers}>}
 */
export async function caFetch(method, path, opts = {}) {
  const { query, body } = opts;
  let url = config.contaAzul.apiBase + path;
  if (query) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null)
    ).toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  const maxAttempts = 5;
  let attempt = 0;
  let triedRefresh = false;

  while (true) {
    attempt++;
    const token = await ensureAccessToken();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // 401: token pode ter morrido antes da hora — refresh 1x e repete
    if (res.status === 401 && !triedRefresh) {
      triedRefresh = true;
      log.warn('CA 401 — tentando refresh e repetindo', { path });
      await refresh();
      continue;
    }

    // 429 / 5xx: backoff e repete
    if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = retryAfter ? retryAfter * 1000 : Math.min(16000, 500 * 2 ** (attempt - 1));
      log.warn('CA backoff', { status: res.status, path, waitMs: wait, attempt });
      await sleep(wait);
      continue;
    }

    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    if (!res.ok && res.status !== 202) {
      const err = new Error(`Conta Azul ${method} ${path} => ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return { status: res.status, data, headers: res.headers };
  }
}

export const ca = {
  get: (path, query) => caFetch('GET', path, { query }),
  post: (path, body) => caFetch('POST', path, { body }),
  put: (path, body) => caFetch('PUT', path, { body }),
  patch: (path, body) => caFetch('PATCH', path, { body }),
  del: (path) => caFetch('DELETE', path),
};
