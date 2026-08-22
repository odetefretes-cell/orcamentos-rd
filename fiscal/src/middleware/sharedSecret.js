// Só aceita chamadas com o segredo compartilhado (o obs-api injeta no proxy;
// o navegador nunca vê). Mesmo padrão do obs-contaazul.
import { config } from '../config.js';

export function requireObsSecret(req, res, next) {
  const seg = req.get('x-obs-secret') || '';
  if (!config.obsSharedSecret || seg !== config.obsSharedSecret) {
    return res.status(401).json({ ok: false, erro: 'não autorizado' });
  }
  next();
}
