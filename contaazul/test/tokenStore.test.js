import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const dbFile = join(tmpdir(), `obs-ca-token-${process.pid}.db`);
process.env.DB_PATH = dbFile;

let store;
before(async () => { store = await import('../src/auth/tokenStore.js'); });
after(() => {
  for (const suf of ['', '-wal', '-shm']) { try { rmSync(dbFile + suf); } catch {} }
});

test('salva tokens e marca validade', () => {
  store.saveTokens({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 });
  assert.equal(store.hasValidAccessToken(), true);
  assert.equal(store.getTokens().refresh_token, 'r1');
});

test('rotação: novo refresh_token substitui o antigo', () => {
  store.saveTokens({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 });
  assert.equal(store.getTokens().refresh_token, 'r2');
});

test('refresh sem novo refresh_token mantém o anterior', () => {
  store.saveTokens({ access_token: 'a3', expires_in: 3600 }); // sem refresh_token
  assert.equal(store.getTokens().refresh_token, 'r2'); // preserva o último
  assert.equal(store.getTokens().access_token, 'a3');
});

test('access token expirado é detectado', () => {
  store.saveTokens({ access_token: 'a4', refresh_token: 'r4', expires_in: -10 });
  assert.equal(store.hasValidAccessToken(), false);
});

test('state é de uso único', () => {
  store.saveState('abc');
  assert.equal(store.consumeState('abc'), true);
  assert.equal(store.consumeState('abc'), false);
});
