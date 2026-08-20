// Reconciliação do 202: contas a pagar não devolvem o id na criação.
// Este job roda de tempos em tempos, pega as despesas pendentes e busca no
// Conta Azul pelo código de referência (nº do frete) para preencher o ca_id.
import { despesasPendentes, marcarReconciliado, marcarErro } from '../store/ledger.js';
import { buscarContasAPagarPorReferencia } from '../contaazul/financeiro.js';
import { hasValidAccessToken } from '../auth/tokenStore.js';
import { config } from '../config.js';
import { log } from '../logger.js';

export async function reconciliarUmaVez() {
  const pendentes = despesasPendentes();
  if (pendentes.length === 0) return { verificadas: 0, reconciliadas: 0 };

  let reconciliadas = 0;
  for (const p of pendentes) {
    try {
      const fretePrincipal = String(p.frete).split(',')[0];
      const encontrados = await buscarContasAPagarPorReferencia(fretePrincipal);
      // casa por valor + referência para achar o registro certo
      const alvo = encontrados.find((e) => {
        const val = Number(e.valor ?? e.total ?? e.valor_total);
        return Math.abs((val || 0) - p.valor) < 0.005;
      }) || encontrados[0];
      if (alvo?.id) {
        marcarReconciliado(p.id, alvo.id);
        reconciliadas++;
        log.info('Despesa reconciliada', { launchId: p.id, caId: alvo.id });
      }
    } catch (e) {
      log.warn('Falha ao reconciliar despesa', { launchId: p.id, msg: e.message });
      // não marca erro definitivo: tenta de novo na próxima rodada
    }
  }
  return { verificadas: pendentes.length, reconciliadas };
}

let timer = null;

export function iniciarReconciliador() {
  if (timer) return;
  const tick = async () => {
    try {
      if (!hasValidAccessToken()) return; // sem conexão ativa, espera
      await reconciliarUmaVez();
    } catch (e) {
      log.error('Reconciliador falhou', { msg: e.message });
    }
  };
  timer = setInterval(tick, config.reconcileIntervalMs);
  timer.unref?.();
  log.info('Reconciliador iniciado', { intervaloMs: config.reconcileIntervalMs });
}

export function pararReconciliador() {
  if (timer) clearInterval(timer);
  timer = null;
}
