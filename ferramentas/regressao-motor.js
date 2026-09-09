/* Regressão do motor de cálculo de frete.

   Existe por causa do bug de 04/09/2026, em que uma mudança no filtro de rotas
   fez TODAS as rotas diretas sumirem e só apareceu em produção. A lição
   registrada no CLAUDE.md foi: testar também o caminho em que a mudança NÃO se
   aplica. Por isso a amostra abaixo mistura de propósito pares que passam pelo
   hub de SBC (onde a mudança pega) com pares regionais que não passam.

   Uso:
     node ferramentas/regressao-motor.js base    -> grava ferramentas/baseline.json
     node ferramentas/regressao-motor.js comparar -> roda de novo e compara

   Aceita a mudança só se NENHUM par ficar mais caro. */
'use strict';
const path = require('path'), fs = require('fs'), Module = require('module');
const DIR = path.join(__dirname, '..', 'integracao');
process.env.NODE_PATH = path.join(DIR, 'vps', 'stubs');
Module._initPaths();
process.chdir(DIR);

const { _internos: I } = require(path.join(DIR, 'calc-fretes.js'));
const db = require(path.join(DIR, 'tabela-fretes.json'));
const BASE = path.join(__dirname, 'baseline.json');

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/* Amostra determinística: pega os destinos reais da tabela e cruza com origens
   de perfis diferentes. Nada de aleatório — a lista precisa ser a mesma sempre. */
function montarPares() {
  const dests = new Map();
  (db.rotas || []).forEach((r) => (r.trajetos || []).forEach((t) => {
    if (t.dNome && t.dUF) dests.set(norm(t.dNome) + '|' + t.dUF, t.dNome + ' ' + t.dUF);
  }));
  const todos = [...dests.values()].sort();
  const passo = Math.max(1, Math.floor(todos.length / 45));
  const amostra = todos.filter((_, i) => i % passo === 0).slice(0, 45);

  const origens = [
    'São Bernardo do Campo SP',   // o hub: e onde o corte de combinacoes morde
    'São Paulo SP',               // vizinha do hub (19 km)
    'Rio de Janeiro RJ',
    'Betim MG',
    'Campo Grande MS',
    'Recife PE',                  // regionais: o corte nao morde, tem que ficar igual
    'Porto Alegre RS',
  ];
  const pares = [];
  origens.forEach((o) => amostra.forEach((d) => {
    if (norm(o).split(' ')[0] !== norm(d).split(' ')[0]) pares.push([o, d]);
  }));
  return pares;
}

function rodar() {
  const coords = I.carregarCoords();
  return Promise.resolve(coords).then((c) => {
    const out = {};
    for (const [o, d] of montarPares()) {
      const l = { origem: o, destino: d, categoria: 'Carro passeio', veiculoDesc: 'Onix', valorVeiculo: '50000' };
      let ok = false;
      try { ok = I.calcularFreteLead(l, db, c); } catch (e) { out[o + ' -> ' + d] = { erro: e.message }; continue; }
      out[o + ' -> ' + d] = ok === false ? { semRota: true } : {
        total: I.numMoeda(l.valorCotacaoSW),
        trechos: (l.trajetos || []).length,
        rota: (l.trajetos || []).map((t) => t.de + '>' + t.para + '(' + t.transportadora + ')').join(' | '),
      };
    }
    return out;
  });
}

const modo = process.argv[2] || 'base';
rodar().then((res) => {
  const n = Object.keys(res).length;
  if (modo === 'base') {
    fs.writeFileSync(BASE, JSON.stringify(res, null, 1));
    console.log('baseline gravado:', n, 'pares ->', BASE);
    return;
  }
  const antes = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  let iguais = 0; const barato = [], caro = [], mudouRota = [], sumiu = [], surgiu = [];
  for (const k of Object.keys(antes)) {
    const a = antes[k], b = res[k];
    if (!b) { sumiu.push(k); continue; }
    if (a.semRota && !b.semRota) { surgiu.push(k + '  -> R$ ' + b.total); continue; }
    if (!a.semRota && b.semRota) { sumiu.push(k + '  (tinha R$ ' + a.total + ')'); continue; }
    if (a.semRota && b.semRota) { iguais++; continue; }
    if (b.total < a.total) barato.push(k + '  R$ ' + a.total + ' -> R$ ' + b.total + '  (' + a.trechos + 't -> ' + b.trechos + 't)');
    else if (b.total > a.total) caro.push(k + '  R$ ' + a.total + ' -> R$ ' + b.total);
    else if (a.rota !== b.rota) mudouRota.push(k + '  mesmo preco, rota diferente');
    else iguais++;
  }
  console.log('pares avaliados:', n);
  console.log('  iguais              :', iguais);
  console.log('  MAIS BARATOS        :', barato.length);
  console.log('  MAIS CAROS          :', caro.length, caro.length ? '  <-- REPROVA' : '');
  console.log('  mesmo preco, outra rota:', mudouRota.length);
  console.log('  perderam rota       :', sumiu.length, sumiu.length ? '  <-- REPROVA' : '');
  console.log('  ganharam rota       :', surgiu.length);
  const most = (t, l) => { if (!l.length) return; console.log('\n' + t); l.slice(0, 12).forEach((x) => console.log('   ' + x)); if (l.length > 12) console.log('   ... +' + (l.length - 12)); };
  most('MAIS CAROS (nao pode existir):', caro);
  most('perderam rota (nao pode existir):', sumiu);
  most('mais baratos:', barato);
  most('ganharam rota:', surgiu);
  const reprova = caro.length || sumiu.length;
  console.log('\n' + (reprova ? '>>> REPROVADO' : '>>> APROVADO'));
  process.exit(reprova ? 1 : 0);
}).catch((e) => { console.error('ERRO:', e); process.exit(2); });
