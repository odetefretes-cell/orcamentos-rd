// Tratador de erros central. Traduz erros conhecidos em respostas limpas.
import { log } from '../logger.js';

export function notFound(req, res) {
  res.status(404).json({ erro: 'Rota não encontrada' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  log.error('Erro na requisição', {
    rota: req.method + ' ' + req.path,
    status,
    msg: err.message,
    caData: err.data,
  });
  res.status(status >= 400 && status < 600 ? status : 500).json({
    erro: err.publicMessage || err.message || 'Erro interno',
    ...(err.data ? { detalhe: err.data } : {}),
  });
}
