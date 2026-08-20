// Fluxo OAuth2 Authorization Code do Conta Azul (API v2).
//  - buildAuthorizeUrl(): monta a URL de login/autorização
//  - exchangeCode(): troca o code por tokens (authorization_code)
//  - refresh(): renova o access_token (refresh_token, rotativo)
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { saveTokens, getTokens, saveState } from './tokenStore.js';

function basicAuthHeader() {
  const { clientId, clientSecret } = config.contaAzul;
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

export function buildAuthorizeUrl() {
  const state = randomBytes(16).toString('hex');
  saveState(state);
  const { authUrl, clientId, redirectUri, scope } = config.contaAzul;
  // A authorize URL usa fragmento (#/oauth/authorize); os parâmetros vão na query.
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope,
  });
  const sep = authUrl.includes('?') ? '&' : '?';
  return `${authUrl}${sep}${params.toString()}`;
}

async function postToken(body) {
  const res = await fetch(config.contaAzul.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Falha no token endpoint (${res.status}): ${json.error || text}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export async function exchangeCode(code) {
  const json = await postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.contaAzul.redirectUri,
  });
  saveTokens(json);
  log.info('OAuth: code trocado por tokens com sucesso');
  return json;
}

let refreshing = null; // evita corrida de refresh simultâneo

export async function refresh() {
  if (refreshing) return refreshing;
  const current = getTokens();
  if (!current?.refresh_token) {
    throw new Error('Sem refresh_token salvo. É preciso refazer o login em /oauth/start.');
  }
  refreshing = (async () => {
    try {
      const json = await postToken({
        grant_type: 'refresh_token',
        refresh_token: current.refresh_token,
      });
      // json pode trazer um refresh_token NOVO — saveTokens persiste.
      saveTokens(json);
      log.info('OAuth: access_token renovado');
      return json;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
