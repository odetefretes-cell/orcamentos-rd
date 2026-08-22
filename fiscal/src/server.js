// Ponto de entrada do obs-fiscal (porta 3003, systemd — ver servidor-obs/deploy-fiscal.sh).
import { config } from './config.js';
import { createApp } from './app.js';
import { garantirSchema } from './store/db.js';
import { log } from './logger.js';

const app = createApp();
try { await garantirSchema(); } catch (e) { log.warn('não consegui garantir o schema (Postgres fora?)', { msg: e.message }); }
app.listen(config.port, () => {
  log.info('obs-fiscal no ar', { port: config.port, ambiente: config.focus.ambiente });
});
