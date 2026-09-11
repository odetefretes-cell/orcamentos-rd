/* Mede o efeito da correção dos sub-trechos nas cidades "presas" — as que recebem
   entrega mas não podem carregar (90% da tabela). É a família do caso Montes Claros.

   Uso:  node ferramentas/corredores.js <arquivo-saida.json>
   Depois compare dois arquivos com: node ferramentas/corredores.js --diff a.json b.json */
'use strict';
const path = require('path'), fs = require('fs'), Module = require('module');
const DIR = path.join(__dirname, '..', 'integracao');
process.env.NODE_PATH = path.join(DIR, 'vps', 'stubs');
Module._initPaths();
process.chdir(DIR);
const { _internos: I } = require(path.join(DIR, 'calc-fretes.js'));
const db = require(path.join(DIR, 'tabela-fretes.json'));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

if (process.argv[2] === '--diff') {
  const A = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const B = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  let ig = 0; const melhor = [], pior = [], tetoOk = [], ganhou = [], perdeu = [];
  let economia = 0;
  for (const k of Object.keys(A)) {
    const a = A[k], b = B[k];
    if (!b) continue;
    if (a.semRota && b.semRota) { ig++; continue; }
    if (a.semRota && !b.semRota) { ganhou.push(`${k}  -> R$ ${b.total} (${b.trechos}t)`); continue; }
    if (!a.semRota && b.semRota) { perdeu.push(`${k}  (tinha R$ ${a.total})`); continue; }
    if (b.total < a.total) { economia += a.total - b.total; melhor.push(`${k}  R$ ${a.total} -> R$ ${b.total}  (${a.trechos}t -> ${b.trechos}t)`); }
    else if (b.total > a.total) {
      // REGRA DE NEGÓCIO (confirmada pelo Luiz em 04/09): vale pagar até R$ 300 a mais por
      // UM EMBARQUE A MENOS — é o CRM_TETO_DIRETA do motor. Ficar mais caro reduzindo trecho,
      // dentro do teto, é o comportamento desejado; só reprova o que encarece sem essa troca.
      const dif = b.total - a.total;
      if (b.trechos < a.trechos && dif <= 300) tetoOk.push(`${k}  R$ ${a.total} -> R$ ${b.total}  (${a.trechos}t -> ${b.trechos}t, +R$ ${dif})`);
      else pior.push(`${k}  R$ ${a.total} -> R$ ${b.total}  (${a.trechos}t -> ${b.trechos}t, +R$ ${dif})`);
    }
    else ig++;
  }
  console.log('pares:', Object.keys(A).length);
  console.log('  iguais        :', ig);
  console.log('  MAIS BARATOS  :', melhor.length);
  console.log('  MAIS CAROS    :', pior.length, pior.length ? '  <-- REPROVA' : '');
  console.log('  +caro c/ 1 embarque a menos (regra do teto):', tetoOk.length);
  console.log('  ganharam rota :', ganhou.length);
  console.log('  perderam rota :', perdeu.length, perdeu.length ? '  <-- REPROVA' : '');
  console.log('  economia somada: R$', economia.toLocaleString('pt-BR'));
  const most = (t, l) => { if (!l.length) return; console.log('\n' + t); l.slice(0, 20).forEach((x) => console.log('   ' + x)); if (l.length > 20) console.log('   ... +' + (l.length - 20)); };
  most('MAIS CAROS (não pode existir):', pior);
  most('perderam rota (não pode existir):', perdeu);
  most('mais caros COM um embarque a menos (aceito pela regra):', tetoOk);
  most('mais baratos:', melhor.sort());
  most('ganharam rota:', ganhou);
  process.exit(pior.length || perdeu.length ? 1 : 0);
}

/* cidades presas = só aparecem como destino de trajeto */
function presas() {
  const sai = new Set(), chega = new Map(), nome = new Map();
  (db.rotas || []).forEach((r) => (r.trajetos || []).forEach((x) => {
    const O = norm(x.oNome) + '|' + x.oUF, D = norm(x.dNome) + '|' + x.dUF;
    nome.set(D, x.dNome + ' ' + x.dUF);
    sai.add(O); chega.set(D, (chega.get(D) || 0) + 1);
  }));
  return [...chega.entries()].filter(([c]) => !sai.has(c))
    .sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ cidade: nome.get(c), rotas: n }));
}

const DESTINOS = ['São Luís MA', 'Manaus AM', 'Fortaleza CE', 'Porto Alegre RS', 'Belém PA'];
const TOP = 30;

Promise.resolve(I.carregarCoords()).then((coords) => {
  const lista = presas().slice(0, TOP);
  const out = {};
  let i = 0;
  for (const { cidade } of lista) {
    process.stderr.write(`  ${++i}/${lista.length} ${cidade}\n`);
    for (const d of DESTINOS) {
      if (norm(cidade).split(' ')[0] === norm(d).split(' ')[0]) continue;
      const l = { origem: cidade, destino: d, categoria: 'Carro passeio', veiculoDesc: 'Onix', valorVeiculo: '50000' };
      let ok = false;
      try { ok = I.calcularFreteLead(l, db, coords); } catch (e) { continue; }
      out[`${cidade} -> ${d}`] = ok === false ? { semRota: true } : {
        total: I.numMoeda(l.valorCotacaoSW), trechos: (l.trajetos || []).length,
        rota: (l.trajetos || []).map((t) => t.de + '>' + t.para).join(' | '),
      };
    }
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
  console.log('gravado:', Object.keys(out).length, 'pares ->', process.argv[2]);
});
