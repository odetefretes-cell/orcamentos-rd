// Ledger local: registra o que foi lançado, garante idempotência (não lançar
// duas vezes) e guarda os pendentes de reconciliação do 202.
import { getDb } from './db.js';

// ---------- VENDA ----------

export function acharVenda(frete) {
  return getDb()
    .prepare(`SELECT * FROM launches WHERE tipo='venda' AND frete=?`)
    .get(String(frete)) || null;
}

/**
 * Registra a venda. Idempotente por frete (dedup_key = venda:frete).
 * Se já existe, devolve { duplicado:true, existente }.
 */
export function registrarVenda({ frete, valor, caId, caNumero, status, payload }) {
  const db = getDb();
  const dedup = `venda:${frete}`;
  const existente = db.prepare('SELECT * FROM launches WHERE dedup_key=?').get(dedup);
  if (existente) return { duplicado: true, existente };
  const info = db.prepare(`
    INSERT INTO launches (tipo, frete, placa, dedup_key, ca_id, ca_numero, valor, status, payload_json, created_at)
    VALUES ('venda', @frete, NULL, @dedup, @caId, @caNumero, @valor, @status, @payload, @now)
  `).run({
    frete: String(frete), dedup, caId: caId || null, caNumero: caNumero != null ? String(caNumero) : null,
    valor, status, payload: JSON.stringify(payload || {}), now: Date.now(),
  });
  return { duplicado: false, id: info.lastInsertRowid };
}

// ---------- DESPESA ----------

/**
 * Verifica se algum par (frete, placa) já foi lançado. Retorna os conflitos.
 * @param {Array<{frete:string,placa:string}>} pares
 */
export function conflitosDespesa(pares) {
  const db = getDb();
  const stmt = db.prepare('SELECT frete, placa, launch_id FROM despesa_pairs WHERE frete=? AND placa=?');
  const conflitos = [];
  for (const p of pares) {
    const hit = stmt.get(p.frete, p.placa);
    if (hit) conflitos.push(hit);
  }
  return conflitos;
}

/**
 * Registra a despesa (uma linha em launches + N linhas em despesa_pairs),
 * numa transação. Se houver conflito de par, NÃO grava e devolve os conflitos.
 * @param {object} args { pares, valor, status, payload, caId? }
 */
export function registrarDespesa({ pares, valor, status, payload, caId }) {
  const db = getDb();
  const fretes = [...new Set(pares.map((p) => p.frete))];
  const dedup = 'despesa:' + pares.map((p) => `${p.frete}/${p.placa}`).sort().join('|');

  const tx = db.transaction(() => {
    const conflitos = conflitosDespesa(pares);
    if (conflitos.length) return { duplicado: true, conflitos };

    const jaTemDedup = db.prepare('SELECT id FROM launches WHERE dedup_key=?').get(dedup);
    if (jaTemDedup) return { duplicado: true, conflitos: [], existente: jaTemDedup };

    const info = db.prepare(`
      INSERT INTO launches (tipo, frete, placa, dedup_key, ca_id, ca_numero, valor, status, payload_json, created_at)
      VALUES ('despesa', @frete, NULL, @dedup, @caId, NULL, @valor, @status, @payload, @now)
    `).run({
      frete: fretes.join(','), dedup, caId: caId || null,
      valor, status, payload: JSON.stringify(payload || {}), now: Date.now(),
    });
    const launchId = info.lastInsertRowid;

    const insPair = db.prepare('INSERT INTO despesa_pairs (frete, placa, launch_id) VALUES (?, ?, ?)');
    for (const p of pares) insPair.run(p.frete, p.placa, launchId);

    return { duplicado: false, id: launchId };
  });

  return tx();
}

// ---------- RECONCILIAÇÃO / STATUS ----------

export function despesasPendentes() {
  return getDb()
    .prepare(`SELECT * FROM launches WHERE tipo='despesa' AND status='pendente_reconciliacao'`)
    .all();
}

export function marcarReconciliado(launchId, caId) {
  getDb().prepare(`
    UPDATE launches SET ca_id=@caId, status='reconciliado', reconciled_at=@now WHERE id=@id
  `).run({ id: launchId, caId, now: Date.now() });
}

export function marcarErro(launchId, erro) {
  getDb().prepare('UPDATE launches SET status=?, erro=? WHERE id=?')
    .run('erro', String(erro).slice(0, 500), launchId);
}

// vendas com id no CA que ainda não foram totalmente baixadas no sistema
export function vendasParaSincronizar() {
  return getDb()
    .prepare(`SELECT * FROM launches WHERE tipo='venda' AND ca_id IS NOT NULL AND (status IS NULL OR status NOT IN ('baixado_total'))`)
    .all();
}
export function marcarStatusVenda(launchId, status) {
  getDb().prepare('UPDATE launches SET status=? WHERE id=?').run(status, launchId);
}

export function porFrete(frete) {
  return getDb()
    .prepare(`SELECT id, tipo, frete, ca_id, ca_numero, valor, status, created_at, reconciled_at
              FROM launches WHERE frete = ? OR frete LIKE ? ORDER BY created_at DESC`)
    .all(String(frete), `%${frete}%`);
}

/**
 * Remove do ledger as DESPESAS que envolvem um frete (launches + despesa_pairs),
 * pra liberar um novo lançamento depois de cancelar no Conta Azul.
 * @returns {number} quantas linhas de launches removeu
 */
export function removerDespesaPorFrete(frete) {
  const db = getDb();
  const f = String(frete);
  const tx = db.transaction(() => {
    // launches de despesa que contêm esse frete (frete pode ser "1533" ou "1533,1489")
    const alvos = db.prepare(
      `SELECT id FROM launches WHERE tipo='despesa' AND (frete = ? OR frete LIKE ? OR frete LIKE ? OR frete LIKE ?)`
    ).all(f, `${f},%`, `%,${f}`, `%,${f},%`);
    const ids = alvos.map((a) => a.id);
    // também pega pelos pares (caso o frete não esteja na coluna consolidada)
    const porPar = db.prepare('SELECT DISTINCT launch_id AS id FROM despesa_pairs WHERE frete = ?').all(f);
    for (const p of porPar) if (!ids.includes(p.id)) ids.push(p.id);
    for (const id of ids) {
      db.prepare('DELETE FROM despesa_pairs WHERE launch_id = ?').run(id);
      db.prepare('DELETE FROM launches WHERE id = ?').run(id);
    }
    return ids.length;
  });
  return tx();
}
