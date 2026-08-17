/* ===========================================================================
 *  PM2 - OBS Transportes / robo de rotinas
 *  Sobe DESLIGADO por padrao (autostart: false) e em modo-teste (DRY_RUN=true).
 *  Segredos NAO ficam aqui: vem de /etc/obs-robo/.env via dotenv no app.
 *
 *  Comandos:
 *    pm2 start ecosystem.config.cjs --only obs-robo     # liga (modo-teste)
 *    pm2 logs obs-robo                                  # ver o que ele faria
 *    pm2 stop obs-robo                                  # desliga
 *    pm2 save                                           # grava o estado p/ o boot
 * =========================================================================== */
module.exports = {
  apps: [
    {
      name: 'obs-robo',
      script: 'index.mjs',
      cwd: '/opt/obs-robo',
      interpreter: 'node',
      autostart: false,          // nao sobe sozinho ate voce validar
      autorestart: true,         // se cair depois de ligado, reinicia
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 10000,
      max_memory_restart: '900M', // Chromium vaza memoria com o tempo
      kill_timeout: 20000,        // tempo para fechar o navegador com calma
      env: {
        NODE_ENV: 'production',
        TZ: 'America/Sao_Paulo',
        PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers',
        DOTENV_CONFIG_PATH: '/etc/obs-robo/.env',
      },
      out_file: '/opt/obs-robo/logs/saida.log',
      error_file: '/opt/obs-robo/logs/erro.log',
      log_date_format: 'DD/MM/YYYY HH:mm:ss',
      merge_logs: true,
    },
  ],
};
