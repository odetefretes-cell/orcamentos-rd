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

  console.log(`\n>>> PRESOS (sem lead no CRM): ${presos.length}. Últimos 15:\n`);
  for (const r of presos.slice(0, 15)) {
    const e = r.data?.extraido || {};
    console.log(
      `  ${String(r.id).padEnd(15)} status=${g(r.data,'statusIntake').padEnd(16)} perguntas=${g(r.data,'perguntasFeitas')||0}` +
      ` ia=${r.data?.iaProcessado?'sim':'nao'} msgs=${Array.isArray(r.data?.mensagens)?r.data.mensagens.length:0}` +
      ` | ${g(e,'nome')||g(r.data,'nome')} | ${g(e,'origem')} → ${g(e,'destino')} | ${g(e,'veiculo')}` +
      ` | ${String(r.updated_at).slice(0,16)}`
    );
  }
  await pool.end();
}
main().catch((e) => { console.error('ERRO:', e); process.exit(1); });
