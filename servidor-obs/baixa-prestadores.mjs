/* ===========================================================================
 *  BAIXA EM MASSA de prestadores "em aberto" (só marca no sistema OBS).
 *  Preenche a "Data ContaAzul" (pr.contaAzul) dos prestadores em aberto de
 *  fretes ATÉ uma data de corte → eles saem de "Em aberto" e viram
 *  "Conferido/pago". NÃO cria nada no Conta Azul.
 *
 *  Uso (rodar de /opt/obs-api, que tem o módulo pg):
 *     node baixa-prestadores.mjs                # DRY-RUN: só conta e mostra, NÃO escreve
 *     node baixa-prestadores.mjs --aplicar      # aplica (faz BACKUP antes)
 *
 *  Corte padrão: 2026-05-31 (inclui maio). Trocar com CORTE=YYYY-MM-DD.
 * ===========================================================================*/
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

// credenciais do Postgres (mesmo .env do obs-api)
const d = await import('dotenv');
d.config({ path: '/etc/obs-db/.env', quiet: true });

const CORTE = process.env.CORTE || '2026-05-31';         // inclui esta data
const APLICAR = process.argv.includes('--aplicar');

const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 5,
});

// -------- data do frete: tenta vários nomes de campo, normaliza p/ YYYY-MM-DD --------
const CAMPOS_DATA = [
  'dataEmissao', 'emissao', 'dataFrete', 'dataAutorizacao', 'dataCadastro',
  'data', 'criadoEm', 'dataCriacao', 'dataColeta', 'dataCarregamento',
];
function normISO(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);            // 2026-05-31...
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);              // 31/05/2026
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const t = Date.parse(s);                                // ISO com hora, etc.
  if (!isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}
function dataFrete(f) {
  for (const c of CAMPOS_DATA) { const iso = normISO(f[c]); if (iso) return { iso, campo: c }; }
  return { iso: null, campo: null };
}
function chavesDataLike(f) {
  return Object.keys(f).filter((k) => /data|emiss|venc|coleta|carreg|cadastr|criad/i.test(k));
}

// -------- prestadores do frete (array ou legado prestEmpresa1..4) --------
function prestDe(f) {
  if (Array.isArray(f.prestadores)) return { arr: f.prestadores, legado: false };
  const a = [];
  for (let i = 1; i <= 4; i++) {
    const emp = f['prestEmpresa' + i], val = f['prestValor' + i];
    if (emp || val || f['prestTel' + i] || f['prestSaida' + i]) {
      a.push({ emp: emp || '', tel: f['prestTel' + i] || '', placa: '', saida: f['prestSaida' + i] || '', valor: val || '', conf: false, incl: false, pago: false });
    }
  }
  return { arr: a, legado: true };
}
const num = (v) => {
  if (v === '' || v == null) return 0;
  let s = String(v).replace(/[R$\s]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s.replace(/[^\d.-]/g, ''));
  return isNaN(n) ? 0 : n;
};
const emAberto = (p) => !(p.contaAzul && String(p.contaAzul).trim()) && num(p.valor) > 0;

async function main() {
  const { rows } = await pool.query('SELECT id, data FROM crm_leads');
  console.log(`\ncrm_leads: ${rows.length} documentos.  Corte: até ${CORTE} (inclusive).  Modo: ${APLICAR ? 'APLICAR' : 'DRY-RUN (não escreve)'}\n`);

  const freqCampoData = {};
  const chavesVistas = {};
  let semData = 0, dentroCorte = 0, foraCorte = 0;
  let leadsAfetados = 0, prestBaixados = 0, prestLegado = 0;
  const exemplos = [];
  const paraGravar = [];

  for (const row of rows) {
    const f = row.data || {};
    const { iso, campo } = dataFrete(f);
    if (campo) freqCampoData[campo] = (freqCampoData[campo] || 0) + 1;
    for (const k of chavesDataLike(f)) chavesVistas[k] = (chavesVistas[k] || 0) + 1;

    if (!iso) { semData++; continue; }
    if (iso > CORTE) { foraCorte++; continue; }
    dentroCorte++;

    const { arr, legado } = prestDe(f);
    const abertos = arr.filter(emAberto);
    if (abertos.length === 0) continue;

    // marca baixa: contaAzul = data do frete (backfill honesto); conf/incl/pago=true
    for (const p of abertos) { p.contaAzul = iso; p.conf = true; p.incl = true; p.pago = true; }
    const novo = { ...f, prestadores: arr, _salvoEm: new Date().toISOString() };

    leadsAfetados++;
    prestBaixados += abertos.length;
    if (legado) prestLegado += abertos.length;
    paraGravar.push({ id: row.id, data: novo });
    if (exemplos.length < 8) exemplos.push({ id: row.id, data: iso, campo, n: abertos.length, legado, prest: abertos.map((p) => `${p.emp}=${p.valor}`).join(' | ') });
  }

  console.log('— Campo de data usado (frequência):', JSON.stringify(freqCampoData));
  console.log('— Chaves "de data" encontradas nos docs:', JSON.stringify(chavesVistas));
  console.log(`— Sem data detectável: ${semData}  |  fora do corte (depois de ${CORTE}): ${foraCorte}  |  dentro do corte: ${dentroCorte}`);
  console.log(`\n>>> Fretes que receberiam baixa: ${leadsAfetados}`);
  console.log(`>>> Prestadores que receberiam baixa: ${prestBaixados}  (dos quais ${prestLegado} vindos do formato legado)\n`);
  console.log('Exemplos:');
  for (const e of exemplos) console.log(`  frete ${e.id}  data=${e.data}(${e.campo})  legado=${e.legado}  baixa em ${e.n}: ${e.prest}`);

  if (!APLICAR) {
    console.log('\n(DRY-RUN — nada foi escrito. Rode com --aplicar para gravar.)\n');
    await pool.end();
    return;
  }

  // BACKUP antes de qualquer escrita
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bkp = `/opt/obs-api/backup-crm_leads-${stamp}.json`;
  const full = await pool.query('SELECT id, data FROM crm_leads');
  writeFileSync(bkp, JSON.stringify(full.rows), 'utf8');
  console.log(`\nBackup salvo em ${bkp} (${full.rows.length} docs).`);

  // grava (deep-set do prestadores, preservando o resto via replace do doc inteiro)
  let ok = 0;
  const cli = await pool.connect();
  try {
    for (const g of paraGravar) {
      await cli.query('UPDATE crm_leads SET data = $1::jsonb, updated_at = now() WHERE id = $2', [JSON.stringify(g.data), g.id]);
      ok++;
    }
  } finally { cli.release(); }
  console.log(`\n✔ Baixa aplicada em ${ok} fretes (${prestBaixados} prestadores). Backup: ${bkp}\n`);
  await pool.end();
}

main().catch((e) => { console.error('ERRO:', e); process.exit(1); });
