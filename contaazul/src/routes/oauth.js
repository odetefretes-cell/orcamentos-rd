// Rotas do OAuth: iniciar a conexão e receber o callback do Conta Azul.
import { Router } from 'express';
import { config, assertContaAzulConfigured } from '../config.js';
import { buildAuthorizeUrl, exchangeCode } from '../auth/oauth.js';
import { consumeState, getTokens } from '../auth/tokenStore.js';
import { log } from '../logger.js';

export const oauthRouter = Router();

// Abra no navegador uma vez para conectar a conta.
oauthRouter.get('/start', (req, res, next) => {
  try {
    assertContaAzulConfigured();
    res.redirect(buildAuthorizeUrl());
  } catch (e) { next(e); }
});

// Redirect_uri cadastrado no app de produção do Conta Azul aponta pra cá.
oauthRouter.get('/callback', async (req, res, next) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`Conta Azul retornou erro: ${error}`);
    if (!code) return res.status(400).send('Faltou o parâmetro "code".');
    if (!state || !consumeState(String(state))) {
      return res.status(400).send('State inválido ou expirado. Recomece em /oauth/start.');
    }
    await exchangeCode(String(code));
    log.info('OAuth conectado com sucesso');
    res.send(`
      <html lang="pt-BR"><meta charset="utf-8">
      <body style="font-family:sans-serif;max-width:520px;margin:60px auto;text-align:center">
      <h2>✅ Conta Azul conectado</h2>
      <p>Pode fechar esta aba. A integração já pode lançar vendas e despesas.</p>
      </body></html>`);
  } catch (e) { next(e); }
});

// Diagnóstico simples: mostra se há token e quando renova (sem expor o token).
oauthRouter.get('/status', (req, res) => {
  const t = getTokens();
  res.json({
    conectado: !!(t && t.refresh_token),
    accessTokenValidoAte: t?.access_expires_at ? new Date(t.access_expires_at).toISOString() : null,
    apiBase: config.contaAzul.apiBase,
  });
});
