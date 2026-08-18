#!/usr/bin/env node
/* ============================================================================
 *  copiar-para-postgres.mjs — Fase 2a. Copia as coleções principais do Firestore
 *  para o PostgreSQL (como JSONB). É SÓ LEITURA do Firestore — não altera o
 *  sistema atual. Idempotente (upsert): pode rodar de novo pra re-sincronizar.
 *
 *  Rodar como root (lê /etc/obs-robo/.env e /etc/obs-db/.env):
 *     cd /opt/obs-robo && node copiar-para-postgres.mjs
 * ========================================================================== */
import admin from 'firebase-admin';
import pg from 'pg';
const d = await import('dotenv');
d.config({ path: '/etc/obs-robo/.env', quiet: true });   // chave do Firebase
d.config({ path: '/etc/obs-db/.env', quiet: true });     // acesso ao PostgreSQL

// ---- Firebase (leitura) ----
const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!b64) { console.error('ERRO: FIREBASE_SERVICE_ACCOUNT_BASE64 não encontrado (/etc/obs-robo/.env).'); process.exit(1); }
const cred = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(cred), projectId: cred.project_id });
const db = admin.firestore();

// ---- PostgreSQL (escrita) ----
const client = new pg.Client({
  host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
});
await client.connect();
console.log(`Conectado ao PostgreSQL "${process.env.PGDATABASE}" como "${process.env.PGUSER}".\n`);

const COLECOES = ['crm_leads', 'fretes', 'publico', 'clientes', 'crm_config'];
for (const col of COLECOES) {
  await client.query(`CREATE TABLE IF NOT EXISTS "${col}" (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())`);
  const snap = await db.collection(col).get();
  let n = 0;
  for (const doc of snap.docs) {
    await client.query(
      `INSERT INTO "${col}" (id, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [doc.id, JSON.stringify(doc.data())]
    );
    n++;
    if (n % 500 === 0) console.log(`  ${col}: ${n}...`);
  }
  console.log(`  ${col}: ${n} documentos copiados`);
}

console.log('\n=== No PostgreSQL agora: ===');
for (const col of COLECOES) {
  const r = await client.query(`SELECT count(*)::int AS c FROM "${col}"`);
  console.log(`  ${col}: ${r.rows[0].c} linhas`);
}
await client.end();
console.log('\nCópia concluída. O Firestore NÃO foi alterado (só leitura). Sistema atual intocado.');
process.exit(0);
