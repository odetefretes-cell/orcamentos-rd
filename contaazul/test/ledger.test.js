import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const dbFile = join(tmpdir(), `obs-ca-test-${process.pid}.db`);
process.env.DB_PATH = dbFile;

let ledger;
before(async () => {
  ledger = await import('../src/store/ledger.js');
});
after(() => {
  for (const suf of ['', '-wal', '-shm']) {
    try { rmSync(dbFile + suf); } catch {}
  }
});

test('venda é idempotente por frete', () => {
  const r1 = ledger.registrarVenda({ frete: 1523, valor: 1200, caId: 'v1', caNumero: 1523, status: 'criado' });
  assert.equal(r1.duplicado, false);
  const r2 = ledger.registrarVenda({ frete: 1523, valor: 1200, caId: 'v1', caNumero: 1523, status: 'criado' });
  assert.equal(r2.duplicado, true);
  assert.equal(ledger.acharVenda(1523).ca_id, 'v1');
});

test('despesa consolidada grava e bloqueia re-lançamento do par', () => {
  const pares = [{ frete: '1333', placa: 'EHY8E86' }, { frete: '1489', placa: 'SNY5E24' }];
  const r = ledger.registrarDespesa({ pares, valor: 750, status: 'pendente_reconciliacao' });
  assert.equal(r.duplicado, false);

  // Re-lançar exatamente os mesmos pares deve acusar conflito
  const conflitos = ledger.conflitosDespesa(pares);
  assert.equal(conflitos.length, 2);

  // Uma cobrança nova que inclui um par já pago também é barrada
  const r2 = ledger.registrarDespesa({
    pares: [{ frete: '1333', placa: 'EHY8E86' }], valor: 300, status: 'pendente_reconciliacao',
  });
  assert.equal(r2.duplicado, true);
  assert.equal(r2.conflitos.length, 1);
});

test('reconciliação preenche o ca_id da despesa', () => {
  const pares = [{ frete: '1641', placa: 'TRK6F35' }];
  const r = ledger.registrarDespesa({ pares, valor: 1150, status: 'pendente_reconciliacao' });
  const pend = ledger.despesasPendentes().find((p) => p.id === r.id);
  assert.ok(pend);
  ledger.marcarReconciliado(r.id, 'cap-999');
  assert.equal(ledger.despesasPendentes().find((p) => p.id === r.id), undefined);
});
