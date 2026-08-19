/* Stub de firebase-functions/v2/scheduler (VPS).
   onSchedule(opts, handler) → devolve a função de job crua (async () => ...),
   que o node-cron do orquestrador chama de minuto em minuto. */
'use strict';
exports.onSchedule = (opts, handler) => (typeof opts === 'function' ? opts : handler);
