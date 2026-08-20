// Teste ponta a ponta: sobe o app real contra o mock do Conta Azul e exercita
// /obs/venda, a trava de duplicidade e /obs/despesa + reconciliação.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { startMockCA } from './mock-contaazul.js';

const dbFile = join(tmpdir(), `obs-ca-e2e-${process.pid}.db`);
const SECRET = 's3cr3t-obs';

let mock, appServer, baseUrl, reconciliar;

before(async () => {
  mock = await startMockCA(0);

  process.env.DB_PATH = dbFile;
  process.env.OBS_SHARED_SECRET = SECRET;
  process.env.CA_CLIENT_ID = 'cid';
  process.env.CA_CLIENT_SECRET = 'csecret';
  process.env.CA_REDIRECT_URI = 'http://localhost/oauth/callback';
  process.env.CA_API_BASE = mock.url;
  process.env.CA_TOKEN_URL = mock.url + '/oauth/token';
  process.env.SERVICE_CEGONHA_ID = 'svc-cegonha';
  process.env.SERVICE_GUINCHO_ID = 'svc-guincho';

  const { saveTokens } = await import('../src/auth/tokenStore.js');
  saveTokens({ access_token: 'seed', refresh_token: 'seed-r', expires_in: 3600 });

  const { createApp } = await import('../src/server.js');
  ({ reconciliarUmaVez: reconciliar } = await import('../src/jobs/reconcile.js'));

  const app = createApp();
  await new Promise((r) => { appServer = app.listen(0, r); });
  baseUrl = `http://localhost:${appServer.address().port}`;
});

after(async () => {
  await new Promise((r) => appServer.close(r));
  await mock.close();
  for (const suf of ['', '-wal', '-shm']) { try { rmSync(dbFile + suf); } catch {} }
});

function post(path, body, secret = SECRET) {
  return fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-OBS-Secret': secret },
    body: JSON.stringify(body),
  });
}

test('bloqueia sem o segredo', async () => {
  const r = await post('/obs/venda', {}, 'errado');
  assert.equal(r.status, 401);
});

test('cria a venda e é idempotente', async () => {
  const venda = {
    frete: 1523, modal: 'cegonha', valor: 1200, formaPagamento: 'PIX_50_50',
    cliente: { nome: 'Cliente Teste', documento: '12345678000199' },
    origem: 'SP', destino: 'BA', veiculo: 'Fox', placa: 'JWD8986',
  };
  const r1 = await post('/obs/venda', venda);
  assert.equal(r1.status, 201);
  const j1 = await r1.json();
  assert.equal(j1.ok, true);
  assert.equal(j1.duplicado, false);
  assert.ok(j1.ca.id);

  const r2 = await post('/obs/venda', venda);
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).duplicado, true);
});

test('lança despesa (202), reconcilia e barra duplicidade', async () => {
  const despesa = {
    prestador: { nome: 'Sonia Maria', documento: '10818549000141' },
    valor: 750, modal: 'cegonha', pixKey: '+5588996959745',
    itens: [{ frete: 1333, placa: 'EHY8E86' }, { frete: 1489, placa: 'SNY5E24' }],
  };
  const r = await post('/obs/despesa', despesa);
  assert.equal(r.status, 202);
  assert.equal((await r.json()).status, 'pendente_reconciliacao');

  const rc = await reconciliar();
  assert.equal(rc.reconciliadas, 1);

  // status mostra reconciliado
  const st = await fetch(`${baseUrl}/obs/status?frete=1333`, { headers: { 'X-OBS-Secret': SECRET } });
  const stj = await st.json();
  assert.equal(stj.lancamentos[0].status, 'reconciliado');
  assert.ok(stj.lancamentos[0].ca_id);

  // re-cobrança do mesmo par é barrada (409)
  const dup = await post('/obs/despesa', {
    prestador: { nome: 'Sonia Maria' }, valor: 300,
    itens: [{ frete: 1333, placa: 'EHY8E86' }],
  });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).duplicado, true);
});
