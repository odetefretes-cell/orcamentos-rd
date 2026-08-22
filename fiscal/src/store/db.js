// Postgres: lê os fretes do CRM (coleção `fretes`) e guarda os documentos fiscais
// em `fiscal_docs`. Mesmo banco `obs` do resto do sistema.
import pg from 'pg';
import { config } from '../config.js';

let pool = null;

export function getPool() {
  if (!pool) pool = new pg.Pool({ ...config.pg, max: 10 });
  return pool;
}

/** Cria a tabela fiscal_docs se não existir (idempotente). */
export async function garantirSchema() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS fiscal_docs (
      id            text PRIMARY KEY,          -- ref interna (ex.: cte_1697)
      frete_id      text NOT NULL,             -- id do doc na coleção fretes
      frete_numero  text NOT NULL,
      tipo          text NOT NULL,             -- cte | mdfe
      status        text NOT NULL,             -- preview | enviado | autorizado | rejeitado | cancelado
      chave         text,                      -- chave de acesso (44 díg) quando autorizado
      num_averbacao text,
      xml_url       text,
      pdf_url       text,                      -- DACTE/DAMDFE
      data          jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at    timestamptz DEFAULT now()
    )`);
}

/** Busca um frete pelo NÚMERO na coleção fretes. */
export async function freteDoCrm(numero) {
  const { rows } = await getPool().query(
    `SELECT id, data FROM fretes WHERE data->>'numero' = $1 LIMIT 1`, [String(numero).trim()]
  );
  if (!rows.length) return null;
  return { id: rows[0].id, ...rows[0].data };
}

export async function upsertDoc(doc) {
  await getPool().query(
    `INSERT INTO fiscal_docs (id, frete_id, frete_numero, tipo, status, chave, num_averbacao, xml_url, pdf_url, data, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET
       status=$5, chave=COALESCE($6, fiscal_docs.chave), num_averbacao=COALESCE($7, fiscal_docs.num_averbacao),
       xml_url=COALESCE($8, fiscal_docs.xml_url), pdf_url=COALESCE($9, fiscal_docs.pdf_url),
       data=fiscal_docs.data || $10::jsonb, updated_at=now()`,
    [doc.id, doc.freteId, doc.freteNumero, doc.tipo, doc.status,
     doc.chave || null, doc.numAverbacao || null, doc.xmlUrl || null, doc.pdfUrl || null,
     JSON.stringify(doc.data || {})]
  );
}

export async function docsDoFrete(freteNumero) {
  const { rows } = await getPool().query(
    `SELECT * FROM fiscal_docs WHERE frete_numero = $1 ORDER BY updated_at DESC`, [String(freteNumero)]
  );
  return rows;
}
