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

// -------- data do frete: nomes reais (prioridade). CAMPO_DATA troca qual manda. --------
// Padrão: dataFechamento (quando o negócio fechou = virou frete) → cai p/ dataEntrada.
const CAMPO_DATA = process.env.CAMPO_DATA || '';   // se setado, usa SÓ esse campo
const CAMPOS_DATA = CAMPO_DATA
  ? [CAMPO_DATA]
  : ['dataFechamento', 'dataEntrada', 'dataEnvio', 'dataUltimoContato'];
const TODAS_DATAS = ['dataFechamento', 'dataEntrada', 'dataEnvio', 'dataUltimoContato'];
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
  console.log(`\ncrm_leads: ${rows.length} docs.  Corte: até ${CORTE}.  Campo(s) de data: [${CAMPOS_DATA.join(' > ')}].  Modo: ${APLICAR ? 'APLICAR' : 'DRY-RUN'}\n`);

  // 1) universo: leads COM prestador em aberto (independe de data)
  const comAberto = [];
  let totAbertos = 0;
  for (const row of rows) {
    const f = row.data || {};
    const { arr, legado } = prestDe(f);
    const abertos = arr.filter(emAberto);
    if (abertos.length === 0) continue;
    totAbertos += abertos.length;
    comAberto.push({ id: row.id, f, arr, legado, abertos });
  }
  console.log(`Leads com prestador EM ABERTO: ${comAberto.length}  |  total de prestadores em aberto: ${totAbertos}\n`);

  // 2) cobertura de cada campo de data nesse universo
  console.log('Cobertura das datas (nos leads com prestador em aberto):');
  for (const c of TODAS_DATAS) {
    const comCampo = comAberto.filter((x) => normISO(x.f[c]));
    const isos = comCampo.map((x) => normISO(x.f[c])).sort();
    console.log(`  ${c}: ${comCampo.length}/${comAberto.length}  ${isos.length ? `(${isos[0]} … ${isos[isos.length - 1]})` : ''}`);
  }

  // 3) aplicando a prioridade CAMPOS_DATA + o corte
  let semData = 0, foraCorte = 0;
  let leadsAfetados = 0, prestBaixados = 0, prestLegado = 0;
  const exemplos = [];
  const paraGravar = [];
  for (const x of comAberto) {
    const { iso, campo } = dataFrete(x.f);
    if (!iso) { semData++; continue; }
    if (iso > CORTE) { foraCorte++; continue; }
    for (const p of x.abertos) { p.contaAzul = iso; p.conf = true; p.incl = true; p.pago = true; }
    const novo = { ...x.f, prestadores: x.arr, _salvoEm: new Date().toISOString() };
    leadsAfetados++; prestBaixados += x.abertos.length; if (x.legado) prestLegado += x.abertos.length;
    paraGravar.push({ id: x.id, data: novo });
    if (exemplos.length < 12) exemplos.push({ id: x.id, iso, campo, n: x.abertos.length, legado: x.legado, datas: TODAS_DATAS.map((c) => `${c.replace('data', '')}=${normISO(x.f[c]) || '—'}`).join(' '), prest: x.abertos.map((p) => `${p.emp}=${p.valor}`).join(' | ').slice(0, 90) });
  }

  console.log(`\nCom a prioridade [${CAMPOS_DATA.join(' > ')}] e corte ${CORTE}:`);
  console.log(`  sem NENHUMA data: ${semData}  |  fora do corte (depois): ${foraCorte}`);
  console.log(`\n>>> Fretes que receberiam baixa: ${leadsAfetados}`);
  console.log(`>>> Prestadores que receberiam baixa: ${prestBaixados}  (${prestLegado} do formato legado)\n`);
  console.log('Exemplos (com todas as datas do frete):');
  for (const e of exemplos) console.log(`  ${e.id}  usada=${e.iso}(${e.campo})  [${e.datas}]  baixa ${e.n}: ${e.prest}`);

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
