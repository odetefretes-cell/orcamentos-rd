// Rotas do obs-fiscal (protegidas pelo segredo compartilhado):
//   GET  /obs/cte/preview?frete=N  → monta o JSON do CT-e do frete (NÃO emite) + avisos
//   POST /obs/cte/emitir  {frete}  → emite via Focus NFe (só com FASE 0 completa)
//   GET  /obs/cte/status?frete=N   → docs fiscais do frete (fiscal_docs) + consulta Focus
//   POST /obs/webhook/focus        → webhook da Focus (autorizado/rejeitado) [Fase 2]
import { Router } from 'express';
import { config, prontoParaEmitir } from '../config.js';
import { requireObsSecret } from '../middleware/sharedSecret.js';
import { freteDoCrm, upsertDoc, docsDoFrete } from '../store/db.js';
import { mapCte } from '../domain/mapCte.js';
import { emitirCte, consultarCte } from '../focus/client.js';
import { log } from '../logger.js';

export const obsRouter = Router();

// webhook da Focus NÃO tem o nosso segredo (vem de fora) — validado por token na URL depois.
obsRouter.post('/webhook/focus', async (req, res) => {
  try {
    const b = req.body || {};
    log.info('Webhook Focus recebido', { ref: b.ref, status: b.status });
    if (b.ref) {
      await upsertDoc({
        id: b.ref,
        freteId: '', freteNumero: String(b.ref).replace(/^cte_/, ''),
        tipo: 'cte',
        status: b.status || 'desconhecido',
        chave: b.chave_cte || b.chave || null,
        xmlUrl: b.caminho_xml || null,
        pdfUrl: b.caminho_dacte || null,
        data: { webhook: b },
      });
      // TODO Fase 3: se status === 'autorizado' → enviar XML à averbadora e gravar num_averbacao
    }
    res.json({ ok: true });
  } catch (e) { log.error('webhook focus falhou', { msg: e.message }); res.json({ ok: false }); }
});

obsRouter.use(requireObsSecret);

// ---------- PREVIEW (Fase 0/1: validar o JSON com o contador — não emite nada) ----------
obsRouter.get('/cte/preview', async (req, res) => {
  const numero = String(req.query.frete || '').trim();
  if (!numero) return res.status(400).json({ ok: false, erro: 'Informe ?frete=NUMERO' });
  const f = await freteDoCrm(numero);
  if (!f) return res.status(404).json({ ok: false, erro: `Frete ${numero} não encontrado no CRM.` });
  const { payload, avisos } = mapCte(f);
  const p = prontoParaEmitir();
  res.json({
    ok: true, modo: p.pronto ? 'PRONTO PARA EMITIR (homologação)' : 'PREVIEW (Fase 0 incompleta)',
    faltandoConfig: p.faltando, avisosDoFrete: avisos, cte: payload,
  });
});

// ---------- EMITIR ----------
obsRouter.post('/cte/emitir', async (req, res, next) => {
  try {
    const numero = String(req.body?.frete || '').trim();
    if (!numero) return res.status(400).json({ ok: false, erro: 'Informe "frete".' });
    const p = prontoParaEmitir();
    if (!p.pronto) {
      return res.status(409).json({ ok: false, erro: 'Fase 0 incompleta — faltam: ' + p.faltando.join(', ') + '. Use /obs/cte/preview para validar o JSON enquanto isso.' });
    }
    const f = await freteDoCrm(numero);
    if (!f) return res.status(404).json({ ok: false, erro: `Frete ${numero} não encontrado no CRM.` });
    const { payload, avisos } = mapCte(f);
    if (avisos.length) return res.status(409).json({ ok: false, erro: 'Frete com pendências: ' + avisos.join('; '), avisos });

    const ref = `cte_${numero}`;
    const r = await emitirCte(ref, payload);
    await upsertDoc({ id: ref, freteId: f.id, freteNumero: numero, tipo: 'cte', status: 'enviado', data: { envio: r.data, ambiente: config.focus.ambiente } });
    log.info('CT-e enviado à Focus', { ref, ambiente: config.focus.ambiente, status: r.status });
    res.status(202).json({ ok: true, ref, ambiente: config.focus.ambiente, focus: r.data, mensagem: 'CT-e enviado — processamento assíncrono; consulte /obs/cte/status.' });
  } catch (e) { next(e); }
});

// ---------- STATUS ----------
obsRouter.get('/cte/status', async (req, res, next) => {
  try {
    const numero = String(req.query.frete || '').trim();
    if (!numero) return res.status(400).json({ ok: false, erro: 'Informe ?frete=NUMERO' });
    const locais = await docsDoFrete(numero);
    let focus = null;
    if (config.focus.token && locais.some((d) => d.tipo === 'cte')) {
      try {
        const r = await consultarCte(`cte_${numero}`);
        focus = r.data;
        if (focus?.status) {
          await upsertDoc({
            id: `cte_${numero}`, freteId: locais[0]?.frete_id || '', freteNumero: numero, tipo: 'cte',
            status: focus.status, chave: focus.chave_cte || focus.chave || null,
            xmlUrl: focus.caminho_xml || null, pdfUrl: focus.caminho_dacte || null,
            data: { consulta: focus },
          });
        }
      } catch (e) { focus = { erro: e.message, data: e.data }; }
    }
    res.json({ ok: true, frete: numero, docs: locais, focus });
  } catch (e) { next(e); }
});
