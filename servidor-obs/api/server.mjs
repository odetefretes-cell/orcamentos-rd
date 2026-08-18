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
const d = await import('dotenv');
d.config({ path: '/etc/obs-db/.env', quiet: true });
d.config({ path: '/etc/obs-robo/.env', quiet: true }); // reaproveita a conta de serviço do Firebase (não sobrescreve o que já existe)

const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  max: 10,
});
const COLECOES = new Set(['crm_leads', 'fretes', 'publico', 'clientes', 'crm_config']);
const app = express();
app.use(express.json({ limit: '8mb' }));
app.set('trust proxy', 1);   // atrás do Caddy (HTTPS)

// ---- CORS (só os endereços do nosso app) ------------------------------------
// Quem pode chamar a API pelo navegador. Ajuste em CORS_ORIGENS no .env se mudar.
const ORIGENS = new Set(
  (process.env.CORS_ORIGENS || 'https://sistema.obstransportes.com.br')
    .split(',').map(s => s.trim()).filter(Boolean)
);
app.use((req, res, next) => {
  const o = req.get('origin');
  if (o && ORIGENS.has(o)) {
    res.set('Access-Control-Allow-Origin', o);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-api-token');
    res.set('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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

// ---- Login da EQUIPE (via Firebase) -----------------------------------------
// O app do navegador NÃO pode carregar o token estático (qualquer um leria o
// código-fonte e baixaria a base). Em vez disso, o app faz login com Firebase
// (os mesmos e-mails de sempre) e manda o "ID token" do usuário logado. A API
// confere esse token com a conta de serviço do Firebase e só aceita os 7
// e-mails oficiais da OBS — a mesma lista das regras do Firestore.
const EMAILS_EQUIPE = new Set(
  (process.env.EQUIPE_EMAILS ||
    'atendimento@obstransportes.com.br,yasminfreitas.obs@outlook.com,thiagolucca.obs@outlook.com,flavia.obs@outlook.com,nataly.obs@outlook.com,yasmindesa.obs@outlook.com,financeiro@obstransportes.com.br'
  ).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

let firebaseAuth = null;
try {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '';
  if (b64) {
    const admin = (await import('firebase-admin')).default;
    const cred = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const appFb = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(cred) });
    firebaseAuth = appFb.auth();
    console.log('[api] login da equipe (Firebase) ATIVO —', EMAILS_EQUIPE.size, 'e-mails liberados.');
  } else {
    console.warn('[api] AVISO: sem FIREBASE_SERVICE_ACCOUNT_BASE64 — login da equipe desativado (só token estático).');
  }
} catch (e) {
  console.error('[api] AVISO: não consegui iniciar o Firebase Admin —', e && e.message || e);
}

// Verifica o ID token do Firebase e devolve o e-mail se for da equipe.
async function usuarioDeFirebase(idToken) {
  if (!firebaseAuth || !idToken || idToken.length < 100) return null; // token estático é curto; ID token do Firebase é longo (JWT)
  try {
    const dec = await firebaseAuth.verifyIdToken(idToken);
    const email = String(dec.email || '').toLowerCase();
    if (EMAILS_EQUIPE.has(email)) return email;   // a lista dos 7 e-mails é a fronteira de segurança
    console.warn('[api] login recusado: e-mail fora da lista ->', email);
  } catch (e) {
    console.warn('[api] verifyIdToken falhou:', e && e.message || e);
  }
  return null;
}

async function autenticar(req, res, next) {
  // saúde fica aberta (monitoramento). O prefixo /api some quando montado com
  // app.use('/api', ...), então aceitamos as duas formas do caminho.
  if (req.path === '/health' || req.path === '/api/health') return next();
  const h = req.get('authorization') || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  const recebido = bearer || req.get('x-api-token') || '';
  // 1) token estático (robô/backend, servidor-a-servidor)
  if (tokenValido(recebido)) { req.autor = 'servico'; return next(); }
  // 2) login da equipe (navegador → Firebase ID token)
  const email = await usuarioDeFirebase(recebido);
  if (email) { req.autor = email; return next(); }
  return res.status(401).json({ ok: false, erro: 'não autorizado' });
}
app.use('/api', (req, res, next) => { autenticar(req, res, next).catch(() => res.status(401).json({ ok: false, erro: 'não autorizado' })); });

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

// quem sou eu (confirma o login: 'servico' = token; senão o e-mail da equipe)
app.get('/api/eu', rota(async (req, res) => {
  res.json({ ok: true, autor: req.autor });
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
