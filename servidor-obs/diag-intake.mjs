/* Diagnóstico (SÓ LEITURA) do funil de entrada de leads (crm_leads_intake).
 * Mostra: contagem por statusIntake, e os leads presos (sem leadCriado).
 * Rodar de /opt/obs-api:  node diag-intake.mjs
 */
import pg from 'pg';
const d = await import('dotenv');
d.config({ path: '/etc/obs-db/.env', quiet: true });

const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD, max: 5,
});

const g = (o, k) => (o && o[k] != null ? o[k] : '');

async function main() {
  const { rows: all } = await pool.query('SELECT id, data, updated_at FROM crm_leads_intake');
  console.log(`\ncrm_leads_intake: ${all.length} registros no total.\n`);

  const porStatus = {}, semLead = {};
  for (const r of all) {
    const s = g(r.data, 'statusIntake') || '(vazio)';
    porStatus[s] = (porStatus[s] || 0) + 1;
    const criou = r.data && (r.data.leadCriado === true || r.data.leadCriado === 'true');
    if (!criou) semLead[s] = (semLead[s] || 0) + 1;
  }
  console.log('POR statusIntake (todos):', JSON.stringify(porStatus, null, 0));
  console.log('SEM lead criado, por status:', JSON.stringify(semLead, null, 0));

  // presos: sem leadCriado e não em atendimento humano — deveriam estar no CRM
  const presos = all.filter((r) => {
    const criou = r.data && (r.data.leadCriado === true || r.data.leadCriado === 'true');
    const s = g(r.data, 'statusIntake');
    return !criou && s !== 'em_atendimento_humano';
  }).sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));

  console.log(`\n>>> PRESOS (sem lead no CRM): ${presos.length}. Detalhe:\n`);
  for (const r of presos.slice(0, 15)) {
    const e = r.data?.extraido || {};
    console.log(`  ${String(r.id).padEnd(15)} status=${g(r.data,'statusIntake')} perguntas=${g(r.data,'perguntasFeitas')||0} ia=${r.data?.iaProcessado?'sim':'nao'} respostaEnviada=${g(r.data,'respostaEnviada')} decisao=${g(e,'decisao')} faltaInfo=${g(e,'faltaInfo')} | ${g(e,'nome')||g(r.data,'nome')} | ${g(e,'origem')}→${g(e,'destino')} | ${g(e,'veiculo')} | ${String(r.updated_at).slice(0,16)}`);
  }

  // Caixa-preta: o webhook está RECEBENDO POSTs? Quando foi o último?
  try {
    const { rows: wl } = await pool.query('SELECT id, data, updated_at FROM chatguru_webhook_log ORDER BY updated_at DESC LIMIT 8');
    const { rows: wc } = await pool.query('SELECT count(*)::int c, max(updated_at) ult FROM chatguru_webhook_log');
    console.log(`\n>>> WEBHOOK LOG (POSTs recebidos): total=${wc[0].c}, último=${String(wc[0].ult).slice(0,16)}`);
    for (const r of wl) {
      const b = r.data || {};
      const tel = b.celular || b.telefone || b.phone || b.numero || (b.chat && b.chat.celular) || '';
      const nome = b.nome || b.name || (b.chat && b.chat.nome) || '';
      console.log(`  ${String(r.updated_at).slice(0,16)} tel=${tel} nome=${nome} chaves=[${Object.keys(b).slice(0,12).join(',')}]`);
    }
  } catch (e) { console.log('webhook_log erro:', e.message); }

  // Lookup de telefones passados como argumento (checa intake + crm_leads por últimos 8 díg)
  const alvos = process.argv.slice(2).map((s) => s.replace(/\D/g, '')).filter(Boolean);
  if (alvos.length) {
    console.log('\n>>> BUSCA de telefones específicos:');
    for (const tel of alvos) {
      const ult8 = tel.slice(-8);
      const { rows: ri } = await pool.query('SELECT id, data FROM crm_leads_intake WHERE id LIKE $1', ['%' + ult8]);
      const { rows: rc } = await pool.query("SELECT id, data->>'nome' nome, data->>'status' status FROM crm_leads WHERE id LIKE $1", ['%' + ult8]);
      console.log(`  ${tel} (…${ult8}): intake=${ri.length ? ri.map((x)=>x.id+'['+g(x.data,'statusIntake')+' leadCriado='+g(x.data,'leadCriado')+']').join(',') : 'NENHUM'} | crm_leads=${rc.length ? rc.map((x)=>x.id+'('+x.status+')').join(',') : 'NENHUM'}`);
    }
  }
  await pool.end();
}
main().catch((e) => { console.error('ERRO:', e); process.exit(1); });
