/* PM2 — serviço da automação OBS (VPS Hostinger).
   Sobe: pm2 start ecosystem.automacao.cjs
   O .env fica em /etc/obs-automacao/.env (fora do repo). */
'use strict';
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'obs-automacao',
      script: path.join(__dirname, 'orquestrador.js'),
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',           // 1 instância só (o cron NÃO pode rodar em paralelo)
      autorestart: true,
      max_restarts: 20,
      max_memory_restart: '400M',
      // Carrega as variáveis do arquivo protegido do servidor.
      node_args: '-r dotenv/config',
      env: {
        NODE_ENV: 'production',
        DOTENV_CONFIG_PATH: '/etc/obs-automacao/.env',
        OBS_USAR_PG: 'true',
        PORT: '3001',
        HOST: '127.0.0.1',
        TZ: 'America/Sao_Paulo',
      },
      out_file: '/var/log/obs-automacao/out.log',
      error_file: '/var/log/obs-automacao/err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
