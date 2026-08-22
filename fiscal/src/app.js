import express from 'express';
import { obsRouter } from './routes/obs.js';
import { config, prontoParaEmitir } from './config.js';
import { log } from './logger.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => {
    const p = prontoParaEmitir();
    res.json({ ok: true, servico: 'obs-fiscal', ambiente: config.focus.ambiente, prontoParaEmitir: p.pronto, faltando: p.faltando });
  });

  app.use('/obs', obsRouter);

  // erro padrão
  app.use((err, _req, res, _next) => {
    log.error('erro na rota', { msg: err.message, status: err.status, data: err.data });
    res.status(err.status && err.status >= 400 ? err.status : 500)
      .json({ ok: false, erro: err.message, detalhe: err.data });
  });
  return app;
}
