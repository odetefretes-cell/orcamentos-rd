#!/usr/bin/env node
/* ============================================================================
 *  VOLTA PRO FIREBASE — copia os dados de HOJE (PostgreSQL) de volta pro
 *  Firestore, para reverter o app pro Firebase SEM perder o que a equipe fez
 *  hoje. Roda NA VPS (tem o PostgreSQL local + o service account do Firebase).
 *
 *  Uso:
 *    node pg-para-firebase.mjs --dry     (só CONTA, não grava — pra conferir)
 *    node pg-para-firebase.mjs           (grava de verdade no Firestore)
 *
 *  Direção: PostgreSQL -> Firestore (merge). Desde a virada, o app só gravou no
 *  PostgreSQL; o Firestore ficou parado. Então o PostgreSQL tem o estado mais
 *  novo de tudo — copiar de volta com merge traz o Firestore ao dia sem apagar
 *  nada. NÃO copia a tabela de fretes (`_tabela*`, vários MB, idêntica lá).
 * ========================================================================== */
import pg from 'pg';
import admin from 'firebase-admin';
const dotenv = await import('dotenv');
dotenv.config({ path: '/etc/obs-db/.env', quiet: true });
dotenv.config({ path: '/etc/obs-robo/.env', quiet: true });

const DRY = process.argv.includes('--dry');
const COLS = ['crm_leads', 'fretes', 'clientes', 'publico', 'crm_config'];

const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '';
if (!b64) { console.error('ERRO: falta FIREBASE_SERVICE_ACCOUNT_BASE64 no ambiente (service account do Firebase).'); process.exit(1); }
let cred;
try { cred = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); }
catch (e) { console.error('ERRO: service account inválido:', e.message); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(cred) });
const fsdb = admin.firestore();
console.log('Firebase project:', cred.project_id, DRY ? '(MODO DRY — não grava)' : '(GRAVAÇÃO REAL)');

const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD, max: 5,
});

let totalGrav = 0;
for (const col of COLS) {
  let rows;
  try { rows = (await pool.query(`SELECT id, data FROM "${col}"`)).rows; }
  catch (e) { console.log(`[${col}] pulado (${e.message})`); continue; }
  // fora a tabela gigante de fretes (vários MB, já está no Firestore igual)
  const docs = rows.filter(r => !String(r.id).startsWith('_tabela'));
  console.log(`[${col}] ${docs.length} documentos ${DRY ? '(DRY — não grava)' : ''}`);
  if (DRY) continue;
  let n = 0;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = fsdb.batch();
    for (const r of docs.slice(i, i + 400)) {
      const data = (r.data && typeof r.data === 'object') ? r.data : {};
      data.id = String(r.id);   // garante o campo id igual à chave do documento
      batch.set(fsdb.collection(col).doc(String(r.id)), data, { merge: true });
    }
    await batch.commit();
    n += Math.min(400, docs.length - i);
    process.stdout.write(`  ${col}: ${n}/${docs.length}\r`);
  }
  console.log(`\n[${col}] OK — ${n} gravados no Firestore`);
  totalGrav += n;
}
await pool.end();
console.log(`\nCONCLUIDO — ${totalGrav} documentos copiados PostgreSQL -> Firestore.`);
process.exit(0);
