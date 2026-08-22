#!/usr/bin/env node
/* ============================================================================
 *  recuperar-leads-firebase.mjs — Recupera do Firebase os leads do FORMULÁRIO
 *  que caíram lá (o form do site ainda grava no Firebase) e NÃO existem no
 *  Postgres. INSERE só os que faltam — NUNCA sobrescreve o que já está no
 *  Postgres (usa ON CONFLICT DO NOTHING + dedup por últimos 8 dígitos).
 *
 *  Rodar de /opt/obs-robo (tem firebase-admin + a chave do Firebase):
 *     node recuperar-leads-firebase.mjs            # DRY-RUN (só mostra)
 *     node recuperar-leads-firebase.mjs --aplicar  # insere os que faltam
 * ========================================================================== */
import admin from 'firebase-admin';
import pg from 'pg';
const d = await import('dotenv');
d.config({ path: '/etc/obs-robo/.env', quiet: true });
d.config({ path: '/etc/obs-db/.env', quiet: true });

const APLICAR = process.argv.includes('--aplicar');

const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!b64) { console.error('ERRO: FIREBASE_SERVICE_ACCOUNT_BASE64 ausente (/etc/obs-robo/.env).'); process.exit(1); }
const cred = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(cred), projectId: cred.project_id });
const fs = admin.firestore();

const cli = new pg.Client({
  host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
});
await cli.connect();

const ult8 = (s) => String(s || '').replace(/\D/g, '').slice(-8);
const telDe = (o) => o?.telefone || o?.tel || o?.whatsapp || o?.celular || '';

async function main() {
  // 1) chaves que JÁ existem no Postgres (por id e por últimos 8 díg do telefone/id)
  const { rows: pgRows } = await cli.query('SELECT id, data FROM crm_leads');
  const existentes = new Set();
  for (const r of pgRows) {
    existentes.add(r.id);
    const k1 = ult8(r.id); if (k1.length === 8) existentes.add('t' + k1);
    const k2 = ult8(telDe(r.data)); if (k2.length === 8) existentes.add('t' + k2);
  }
  console.log(`Postgres crm_leads: ${pgRows.length} leads.`);

  // 2) Firebase crm_leads → separa os que faltam
  const snap = await fs.collection('crm_leads').get();
  console.log(`Firebase crm_leads: ${snap.size} leads.\n`);

  const faltam = [];
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const k = ult8(telDe(data)) || ult8(doc.id);
    const jaTem = existentes.has(doc.id) || (k.length === 8 && existentes.has('t' + k));
    if (!jaTem) faltam.push({ id: doc.id, data });
  }

  // Listagem por data (DESDE=YYYY-MM-DD): mostra o que o Firebase tem desde tal dia
  // e se cada um já está no Postgres. Responde "dá pra recuperar desde o dia X?".
  const DESDE = process.env.DESDE;
  if (DESDE) {
    const dataDe = (o) => String(o.dataEntrada || o.criadoEm || o.data || o.dataFechamento || '').slice(0, 10);
    const desde = snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }))
      .map((x) => ({ ...x, dt: dataDe(x.data) }))
      .filter((x) => x.dt && x.dt >= DESDE)
      .sort((a, b) => (a.dt < b.dt ? 1 : -1));
    console.log(`>>> Firebase crm_leads desde ${DESDE}: ${desde.length}. (jaNoPG = já está no Postgres)\n`);
    for (const x of desde.slice(0, 40)) {
      const k = ult8(telDe(x.data)) || ult8(x.id);
      const jaTem = existentes.has(x.id) || (k.length === 8 && existentes.has('t' + k));
      console.log(`  ${x.dt} ${jaTem ? '[jaNoPG]  ' : '[FALTA!]  '} ${String(x.id).padEnd(26)} | ${x.data.nome || x.data.clienteEmpresa || ''} | ${telDe(x.data)} | ${x.data.origem || ''}→${x.data.destino || ''}`);
    }
    await cli.end();
    return;
  }

  console.log(`>>> Leads no Firebase que FALTAM no Postgres: ${faltam.length}\n`);
  const amostra = faltam.slice(0, 20);
  for (const f of amostra) {
    const e = f.data;
    console.log(`  ${String(f.id).padEnd(28)} | ${e.nome || e.clienteEmpresa || ''} | ${telDe(e)} | ${e.origem || ''}→${e.destino || ''} | ${e.veiculo || e.veiculoDesc || ''} | ${e.dataEntrada || e.criadoEm || e.data || ''}`);
  }
  if (faltam.length > 20) console.log(`  … e mais ${faltam.length - 20}.`);

  if (!APLICAR) { console.log('\n(DRY-RUN — nada gravado. Rode com --aplicar para inserir os que faltam.)'); await cli.end(); return; }

  let ok = 0;
  for (const f of faltam) {
    const r = await cli.query(
      `INSERT INTO crm_leads (id, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (id) DO NOTHING`,
      [f.id, JSON.stringify(f.data)]
    );
    ok += r.rowCount;
  }
  console.log(`\n✔ Inseridos ${ok} leads que faltavam (os já existentes foram preservados).`);
  await cli.end();
}
main().catch((e) => { console.error('ERRO:', e); process.exit(1); });
