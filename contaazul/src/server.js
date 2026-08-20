// Ponto de entrada: sobe o listener. O app em si fica em app.js (facilita teste).
import { config } from './config.js';
import { log } from './logger.js';
import { getDb } from './store/db.js';
import { createApp } from './app.js';
import { iniciarReconciliador } from './jobs/reconcile.js';

// Reexporta para quem importava createApp daqui.
export { createApp } from './app.js';

const executadoDireto = process.argv[1] && process.argv[1].endsWith('server.js');
if (executadoDireto) {
  getDb(); // garante o schema
  const app = createApp();
  app.listen(config.port, () => {
    log.info('Servidor no ar', { port: config.port, env: config.env });
    iniciarReconciliador();
  });
}
