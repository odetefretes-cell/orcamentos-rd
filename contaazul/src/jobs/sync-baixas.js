// BAIXA AUTOMÁTICA Conta Azul → sistema OBS.
// De tempos em tempos, olha as VENDAS registradas no CA e confere as parcelas:
//   parcela PAGA no CA → preenche Pago1/Pago2 + data no frete (via obs-api).
//   PIX pago (1ª parcela) e frete ainda no financeiro → LIBERA ao operacional sozinho.
//   Boleto → só a baixa (o frete já foi liberado; transporte em andamento).
//   Cartão → NÃO passa por aqui (pagamento é na plataforma Rede, o CA não vê).
// Quando todas as parcelas estão pagas, marca 'baixado_total' e para de consultar.
import { ca } from '../contaazul/client.js';
import { listarParcelas } from '../contaazul/financeiro.js';
import { vendasParaSincronizar, marcarStatusVenda } from '../store/ledger.js';
import { hasValidAccessToken } from '../auth/tokenStore.js';
import { config } from '../config.js';
import { log } from '../logger.js';

const OBS_API_URL = (process.env.OBS_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const OBS_API_TOKEN = String(process.env.OBS_API_TOKEN || '');

async function apiObs(metodo, caminho, corpo) {
  const r = await fetch(OBS_API_URL + caminho, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OBS_API_TOKEN },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  if (!r.ok) { const e = new Error(`obs-api ${metodo} ${caminho} => ${r.status}`); e.data = data; throw e; }
  return data;
}

// parcelas da venda no CA (o id da venda pode não ser o do evento financeiro)
async function parcelasDaVenda(caId) {
  try { const ps = await listarParcelas(caId); if (ps.length) return ps; } catch (_) {}
  try {
    const vd = (await ca.get('/v1/venda/' + caId)).data;
    const fid = vd?.evento_financeiro?.id || vd?.id_evento_financeiro || vd?.financeiro?.id;
    if (fid) return await listarParcelas(fid);
  } catch (_) {}
  return [];
}

const parcelaPaga = (p) => {
  const st = String(p.status || '');
  if (/^(PAG|LIQUID|RECEB|BAIXAD|ACQUITT)/i.test(st)) return true;
  const vp = Number(p.valor_pago ?? 0);
  const np = p.nao_pago == null ? null : Number(p.nao_pago);
  return vp > 0.005 && (np == null || np <= 0.005);
};
const valorDaParcela = (p) =>
  Number(p.valor_pago) || Number(p.valor_composicao?.valor_liquido) || Number(p.valor_composicao?.valor_bruto) || Number(p.valor) || 0;
const dataDaBaixa = (p) =>
  String(p.data_pagamento || (Array.isArray(p.baixas) && p.baixas[0] && (p.baixas[0].data || p.baixas[0].data_pagamento)) || new Date().toISOString()).slice(0, 10);

export async function sincronizarBaixasUmaVez() {
  if (!OBS_API_TOKEN) return { pulado: 'sem OBS_API_TOKEN no .env' };
  const vendas = vendasParaSincronizar();
  if (!vendas.length) return { vendas: 0 };

  // mapa numero-do-frete → doc do sistema (1 chamada por ciclo)
  const fretes = await apiObs('GET', '/api/fretes');
  const porNumero = new Map();
  for (const f of (Array.isArray(fretes) ? fretes : [])) {
    const n = String(f.numero || '').trim();
    if (n) porNumero.set(n, f);
  }

  let baixadas = 0, liberados = 0, completas = 0;
  for (const v of vendas) {
    try {
      const f = porNumero.get(String(v.frete).trim());
      if (!f) continue;
      const fp = String(f.formaPgto || '');
      if (/cart/i.test(fp)) continue;                       // cartão = Rede, CA não enxerga

      const parcelas = (await parcelasDaVenda(v.ca_id))
        .sort((a, b) => String(a.data_vencimento || '').localeCompare(String(b.data_vencimento || '')));
      if (!parcelas.length) continue;

      const upd = {};
      let todasPagas = true;
      parcelas.slice(0, 2).forEach((p, i) => {
        if (!parcelaPaga(p)) { todasPagas = false; return; }
        const campo = 'pago' + (i + 1);
        const jaTem = Number(String(f[campo] || '0').replace(/\./g, '').replace(',', '.')) > 0.005 || Number(f[campo] || 0) > 0.005;
        if (!jaTem) {
          upd[campo] = valorDaParcela(p).toFixed(2);
          upd['dataPago' + (i + 1)] = dataDaBaixa(p);
        }
      });
      if (parcelas.length > 2) todasPagas = false;          // >2 parcelas: não automatiza (raro)

      // PIX pago e frete ainda parado no financeiro → libera ao operacional sozinho
      const primeiraPaga = parcelas[0] && parcelaPaga(parcelas[0]);
      if (/pix/i.test(fp) && primeiraPaga && String(f.etapa || '') === 'financeiro') {
        upd.etapa = 'operacional';
        upd.liberadoEm = new Date().toISOString();
        liberados++;
      }

      if (Object.keys(upd).length) {
        upd._salvoEm = new Date().toISOString();
        upd.obsPagamento = ((f.obsPagamento ? f.obsPagamento + ' | ' : '') + 'baixa automática Conta Azul').slice(0, 300);
        await apiObs('PUT', '/api/fretes/' + encodeURIComponent(f.id) + '?merge=1', upd);
        baixadas++;
        log.info('Baixa automática aplicada', { frete: v.frete, campos: Object.keys(upd).join(',') });
      }
      if (todasPagas) { marcarStatusVenda(v.id, 'baixado_total'); completas++; }
    } catch (e) {
      log.warn('Sync baixa falhou (tenta de novo depois)', { frete: v.frete, msg: e.message });
    }
  }
  return { vendas: vendas.length, baixadas, liberados, completas };
}

let timer = null;
export function iniciarSincronizadorBaixas() {
  if (timer) return;
  const tick = async () => {
    try {
      if (!hasValidAccessToken()) return;
      const r = await sincronizarBaixasUmaVez();
      if (r && (r.baixadas || r.liberados)) log.info('Sync baixas', r);
    } catch (e) { log.error('Sincronizador de baixas falhou', { msg: e.message }); }
  };
  timer = setInterval(tick, config.reconcileIntervalMs);
  timer.unref?.();
  setTimeout(tick, 20 * 1000);   // primeira rodada logo após subir
}
