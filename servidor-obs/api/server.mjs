#!/usr/bin/env node
/* ============================================================================
 *  API (ponte) da OBS — versão mínima. Fala com o PostgreSQL e entrega/grava
 *  os dados por HTTP. Escuta SÓ em 127.0.0.1 (local) por enquanto — nada
 *  exposto na internet até termos autenticação + proxy HTTPS.
 *
 *  Config do banco: /etc/obs-db/.env (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD)
 *  Rodar:  cd /opt/obs-api && node server.mjs   (ou via PM2)
 * ========================================================================== */
import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
const d = await import('dotenv'); d.config({ path: '/etc/obs-db/.env', quiet: true });

const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  max: 10,
});
const COLECOES = new Set(['crm_leads', 'fretes', 'publico', 'clientes', 'crm_config']);
const app = express();
app.use(express.json({ limit: '8mb' }));

// ---- Autenticação por token -------------------------------------------------
// Toda rota /api (menos /api/health) exige o token no cabeçalho:
//   Authorization: Bearer <TOKEN>      (ou)   x-api-token: <TOKEN>
// O token fica em /etc/obs-db/.env como API_TOKEN. Sem API_TOKEN definido, a
// API se recusa a subir (evita expor os dados sem querer).
const API_TOKEN = String(process.env.API_TOKEN || '');
if (!API_TOKEN || API_TOKEN.length < 16) {
  console.error('[api] ERRO: API_TOKEN ausente ou curto demais em /etc/obs-db/.env (mín. 16 caracteres). Abortando.');
  process.exit(1);
}
const tokenBuf = Buffer.from(API_TOKEN);
function tokenValido(recebido) {
  const b = Buffer.from(String(recebido || ''));
  return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
}
function autenticar(req, res, next) {
  if (req.path === '/api/health') return next();          // saúde fica aberta (monitoramento)
  const h = req.get('authorization') || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  const recebido = bearer || req.get('x-api-token') || '';
  if (!tokenValido(recebido)) return res.status(401).json({ ok: false, erro: 'não autorizado' });
  next();
}
app.use('/api', autenticar);

// pequeno "embrulho" pra tratar erro sem derrubar o servidor
const rota = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error('[api] erro:', e && e.message || e);
  res.status(500).json({ ok: false, erro: String(e && e.message || e) });
});
const validaCol = (req, res) => { if (!COLECOES.has(req.params.col)) { res.status(404).json({ erro: 'coleção desconhecida' }); return false; } return true; };

// saúde
app.get('/api/health', rota(async (req, res) => {
  const r = await pool.query('SELECT count(*)::int AS c FROM crm_leads');
  res.json({ ok: true, banco: process.env.PGDATABASE, crm_leads: r.rows[0].c });
}));

// listar uma coleção
app.get('/api/:col', rota(async (req, res) => {
  if (!validaCol(req, res)) return;
  const r = await pool.query(`SELECT id, data FROM "${req.params.col}"`);
  res.json(r.rows.map(x => ({ id: x.id, ...x.data })));
}));

// ler um documento
app.get('/api/:col/:id', rota(async (req, res) => {
  if (!validaCol(req, res)) return;
  const r = await pool.query(`SELECT id, data FROM "${req.params.col}" WHERE id = $1`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ erro: 'não encontrado' });
  res.json({ id: r.rows[0].id, ...r.rows[0].data });
}));

// gravar/atualizar um documento (upsert)
app.put('/api/:col/:id', rota(async (req, res) => {
  if (!validaCol(req, res)) return;
  await pool.query(
    `INSERT INTO "${req.params.col}" (id, data, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [req.params.id, JSON.stringify(req.body || {})]
  );
  res.json({ ok: true, id: req.params.id });
}));

// apagar um documento
app.delete('/api/:col/:id', rota(async (req, res) => {
  if (!validaCol(req, res)) return;
  await pool.query(`DELETE FROM "${req.params.col}" WHERE id = $1`, [req.params.id]);
  res.json({ ok: true, id: req.params.id });
}));

const PORT = Number(process.env.API_PORT || 3000);
app.listen(PORT, '127.0.0.1', () => console.log(`API OBS ouvindo em http://127.0.0.1:${PORT} (banco: ${process.env.PGDATABASE})`));
