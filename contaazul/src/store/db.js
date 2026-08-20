// Banco SQLite (better-sqlite3). Guarda:
//  - tokens do OAuth (singleton) — refresh_token é rotativo, tem que persistir
//  - ledger dos lançamentos (dedup + reconciliação do 202)
//  - states do OAuth (proteção CSRF do callback)
//
// ⚠️ PRODUÇÃO: o arquivo do banco TEM que ficar num volume persistente.
// Se perder, o refresh_token some e a integração exige novo login manual.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

let db;

export function getDb() {
  if (db) return db;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT,
      refresh_token TEXT,
      access_expires_at INTEGER,   -- epoch ms
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS launches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,               -- 'venda' | 'despesa'
      frete TEXT NOT NULL,              -- número do frete (string p/ aceitar duplicados/ped)
      placa TEXT,                       -- só despesa
      dedup_key TEXT NOT NULL UNIQUE,   -- garante idempotência
      ca_id TEXT,                       -- id do registro no Conta Azul (null até reconciliar)
      ca_numero TEXT,                   -- número da venda, quando houver
      valor REAL,
      status TEXT NOT NULL,             -- 'criado' | 'pendente_reconciliacao' | 'reconciliado' | 'erro'
      payload_json TEXT,                -- o que foi enviado (auditoria)
      erro TEXT,
      created_at INTEGER,
      reconciled_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_launches_frete ON launches (frete);
    CREATE INDEX IF NOT EXISTS idx_launches_status ON launches (status);

    -- Trava de duplicidade da despesa: um par (frete, placa) só pode ser
    -- lançado uma vez. Espelha a regra do spec do sistema OBS.
    CREATE TABLE IF NOT EXISTS despesa_pairs (
      frete TEXT NOT NULL,
      placa TEXT NOT NULL,
      launch_id INTEGER NOT NULL,
      PRIMARY KEY (frete, placa)
    );
  `);
}
