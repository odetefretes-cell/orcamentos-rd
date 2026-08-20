// Monta o app Express (sem subir o listener — facilita teste).
import express from 'express';
import { config } from './config.js';
import { oauthRouter } from './routes/oauth.js';
import { obsRouter } from './routes/obs.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // CORS: libera só o domínio do sistema OBS (OBS_ORIGIN no .env).
  const origin = process.env.OBS_ORIGIN || '';
  app.use((req, res, next) => {
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-OBS-Secret');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true, env: config.env, ts: new Date().toISOString() }));

  app.use('/oauth', oauthRouter);
  app.use('/obs', obsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
