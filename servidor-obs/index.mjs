#!/usr/bin/env node
/* ===========================================================================
 *  PLACEHOLDER - so para validar o PM2 antes do robo real existir.
 *  Quando o Claude Code entregar o codigo do robo, este arquivo e substituido.
 *  Fica vivo, bate um "heartbeat" a cada 5 min e nao faz NADA no ChatGuru/CRM.
 * =========================================================================== */
import fs from 'node:fs';
try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: fs.existsSync('/etc/obs-robo/.env') ? '/etc/obs-robo/.env' : '.env', quiet: true });
} catch {}

const DRY = String(process.env.DRY_RUN ?? 'true') === 'true';
const agora = () => new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

console.log(`[${agora()}] obs-robo (placeholder) iniciado. DRY_RUN=${DRY}`);
console.log(`[${agora()}] Nenhuma rotina implementada ainda - nada sera enviado nem gravado.`);

setInterval(() => console.log(`[${agora()}] vivo | DRY_RUN=${DRY} | rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`), 5 * 60 * 1000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log(`[${agora()}] recebido ${sig}, encerrando com calma.`); process.exit(0); });
}
