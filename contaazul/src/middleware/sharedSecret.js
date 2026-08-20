// Protege as rotas /obs/* com um segredo compartilhado.
// O site do OBS manda o header X-OBS-Secret. Comparação em tempo constante.
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export function requireObsSecret(req, res, next) {
  const enviado = req.get('x-obs-secret') || '';
  const esperado = config.obsSharedSecret || '';
  if (!esperado) {
    return res.status(500).json({ erro: 'OBS_SHARED_SECRET não configurado no servidor.' });
  }
  const a = Buffer.from(enviado);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ erro: 'Segredo inválido.' });
  }
  next();
}
