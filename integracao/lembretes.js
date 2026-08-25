/* ============================================================================
   OBS Transportes — LEMBRETES DO OPERACIONAL

   O operador marca no card do frete (Marcos do transporte) um "🔔 Lembrete para
   dia". Quando esse dia chega, este job:
     1) pega a ÚLTIMA ATUALIZAÇÃO INTERNA registrada no frete;
     2) lança essa atualização como ANOTAÇÃO no chat do cliente (note_add) —
        NÃO é mensagem ao cliente, só fica visível pro atendente;
     3) executa um DIÁLOGO do ChatGuru que coloca o contato em AGUARDANDO e
        marca como NÃO LIDO (a API não faz isso direto; quem faz é o diálogo —
        mesmo padrão do diálogo "Falar com Atendente").
     4) marca `lembreteEnviadoEm` no frete pra não repetir.

   Config (env): CHATGURU_DIALOG_LEMBRETE = id do diálogo "Lembrete OBS".
   Sem ele, o job só faz a anotação (e avisa no log).
   ========================================================================== */
const { getFirestore } = require('firebase-admin/firestore');   // no VPS → pg-compat
const { adicionarAnotacao, executarDialogo } = require('./chatguru-api');

const TZ = 'America/Sao_Paulo';
const HORA_MINIMA = Number(process.env.LEMBRETE_HORA_MINIMA || 8);   // não avisa de madrugada

function hojeBR() {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date());   // YYYY-MM-DD
}
function horaBR() {
  return Number(new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date()));
}
function ultimaAtualizacaoInterna(f) {
  const h = Array.isArray(f.histInterno) ? f.histInterno : [];
  if (h.length) {
    const u = h[h.length - 1];
    return String((u && u.texto) || '').trim();
  }
  return String(f.atualizacao || '').trim();
}

async function processarLembretes() {
  const hoje = hojeBR();
  if (horaBR() < HORA_MINIMA) return { pulado: 'fora do horário' };

  const db = getFirestore();
  const snap = await db.collection('fretes').get();
  const alvos = [];
  snap.forEach((d) => {
    const f = d.data() || {};
    const dia = String(f.lembreteEm || '').slice(0, 10);
    if (!dia || dia > hoje) return;                       // sem lembrete ou ainda no futuro
    if (String(f.lembreteEnviadoEm || '').trim()) return; // já avisado
    if (String(f.status || '').toUpperCase() === 'CANCELADO') return;
    alvos.push({ id: d.id, f });
  });
  if (!alvos.length) return { avisados: 0 };

  const dialogId = process.env.CHATGURU_DIALOG_LEMBRETE || '';
  // telefone do CHAT: prioriza o do LEAD de origem (veio do ChatGuru = número real
  // da conversa); a ficha pode ter outro número digitado.
  const telDoChat = async (f) => {
    try {
      if (f.leadId) {
        const l = await db.collection('crm_leads').doc(String(f.leadId)).get();
        const t = String((l.exists && l.data() && l.data().telefone) || '').trim();
        if (t.replace(/\D/g, '').length >= 10) return t;
      }
    } catch (_) {}
    return String(f.telefone || '').trim();
  };
  let avisados = 0;
  for (const { id, f } of alvos) {
    const tel = await telDoChat(f);
    if (!tel) { console.warn(`[lembretes] frete ${f.numero || id}: sem telefone — pulado.`); continue; }
    const ultima = ultimaAtualizacaoInterna(f);
    const texto = [
      `🔔 LEMBRETE (frete ${f.numero || ''}) — retomar com o cliente`,
      `${String(f.origem || '').toUpperCase()} → ${String(f.destino || '').toUpperCase()}`,
      ultima ? `Última atualização interna: ${ultima}` : 'Sem atualização interna registrada.',
    ].join('\n');

    try {
      await adicionarAnotacao({ chatNumber: tel, texto });
      if (dialogId) {
        try { await executarDialogo({ chatNumber: tel, dialogId }); }
        catch (e) { console.warn(`[lembretes] frete ${f.numero}: anotação ok, diálogo falhou: ${e.message}`); }
      } else {
        console.warn('[lembretes] CHATGURU_DIALOG_LEMBRETE não configurado — só anotação (sem AGUARDANDO/não lido).');
      }
      await db.collection('fretes').doc(id).set({ lembreteEnviadoEm: hoje }, { merge: true });
      avisados++;
      console.log(`[lembretes] frete ${f.numero || id}: anotação lançada no ChatGuru (${tel}).`);
    } catch (e) {
      console.error(`[lembretes] frete ${f.numero || id}: falhou — ${e.message}`);
    }
  }
  return { avisados, candidatos: alvos.length };
}

module.exports = { processarLembretes, ultimaAtualizacaoInterna, hojeBR };
