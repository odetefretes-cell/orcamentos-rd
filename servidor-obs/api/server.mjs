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
  // acompanhamento do CLIENTE: leitura pública de UM doc de "publico/" (igual às
  // regras do Firestore — publico é read:if true). Só GET de um id específico.
  if (req.method === 'GET' && /^(\/api)?\/publico\/[^/]+$/.test(req.path)) { req.autor = 'publico'; return next(); }
  const h = req.get('authorization') || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  const recebido = bearer || req.get('x-api-token') || '';
  // 1) token estático (robô/backend, servidor-a-servidor)
  if (tokenValido(recebido)) { req.autor = 'servico'; return next(); }
  // 2) login da equipe (navegador → Firebase ID token)
  const email = await usuarioDeFirebase(recebido);
  if (email) { req.autor = email; return next(); }
  // 3) FORMULÁRIO DE PEDIDO do cliente (sem login): GET/PUT de UM frete. A ROTA
  //    só libera se o frete for um PEDIDO PENDENTE (pedido!=true e cadastrado!=true)
  //    — igual às regras do Firestore. Frete cadastrado (com CPF/endereço) fica bloqueado.
  if ((req.method === 'GET' || req.method === 'PUT') && /^(\/api)?\/fretes\/[^/]+$/.test(req.path)) { req.autor = 'publico'; return next(); }
  return res.status(401).json({ ok: false, erro: 'não autorizado' });
}
app.use('/api', (req, res, next) => { autenticar(req, res, next).catch(() => res.status(401).json({ ok: false, erro: 'não autorizado' })); });

// pequeno "embrulho" pra tratar erro sem derrubar o servidor
const rota = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error('[api] erro:', e && e.message || e);
  res.status(500).json({ ok: false, erro: String(e && e.message || e) });
});
const validaCol = (req, res) => { if (!COLECOES.has(req.params.col)) { res.status(404).json({ erro: 'coleção desconhecida' }); return false; } return true; };
// PEDIDO PENDENTE (frete que o cliente ainda vai preencher): pedido!=true e cadastrado!=true.
const ehPendente = (d) => !!d && d.pedido !== true && d.cadastrado !== true;

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
  const r = await pool.query(`SELECT id, data FROM "${req.params.col}" ORDER BY id`);
  // a CHAVE da linha sempre vence (um "id" dentro do JSONB não pode sobrescrever)
  res.json(r.rows.map(x => ({ ...x.data, id: x.id })));
}));

// ler um documento
app.get('/api/:col/:id', rota(async (req, res) => {
  if (!validaCol(req, res)) return;
  const r = await pool.query(`SELECT id, data FROM "${req.params.col}" WHERE id = $1`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ erro: 'não encontrado' });
  const data = r.rows[0].data || {};
  // cliente sem login só enxerga PEDIDO PENDENTE em fretes (nunca frete cadastrado, com CPF/endereço)
  if (req.autor === 'publico' && req.params.col === 'fretes' && !ehPendente(data)) {
    return res.status(404).json({ erro: 'não encontrado' });
  }
  res.json({ ...data, id: r.rows[0].id });
}));

// gravar/atualizar um documento (upsert).
//  ?merge=1  → mescla os campos no topo (jsonb ||), preservando o que já existe
//              (mesmo efeito do setDoc {merge:true} do Firestore). ATÔMICO.
//  sem merge → substitui o documento inteiro.
app.put('/api/:col/:id', rota(async (req, res) => {
  if (!validaCol(req, res)) return;
  // cliente sem login: só pode gravar o FORMULÁRIO de um PEDIDO PENDENTE de fretes
  if (req.autor === 'publico') {
    if (req.params.col !== 'fretes') return res.status(403).json({ ok: false, erro: 'não autorizado' });
    const atual = await pool.query(`SELECT data FROM fretes WHERE id = $1`, [req.params.id]);
    const dAtual = atual.rows.length ? (atual.rows[0].data || {}) : null;
    if (!ehPendente(dAtual)) return res.status(403).json({ ok: false, erro: 'não autorizado' });
  }
  const merge = req.query.merge === '1' || req.query.merge === 'true';
  if (merge) {
    await pool.query(
      `INSERT INTO "${req.params.col}" (id, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = "${req.params.col}".data || EXCLUDED.data, updated_at = now()`,
      [req.params.id, JSON.stringify(req.body || {})]
    );
  } else {
    await pool.query(
      `INSERT INTO "${req.params.col}" (id, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [req.params.id, JSON.stringify(req.body || {})]
    );
  }
  res.json({ ok: true, id: req.params.id });
}));

// RODÍZIO de vendedor — contador ATÔMICO em crm_config/rodizio (evita dois leads
// pegarem o mesmo vendedor). Body: { vendedores: ["Yasmim...","Thiago...","Flavia..."] }.
// Retorna { ok, vendedor, contador }. Uma transação: lê, escolhe, incrementa.
app.post('/api/rodizio/next', rota(async (req, res) => {
  const vend = Array.isArray(req.body && req.body.vendedores) ? req.body.vendedores.filter(Boolean) : [];
  if (!vend.length) return res.status(400).json({ ok: false, erro: 'lista de vendedores vazia' });
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const r = await cli.query(`SELECT data FROM crm_config WHERE id='rodizio' FOR UPDATE`);
    const atual = r.rows.length ? (r.rows[0].data || {}) : {};
    const n = Number(atual.contador) || 0;
    const escolhido = vend[n % vend.length];
    const novo = { ...atual, contador: n + 1, ultimo: escolhido, atualizadoEm: new Date().toISOString() };
    await cli.query(
      `INSERT INTO crm_config (id, data, updated_at) VALUES ('rodizio', $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = $1::jsonb, updated_at = now()`,
      [JSON.stringify(novo)]
    );
    await cli.query('COMMIT');
    res.json({ ok: true, vendedor: escolhido, contador: n + 1 });
  } catch (e) {
    await cli.query('ROLLBACK'); throw e;
  } finally {
    cli.release();
  }
}));

// TRAVA ATÔMICA de envio — marca um campo booleano (ex.: respostaEnviada,
// avisoHumanoEnviado) SÓ se ainda estiver desligado. Garante que só UMA execução
// do verificador envia a mensagem ao cliente (evita duplicar no WhatsApp).
//   POST /api/:col/:id/claim?campo=respostaEnviada   body: { respostaEnviadaEm: "..." }
//   → { ok, claimed: true }  (você ganhou → pode enviar)  | { claimed: false } (outro já pegou)
app.post('/api/:col/:id/claim', rota(async (req, res) => {
  if (!validaCol(req, res)) return;
  const campo = String(req.query.campo || '');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(campo)) return res.status(400).json({ ok: false, erro: 'campo inválido' });
  const extra = (req.body && typeof req.body === 'object') ? req.body : {};
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const r = await cli.query(`SELECT data FROM "${req.params.col}" WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!r.rows.length) { await cli.query('ROLLBACK'); return res.status(404).json({ ok: false, erro: 'não encontrado' }); }
    const cur = r.rows[0].data || {};
    if (cur[campo]) { await cli.query('COMMIT'); return res.json({ ok: true, claimed: false }); }
    const novo = { ...cur, [campo]: true, ...extra };
    await cli.query(`UPDATE "${req.params.col}" SET data = $1::jsonb, updated_at = now() WHERE id = $2`, [JSON.stringify(novo), req.params.id]);
    await cli.query('COMMIT');
    res.json({ ok: true, claimed: true });
  } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
}));

// apagar um documento
app.delete('/api/:col/:id', rota(async (req, res) => {
  if (!validaCol(req, res)) return;
  await pool.query(`DELETE FROM "${req.params.col}" WHERE id = $1`, [req.params.id]);
  res.json({ ok: true, id: req.params.id });
}));

const PORT = Number(process.env.API_PORT || 3000);
app.listen(PORT, '127.0.0.1', () => console.log(`API OBS ouvindo em http://127.0.0.1:${PORT} (banco: ${process.env.PGDATABASE})`));
