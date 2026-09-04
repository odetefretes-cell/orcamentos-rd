/* ============================================================================
   OBS Transportes — Cálculo de frete NO BACKEND (Fase B)

   Porta a MESMA lógica de cálculo do app (index.html) para o Node, para calcular
   a média SEM depender do navegador aberto (roda 24h).

   Fonte da tabela de preços (na ordem):
     1. Firestore  fretes/_tabela  (+ _tabela_p1, _tabela_p2 …) — É A MESMA que o
        admin importa da planilha. Assim o backend usa sempre o preço mais novo,
        sem mudar nada na rotina de importação.
     2. Arquivo empacotado  ./tabela-fretes.json  (fallback).

   As coordenadas das cidades vêm de ./cidades-coords.json (empacotado).

   ⚠️ Este arquivo é uma CÓPIA FIEL das funções do index.html (mesmos números).
      Se a regra de cálculo mudar no app, atualize aqui também.
   ============================================================================ */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { getFirestore } = require('firebase-admin/firestore');

/* ---------------------------------------------------------------------------
   Constantes financeiras (verbatim do index.html)
   --------------------------------------------------------------------------- */
const IMPOSTO_PCT = 0.12;
const CRM_TETO_DIRETA = 300;   // R$ a mais aceitáveis p/ ganhar um embarque a menos (150->300: prefere rota DIRETA, menos transbordo)

// SEGURO_TX[origemUF][destinoUF] = percentual (0.16 = 0,16% sobre o valor do veículo)
const SEGURO_TX = {"AC":{"AC":0.04,"AL":0.3,"AP":0.26,"AM":0.09,"BA":0.3,"CE":0.28,"DF":0.18,"ES":0.26,"GO":0.18,"MA":0.28,"MT":0.12,"MS":0.16,"MG":0.22,"PA":0.24,"PB":0.3,"PR":0.24,"PE":0.3,"PI":0.26,"RJ":0.26,"RN":0.3,"RS":0.28,"RO":0.05,"RR":0.14,"SC":0.26,"SP":0.24,"SE":0.3,"TO":0.23},"AL":{"AC":0.3,"AL":0.04,"AP":0.16,"AM":0.3,"BA":0.06,"CE":0.07,"DF":0.14,"ES":0.11,"GO":0.14,"MA":0.1,"MT":0.2,"MS":0.22,"MG":0.11,"PA":0.14,"PB":0.05,"PR":0.18,"PE":0.05,"PI":0.08,"RJ":0.14,"RN":0.05,"RS":0.22,"RO":0.26,"RR":0.32,"SC":0.2,"SP":0.16,"SE":0.05,"TO":0.12},"AP":{"AC":0.26,"AL":0.16,"AP":0.08,"AM":0.26,"BA":0.16,"CE":0.11,"DF":0.14,"ES":0.22,"GO":0.14,"MA":0.09,"MT":0.2,"MS":0.26,"MG":0.2,"PA":0.09,"PB":0.16,"PR":0.22,"PE":0.16,"PI":0.09,"RJ":0.22,"RN":0.16,"RS":0.28,"RO":0.22,"RR":0.3,"SC":0.24,"SP":0.2,"SE":0.16,"TO":0.13},"AM":{"AC":0.09,"AL":0.3,"AP":0.26,"AM":0.08,"BA":0.3,"CE":0.28,"DF":0.2,"ES":0.28,"GO":0.2,"MA":0.28,"MT":0.18,"MS":0.2,"MG":0.24,"PA":0.24,"PB":0.3,"PR":0.26,"PE":0.3,"PI":0.24,"RJ":0.28,"RN":0.3,"RS":0.3,"RO":0.09,"RR":0.09,"SC":0.28,"SP":0.26,"SE":0.32,"TO":0.2},"BA":{"AC":0.3,"AL":0.06,"AP":0.16,"AM":0.3,"BA":0.05,"CE":0.08,"DF":0.14,"ES":0.08,"GO":0.14,"MA":0.1,"MT":0.16,"MS":0.18,"MG":0.09,"PA":0.12,"PB":0.07,"PR":0.14,"PE":0.06,"PI":0.08,"RJ":0.1,"RN":0.08,"RS":0.18,"RO":0.26,"RR":0.32,"SC":0.16,"SP":0.12,"SE":0.06,"TO":0.11},"CE":{"AC":0.28,"AL":0.07,"AP":0.11,"AM":0.28,"BA":0.08,"CE":0.04,"DF":0.18,"ES":0.14,"GO":0.18,"MA":0.07,"MT":0.24,"MS":0.24,"MG":0.16,"PA":0.1,"PB":0.05,"PR":0.22,"PE":0.06,"PI":0.07,"RJ":0.18,"RN":0.05,"RS":0.26,"RO":0.26,"RR":0.32,"SC":0.24,"SP":0.2,"SE":0.08,"TO":0.13},"DF":{"AC":0.18,"AL":0.14,"AP":0.14,"AM":0.2,"BA":0.14,"CE":0.18,"DF":0.03,"ES":0.09,"GO":0.05,"MA":0.16,"MT":0.07,"MS":0.08,"MG":0.06,"PA":0.12,"PB":0.16,"PR":0.09,"PE":0.16,"PI":0.18,"RJ":0.09,"RN":0.18,"RS":0.11,"RO":0.14,"RR":0.26,"SC":0.09,"SP":0.06,"SE":0.12,"TO":0.07},"ES":{"AC":0.26,"AL":0.11,"AP":0.22,"AM":0.28,"BA":0.08,"CE":0.14,"DF":0.09,"ES":0.03,"GO":0.09,"MA":0.16,"MT":0.14,"MS":0.12,"MG":0.05,"PA":0.2,"PB":0.12,"PR":0.09,"PE":0.12,"PI":0.14,"RJ":0.04,"RN":0.14,"RS":0.12,"RO":0.22,"RR":0.32,"SC":0.1,"SP":0.07,"SE":0.09,"TO":0.14},"GO":{"AC":0.18,"AL":0.14,"AP":0.14,"AM":0.2,"BA":0.14,"CE":0.18,"DF":0.05,"ES":0.09,"GO":0.05,"MA":0.16,"MT":0.07,"MS":0.08,"MG":0.06,"PA":0.12,"PB":0.16,"PR":0.09,"PE":0.16,"PI":0.18,"RJ":0.09,"RN":0.18,"RS":0.11,"RO":0.14,"RR":0.26,"SC":0.09,"SP":0.06,"SE":0.12,"TO":0.08},"MA":{"AC":0.28,"AL":0.1,"AP":0.09,"AM":0.28,"BA":0.1,"CE":0.07,"DF":0.16,"ES":0.16,"GO":0.16,"MA":0.06,"MT":0.2,"MS":0.24,"MG":0.16,"PA":0.09,"PB":0.11,"PR":0.24,"PE":0.1,"PI":0.07,"RJ":0.2,"RN":0.1,"RS":0.28,"RO":0.24,"RR":0.32,"SC":0.26,"SP":0.2,"SE":0.11,"TO":0.11},"MT":{"AC":0.12,"AL":0.2,"AP":0.2,"AM":0.18,"BA":0.16,"CE":0.24,"DF":0.07,"ES":0.14,"GO":0.07,"MA":0.2,"MT":0.06,"MS":0.07,"MG":0.1,"PA":0.14,"PB":0.22,"PR":0.11,"PE":0.22,"PI":0.18,"RJ":0.14,"RN":0.24,"RS":0.16,"RO":0.09,"RR":0.24,"SC":0.12,"SP":0.11,"SE":0.18,"TO":0.1},"MS":{"AC":0.16,"AL":0.22,"AP":0.26,"AM":0.2,"BA":0.18,"CE":0.24,"DF":0.08,"ES":0.12,"GO":0.08,"MA":0.24,"MT":0.07,"MS":0.05,"MG":0.09,"PA":0.18,"PB":0.24,"PR":0.07,"PE":0.24,"PI":0.2,"RJ":0.09,"RN":0.26,"RS":0.11,"RO":0.14,"RR":0.26,"SC":0.09,"SP":0.07,"SE":0.2,"TO":0.14},"MG":{"AC":0.22,"AL":0.11,"AP":0.2,"AM":0.24,"BA":0.09,"CE":0.16,"DF":0.06,"ES":0.05,"GO":0.06,"MA":0.16,"MT":0.1,"MS":0.09,"MG":0.04,"PA":0.18,"PB":0.14,"PR":0.07,"PE":0.14,"PI":0.14,"RJ":0.05,"RN":0.14,"RS":0.1,"RO":0.2,"RR":0.3,"SC":0.08,"SP":0.05,"SE":0.1,"TO":0.13},"PA":{"AC":0.24,"AL":0.14,"AP":0.09,"AM":0.24,"BA":0.12,"CE":0.1,"DF":0.12,"ES":0.2,"GO":0.12,"MA":0.09,"MT":0.14,"MS":0.18,"MG":0.18,"PA":0.08,"PB":0.14,"PR":0.2,"PE":0.12,"PI":0.09,"RJ":0.2,"RN":0.12,"RS":0.26,"RO":0.2,"RR":0.28,"SC":0.22,"SP":0.18,"SE":0.14,"TO":0.12},"PB":{"AC":0.3,"AL":0.05,"AP":0.16,"AM":0.3,"BA":0.07,"CE":0.05,"DF":0.16,"ES":0.12,"GO":0.16,"MA":0.11,"MT":0.22,"MS":0.24,"MG":0.14,"PA":0.14,"PB":0.04,"PR":0.2,"PE":0.05,"PI":0.08,"RJ":0.16,"RN":0.05,"RS":0.24,"RO":0.28,"RR":0.32,"SC":0.22,"SP":0.18,"SE":0.05,"TO":0.13},"PR":{"AC":0.24,"AL":0.18,"AP":0.22,"AM":0.26,"BA":0.14,"CE":0.22,"DF":0.09,"ES":0.09,"GO":0.09,"MA":0.24,"MT":0.11,"MS":0.07,"MG":0.07,"PA":0.2,"PB":0.2,"PR":0.03,"PE":0.2,"PI":0.2,"RJ":0.06,"RN":0.22,"RS":0.06,"RO":0.2,"RR":0.3,"SC":0.04,"SP":0.04,"SE":0.16,"TO":0.18},"PE":{"AC":0.3,"AL":0.05,"AP":0.16,"AM":0.3,"BA":0.06,"CE":0.06,"DF":0.16,"ES":0.12,"GO":0.16,"MA":0.1,"MT":0.22,"MS":0.24,"MG":0.14,"PA":0.12,"PB":0.05,"PR":0.2,"PE":0.04,"PI":0.08,"RJ":0.16,"RN":0.05,"RS":0.24,"RO":0.26,"RR":0.32,"SC":0.24,"SP":0.16,"SE":0.05,"TO":0.12},"PI":{"AC":0.26,"AL":0.08,"AP":0.09,"AM":0.24,"BA":0.08,"CE":0.07,"DF":0.18,"ES":0.14,"GO":0.18,"MA":0.07,"MT":0.18,"MS":0.2,"MG":0.14,"PA":0.09,"PB":0.08,"PR":0.2,"PE":0.08,"PI":0.06,"RJ":0.16,"RN":0.08,"RS":0.24,"RO":0.22,"RR":0.3,"SC":0.22,"SP":0.18,"SE":0.09,"TO":0.1},"RJ":{"AC":0.26,"AL":0.14,"AP":0.22,"AM":0.28,"BA":0.1,"CE":0.18,"DF":0.09,"ES":0.04,"GO":0.09,"MA":0.2,"MT":0.14,"MS":0.09,"MG":0.05,"PA":0.2,"PB":0.16,"PR":0.06,"PE":0.16,"PI":0.16,"RJ":0.02,"RN":0.18,"RS":0.1,"RO":0.22,"RR":0.32,"SC":0.08,"SP":0.04,"SE":0.12,"TO":0.14},"RN":{"AC":0.3,"AL":0.05,"AP":0.16,"AM":0.3,"BA":0.08,"CE":0.05,"DF":0.18,"ES":0.14,"GO":0.18,"MA":0.1,"MT":0.24,"MS":0.26,"MG":0.14,"PA":0.12,"PB":0.05,"PR":0.22,"PE":0.05,"PI":0.08,"RJ":0.18,"RN":0.04,"RS":0.26,"RO":0.28,"RR":0.32,"SC":0.24,"SP":0.18,"SE":0.06,"TO":0.13},"RS":{"AC":0.28,"AL":0.22,"AP":0.28,"AM":0.3,"BA":0.18,"CE":0.26,"DF":0.11,"ES":0.12,"GO":0.11,"MA":0.28,"MT":0.16,"MS":0.11,"MG":0.1,"PA":0.26,"PB":0.24,"PR":0.06,"PE":0.24,"PI":0.24,"RJ":0.1,"RN":0.26,"RS":0.03,"RO":0.24,"RR":0.32,"SC":0.04,"SP":0.07,"SE":0.2,"TO":0.2},"RO":{"AC":0.05,"AL":0.26,"AP":0.22,"AM":0.09,"BA":0.26,"CE":0.26,"DF":0.14,"ES":0.22,"GO":0.14,"MA":0.24,"MT":0.09,"MS":0.14,"MG":0.2,"PA":0.2,"PB":0.28,"PR":0.2,"PE":0.26,"PI":0.22,"RJ":0.22,"RN":0.28,"RS":0.24,"RO":0.04,"RR":0.1,"SC":0.22,"SP":0.2,"SE":0.28,"TO":0.2},"RR":{"AC":0.14,"AL":0.32,"AP":0.3,"AM":0.09,"BA":0.32,"CE":0.32,"DF":0.26,"ES":0.32,"GO":0.26,"MA":0.32,"MT":0.24,"MS":0.26,"MG":0.3,"PA":0.28,"PB":0.32,"PR":0.3,"PE":0.32,"PI":0.3,"RJ":0.32,"RN":0.32,"RS":0.32,"RO":0.1,"RR":0.08,"SC":0.32,"SP":0.3,"SE":0.32,"TO":0.24},"SC":{"AC":0.26,"AL":0.2,"AP":0.24,"AM":0.28,"BA":0.16,"CE":0.24,"DF":0.09,"ES":0.1,"GO":0.09,"MA":0.26,"MT":0.12,"MS":0.09,"MG":0.08,"PA":0.22,"PB":0.22,"PR":0.04,"PE":0.24,"PI":0.22,"RJ":0.08,"RN":0.24,"RS":0.04,"RO":0.22,"RR":0.32,"SC":0.03,"SP":0.05,"SE":0.18,"TO":0.18},"SP":{"AC":0.24,"AL":0.16,"AP":0.2,"AM":0.26,"BA":0.12,"CE":0.2,"DF":0.06,"ES":0.07,"GO":0.06,"MA":0.2,"MT":0.11,"MS":0.07,"MG":0.05,"PA":0.18,"PB":0.18,"PR":0.04,"PE":0.16,"PI":0.18,"RJ":0.04,"RN":0.18,"RS":0.07,"RO":0.2,"RR":0.3,"SC":0.05,"SP":0.02,"SE":0.14,"TO":0.14},"SE":{"AC":0.3,"AL":0.05,"AP":0.16,"AM":0.32,"BA":0.06,"CE":0.08,"DF":0.12,"ES":0.09,"GO":0.12,"MA":0.11,"MT":0.18,"MS":0.2,"MG":0.1,"PA":0.14,"PB":0.05,"PR":0.16,"PE":0.05,"PI":0.09,"RJ":0.12,"RN":0.06,"RS":0.2,"RO":0.28,"RR":0.32,"SC":0.18,"SP":0.14,"SE":0.04,"TO":0.11},"TO":{"AC":0.23,"AL":0.12,"AP":0.13,"AM":0.2,"BA":0.11,"CE":0.13,"DF":0.07,"ES":0.14,"GO":0.08,"MA":0.11,"MT":0.1,"MS":0.14,"MG":0.13,"PA":0.12,"PB":0.13,"PR":0.18,"PE":0.12,"PI":0.1,"RJ":0.14,"RN":0.13,"RS":0.2,"RO":0.2,"RR":0.24,"SC":0.18,"SP":0.14,"SE":0.11,"TO":0.06}};

const CRM_COMP_MODELO = [
  { desc:'Frete Base',        valor:'',    ativo:true,  opcional:false },
  { desc:'Recebimento',       valor:'',    ativo:true,  opcional:false },
  { desc:'Taxa Fixa (Lucro)', valor:'500', ativo:true,  opcional:false },
  { desc:'Reembarque',        valor:'100', ativo:true,  opcional:false },
  { desc:'Seguro',            valor:'',    ativo:true,  opcional:false },
  { desc:'Imposto',           valor:'',    ativo:false, opcional:true,  auto:true },
  { desc:'Coleta',            valor:'',    ativo:false, opcional:true },
  { desc:'Entrega',           valor:'',    ativo:false, opcional:true }
];

/* ---------------------------------------------------------------------------
   Helpers de texto / número (verbatim)
   --------------------------------------------------------------------------- */
function normTxt(s){
  if(!s) return '';
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
}
function tabNorm(s){ if(s==null) return ''; return String(s).replace(/ /g,' ').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s+/g,' ').trim(); }
function numMoeda(v){
  if(v===''||v==null) return 0;
  let s = String(v).trim().replace(/[R$\s]/g,'');
  if(s.includes(',')) s = s.replace(/\./g,'').replace(',','.');
  else if(/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g,'');
  const n = parseFloat(s.replace(/[^\d.-]/g,''));
  return isNaN(n) ? 0 : n;
}
function ufTxt(s){
  const m = String(s||'').toUpperCase().match(/\b([A-Z]{2})\b\s*$/) || String(s||'').match(/\(([A-Za-z]{2})\)/);
  return m ? m[1].toUpperCase() : '';
}
function nk(norm, uf){ return (norm||'')+'|'+((uf||'').toUpperCase()); }
function matchKey(nodeKey, queryKey){
  const i=nodeKey.lastIndexOf('|'), j=queryKey.lastIndexOf('|');
  const nn=nodeKey.slice(0,i), nu=nodeKey.slice(i+1);
  const qn=queryKey.slice(0,j), qu=queryKey.slice(j+1);
  if(nu && qu && nu!==qu) return false;
  if(nn===qn) return true;
  const wb=(big,small)=> big.startsWith(small+' ') || big.endsWith(' '+small) || big.indexOf(' '+small+' ')>=0;
  return (qn.length>3 && wb(nn,qn)) || (nn.length>3 && wb(qn,nn));
}
function haversine(a,b){ const R=6371, rad=x=>x*Math.PI/180;
  const dLat=rad(b[0]-a[0]), dLon=rad(b[1]-a[1]);
  const s=Math.sin(dLat/2)**2+Math.cos(rad(a[0]))*Math.cos(rad(b[0]))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s)); }

/* ---------------------------------------------------------------------------
   Categoria e preço por categoria (verbatim)
   --------------------------------------------------------------------------- */
const CAT_ALIAS = [
  ['carro passeio','carro pequeno','passeio','carro','carro de passeio','automovel','sedan','hatch','popular'],
  ['carro grande','suv','caminhonete','pickup','picape','utilitario','van','carro g'],
  ['moto ate 300cc','moto 300','moto ate 300','moto pequena'],
  ['moto ate 700cc','moto 700','moto ate 700','moto media'],
  ['moto acima de 700cc','moto acima 700','moto acima de 700','moto grande']
];
function catGrupo(nome){
  const n=normTxt(nome);
  for(const g of CAT_ALIAS){ if(g.indexOf(n)>=0) return g; }
  if(/moto/.test(n)){ if(/700/.test(n)&&/acima|maior/.test(n)) return CAT_ALIAS[4]; if(/700/.test(n)) return CAT_ALIAS[3]; return CAT_ALIAS[2]; }
  if(/grande|suv|caminhon|pickup|picape|utilit/.test(n)) return CAT_ALIAS[1];
  if(/carro|passeio|sedan|hatch|automov|pequen/.test(n)) return CAT_ALIAS[0];
  return null;
}
function precoCat(valores, cat){
  if(!valores) return null;
  if(valores[cat]!=null) return valores[cat];
  const nc=normTxt(cat);
  for(const k in valores){ if(normTxt(k)===nc && valores[k]!=null) return valores[k]; }
  const g=catGrupo(cat); if(!g) return null;
  for(const k in valores){ if(g.indexOf(normTxt(k))>=0 && valores[k]!=null) return valores[k]; }
  for(const k in valores){ if(catGrupo(k)===g && valores[k]!=null) return valores[k]; }
  return null;
}
function crmCategoriaSugerida(l){
  if(l && l.categoria) return l.categoria;
  const v = normTxt(l && l.veiculoDesc);
  if(/\bmoto|cg |cb |cbr|xre|bros|titan|fan|factor|biz|pop|nmax|pcx|hornet|xj6|mt-|cc\b/.test(v)) return 'Moto até 300cc';
  return 'Carro passeio';
}

/* ---------------------------------------------------------------------------
   Reparo da tabela + preenchimento de sentido inverso (verbatim)
   --------------------------------------------------------------------------- */
function _repararRotasTabela(db){
  if(!db || !Array.isArray(db.rotas)) return db;
  const parseEnd = p => { const m=String(p||'').trim().match(/^(.+?)\s*\(([A-Za-z]{2})\)\s*$/); return m?{nome:m[1].trim(),uf:m[2].toUpperCase()}:null; };
  for(const r of db.rotas){
    const tjs=r.trajetos; if(!Array.isArray(tjs)||!tjs.length) continue;
    const parts=String(r.rota||'').split(' - '); if(parts.length<2) continue;
    const o=parseEnd(parts[0]), d=parseEnd(parts[parts.length-1]); if(!o||!d) continue;
    const destNorm = normTxt(d.nome)+'|'+d.uf;
    const temDestino = tjs.some(t => (normTxt(t.d||'')+'|'+((t.dUF||'').toUpperCase()))===destNorm);
    if(!temDestino){
      r.trajetos.push({ o:normTxt(o.nome), oUF:o.uf, d:normTxt(d.nome), dUF:d.uf, oNome:o.nome, dNome:d.nome });
    }
  }
  return db;
}
function crmPreencherInversos(db){
  if(!db || !Array.isArray(db.rotas)) return db;
  const cats = Array.isArray(db.categorias) ? db.categorias.slice() : [];
  if(!cats.length) return db;
  const partes = rota => { const s=String(rota||'').split(' - '); return s.length===2 ? [s[0].trim(), s[1].trim()] : null; };
  const idx = {};
  for(const r of db.rotas){ if(r && r.rota) idx[tabNorm(r.transportadora)+'||'+tabNorm(r.rota)] = r; }
  for(const r of db.rotas){
    const p = partes(r.rota); if(!p) continue;
    const rev = idx[tabNorm(r.transportadora)+'||'+tabNorm(p[1]+' - '+p[0])];
    if(!rev || !rev.valores) continue;
    r.valores = r.valores || {};
    for(const c of cats){
      if(precoCat(r.valores, c) != null) continue;
      const rv = precoCat(rev.valores, c);
      if(rv == null) continue;
      r.valores[c] = rv;
      (r._precoInv || (r._precoInv = {}))[tabNorm(c)] = true;
    }
  }
  return db;
}

/* ---------------------------------------------------------------------------
   Cidades atendidas + coordenadas + âncoras (caches presos ao objeto db)
   --------------------------------------------------------------------------- */
function crmBuildCidades(db){
  if(db._tabCidades) return db._tabCidades;
  if(!db) return null;
  const map={};
  for(const r of (db.rotas||[])) for(const t of (r.trajetos||[])){
    [[t.oNome,t.oUF],[t.dNome,t.dUF]].forEach(([nome,uf])=>{
      if(!nome||!uf) return; const U=String(uf).toUpperCase().trim(), nn=normTxt(nome);
      (map[U]=map[U]||{})[nn]=String(nome).trim();
    });
  }
  db._tabCidades={}; Object.keys(map).sort().forEach(U=>{ db._tabCidades[U]=Object.values(map[U]).sort((a,b)=>a.localeCompare(b,'pt')); });
  return db._tabCidades;
}
function cidadeNaTabela(db, normCidade, uf){
  const cid=crmBuildCidades(db); if(!cid||!cid[uf]) return false;
  return cid[uf].some(c=>{ const cn=normTxt(c); return cn===normCidade || (normCidade.length>3&&cn.includes(normCidade)) || (cn.length>3&&normCidade.includes(cn)); });
}
function basesComCoords(db, coords){
  if(db._bases) return db._bases;
  db._bases=[];
  if(!db || !coords) return db._bases;
  const seen=new Set();
  const add=(nomeBruto,uf)=>{
    const U=(uf||'').toUpperCase(); if(!U || !nomeBruto) return;
    const nome=String(nomeBruto).split('/')[0].trim(); if(!nome) return;
    const nn=normTxt(nome), key=nn+'|'+U; if(seen.has(key)) return;
    const co=coords[nn+'|'+U]; if(!co) return;
    seen.add(key); db._bases.push({ nome, uf:U, co });
  };
  if(db.cidades) for(const k in db.cidades){ const b=db.cidades[k]; add(b.cidade, b.uf); }
  const cid=crmBuildCidades(db);
  if(cid) for(const U in cid){ for(const nome of cid[U]) add(nome, U); }
  return db._bases;
}
function ancorasFortes(db, coords){
  if(db._ancoras) return db._ancoras;
  db._ancoras=[]; db._hubs=new Set();
  if(!db || !coords) return db._ancoras;
  const seen=new Set();
  const add=(nomeBruto,uf)=>{ const U=(uf||'').toUpperCase(); if(!U||!nomeBruto) return;
    const nome=String(nomeBruto).split('/')[0].trim(); const nn=normTxt(nome), key=nn+'|'+U;
    if(seen.has(key)) return; const co=coords[nn+'|'+U]; if(!co) return;
    seen.add(key); db._ancoras.push({nome, uf:U, norm:nn, co}); };
  if(db.cidades) for(const k in db.cidades){ add(db.cidades[k].cidade, db.cidades[k].uf); }
  for(const r of (db.rotas||[])){ const tj=r.trajetos||[]; if(!tj.length) continue;
    const t0=tj[0]; add(t0.oNome,t0.oUF); db._hubs.add(normTxt(t0.oNome)+'|'+(t0.oUF||'').toUpperCase());
    const tl=tj[tj.length-1]; add(tl.dNome,tl.dUF); db._hubs.add(normTxt(tl.dNome)+'|'+(tl.dUF||'').toUpperCase()); }
  return db._ancoras;
}
function endpointsComCoords(db, coords){
  if(db._endpoints) return db._endpoints;
  db._endpoints=[];
  if(!db || !coords) return db._endpoints;
  const seen=new Set();
  const add=(nomeBruto,uf)=>{ const U=(uf||'').toUpperCase(); if(!U||!nomeBruto) return;
    const nome=String(nomeBruto).split('/')[0].trim(); const nn=normTxt(nome), key=nn+'|'+U;
    if(seen.has(key)) return; const co=coords[nn+'|'+U]; if(!co) return;
    seen.add(key); db._endpoints.push({nome, uf:U, norm:nn, co}); };
  for(const r of (db.rotas||[])){ const tj=r.trajetos||[]; if(!tj.length) continue;
    add(tj[0].oNome, tj[0].oUF); const tl=tj[tj.length-1]; add(tl.dNome, tl.dUF); }
  return db._endpoints;
}
function ehHub(db, coords, nc, uf){ ancorasFortes(db,coords); return db._hubs && db._hubs.has(nc+'|'+(uf||'').toUpperCase()); }
function cidadeMaisProxima(db, coords, normCidade, uf){
  if(!coords) return null;
  const req=coords[normCidade+'|'+uf]; if(!req) return null;
  let best=null, bestEp=null, bestD=Infinity, bestEpD=Infinity;
  for(const b of basesComCoords(db,coords)){ const dkm=haversine(req,b.co); if(dkm<bestD){ bestD=dkm; best={nome:b.nome, uf:b.uf, dist:Math.round(dkm)}; } }
  for(const e of endpointsComCoords(db,coords)){ const dkm=haversine(req,e.co); if(dkm<bestEpD){ bestEpD=dkm; bestEp={nome:e.nome, uf:e.uf, dist:Math.round(dkm)}; } }
  if(best && bestEp){ return (bestEpD <= bestD + 50) ? bestEp : best; }
  return best || bestEp;
}
function ancoraForteProxima(db, coords, nc, uf, maxKm){
  if(!coords) return null;
  const req=coords[nc+'|'+uf]; if(!req) return null;
  let best=null, bestD=Infinity;
  for(const a of ancorasFortes(db,coords)){ if(a.norm===nc && a.uf===uf) continue;
    const dk=haversine(req,a.co); if(dk<bestD){ bestD=dk; best={nome:a.nome, uf:a.uf, dist:Math.round(dk)}; } }
  return (best && best.dist<=maxKm) ? best : null;
}
function ancoraForteMaisProxima(db, coords, nc, uf){
  if(!coords) return null;
  const req=coords[nc+'|'+uf]; if(!req) return null;
  let best=null, bestD=Infinity;
  for(const a of ancorasFortes(db,coords)){ if(a.norm===nc && a.uf===uf) return {nome:a.nome, uf:a.uf, dist:0};
    const dk=haversine(req,a.co); if(dk<bestD){ bestD=dk; best={nome:a.nome, uf:a.uf, dist:Math.round(dk)}; } }
  return best;
}
function resolverCidade(db, coords, raw){
  const uf=ufTxt(raw).toUpperCase();
  const nc=normTxt(String(raw||'').replace(new RegExp('[\\s/,()\\-]+'+uf+'\\)?\\s*$','i'),'').replace(/[\/,\-\s(]+$/,''));
  if(!nc) return { norm:normTxt(raw), uf, aproximada:false };
  if(!uf || cidadeNaTabela(db,nc,uf)){
    if(uf && cidadeNaTabela(db,nc,uf) && !ehHub(db,coords,nc,uf)){
      const a=ancoraForteProxima(db,coords,nc,uf,25);
      if(a) return { norm:normTxt(a.nome), uf:a.uf, aproximada:true, nome:a.nome, dist:a.dist, original:raw };
    }
    return { norm:nc, uf, aproximada:false };
  }
  const prox=cidadeMaisProxima(db,coords,nc,uf);
  if(!prox) return { norm:nc, uf, aproximada:false };
  return { norm:normTxt(prox.nome), uf:prox.uf, aproximada:true, nome:prox.nome, dist:prox.dist, original:raw };
}

/* ---------------------------------------------------------------------------
   Grafo + geração de opções de rota (verbatim)
   --------------------------------------------------------------------------- */
function crmSeqRota(r){
  const tj=r.trajetos||[]; if(!tj.length) return [];
  const seq=[{norm:tj[0].o, nome:tj[0].oNome, uf:tj[0].oUF}];
  for(const t of tj) seq.push({norm:t.d, nome:t.dNome, uf:t.dUF});
  return seq;
}
let _COORDS_SUB = null;   // coords disponíveis p/ o crmSubTrecho (setado em calcularFreteLead)
function crmSubTrecho(r, isO, isD){
  const tj=r.trajetos||[]; if(!tj.length) return null;
  const seq=[{norm:tj[0].o, nome:tj[0].oNome, uf:tj[0].oUF}];
  for(const t of tj) seq.push({norm:t.d, nome:t.dNome, uf:t.dUF});
  // ORDEM GEOGRÁFICA (distância da origem da rota), não a ordem da planilha — os
  // trajetos podem vir fora de ordem (ex.: numa rota Goiânia→SP, "Uberlândia" listada
  // depois de "Vinhedo"), o que quebrava o subtrecho e forçava reembarque errado.
  const CO = _COORDS_SUB || null;
  const cco = c => CO ? CO[c.norm+'|'+((c.uf||'').toUpperCase())] : null;
  const oco = cco(seq[0]);
  const prog = c => { const cc=cco(c); return (oco&&cc) ? haversine(oco,cc) : null; };
  const oList=[], dList=[];
  for(let i=0;i<seq.length;i++){ const k=nk(seq[i].norm,seq[i].uf); if(isO(k)) oList.push(i); if(isD(k)) dList.push(i); }
  if(!oList.length || !dList.length) return null;
  let iO=-1, iD=-1;
  for(const a of oList){ for(const b of dList){ if(a===b) continue;
    const pA=prog(seq[a]), pB=prog(seq[b]);
    const ordemOK = (pA!=null && pB!=null) ? (pA < pB) : (a < b);
    if(ordemOK){ iO=a; iD=b; break; }
  } if(iO>=0) break; }
  if(iO<0) return null;
  const O=seq[iO], D=seq[iD];
  return { transportadora:r.transportadora, valores:r.valores, prazo:r.prazoDias,
           oNome:O.nome, oUF:O.uf, dNome:D.nome, dUF:D.uf, oN:nk(O.norm,O.uf), dN:nk(D.norm,D.uf) };
}
function crmAdjacencia(db){
  if(db._adj) return db._adj;
  const adj = {};
  for(const r of db.rotas){
    for(const t of (r.trajetos||[])){
      const A=nk(t.o,t.oUF), B=nk(t.d,t.dUF);
      if(!t.o || !t.d || A===B) continue;
      (adj[A] = adj[A] || []).push({
        to:B, oN:A, valores:r.valores, carrier:r.transportadora,
        oNome:t.oNome, dNome:t.dNome, oUF:t.oUF, dUF:t.dUF, prazo:r.prazoDias
      });
    }
  }
  db._adj = adj; return adj;
}
function crmRevAdj(db){
  if(db._radj) return db._radj;
  const r = {};
  for(const rt of db.rotas){
    for(const t of (rt.trajetos||[])){
      const A=nk(t.o,t.oUF), B=nk(t.d,t.dUF);
      if(!t.o || !t.d || A===B) continue;
      (r[B] = r[B] || []).push({
        from:A, valores:rt.valores, carrier:rt.transportadora,
        oNome:t.oNome, dNome:t.dNome, oUF:t.oUF, dUF:t.dUF, prazo:rt.prazoDias
      });
    }
  }
  db._radj = r; return r;
}
function crmArestasDaOrigem(db, oKey){
  const isO = k=> matchKey(k, oKey);
  const CO = _COORDS_SUB || null;
  const out=[];
  for(const r of db.rotas){
    const seq=crmSeqRota(r);
    const cco = c => CO ? CO[c.norm+'|'+((c.uf||'').toUpperCase())] : null;
    const oco = cco(seq[0]);
    const prog = c => { const cc=cco(c); return (oco&&cc) ? haversine(oco,cc) : null; };
    let iO=-1; for(let i=0;i<seq.length;i++){ if(isO(nk(seq[i].norm,seq[i].uf))){ iO=i; break; } }
    if(iO<0) continue;
    const A=seq[iO], Ak=nk(A.norm,A.uf), pA=prog(A);
    // arestas A→B onde B vem DEPOIS de A por ordem GEOGRÁFICA (distância da origem da rota).
    for(let j=0;j<seq.length;j++){ if(j===iO) continue; const B=seq[j], Bk=nk(B.norm,B.uf);
      if(!B.norm || Bk===Ak) continue;
      const pB=prog(B);
      const depois = (pA!=null && pB!=null) ? (pB > pA) : (j > iO);
      if(!depois) continue;
      out.push({ to:Bk, oN:Ak, valores:r.valores, carrier:r.transportadora,
        oNome:A.nome, oUF:A.uf, dNome:B.nome, dUF:B.uf, prazo:r.prazoDias });
    }
  }
  return out;
}
function crmCustoAteDestino(db, cat, isDest){
  const radj = crmRevAdj(db);
  const univ = new Set();
  for(const k in radj){ univ.add(k); for(const e of radj[k]) univ.add(e.from); }
  const custo={}, prox={}, feito={};
  univ.forEach(k=>{ if(isDest(k)) custo[k]=0; });
  let g=0;
  while(g++ < 200000){
    let u=null, best=Infinity;
    for(const k in custo){ if(!feito[k] && custo[k]<best){ best=custo[k]; u=k; } }
    if(u===null) break;
    feito[u]=true;
    for(const e of (radj[u]||[])){
      const p = precoCat(e.valores,cat); if(p==null) continue;
      const nd = custo[u] + p;
      if(custo[e.from]==null || nd < custo[e.from]){
        custo[e.from]=nd;
        prox[e.from]={ to:u, leg:{ transportadora:e.carrier, valor:p, oNome:e.oNome,oUF:e.oUF,dNome:e.dNome,dUF:e.dUF, prazo:e.prazo } };
      }
    }
  }
  return { custo, prox };
}
// Nome da rota = "Cidade (UF) - Cidade (UF)" -> e a VAGA daquele par especifico.
// Devolve true quando o nome da rota casa exatamente com o par pedido (origem e destino).
function rotaNomeadaPar(r, o, d){
  const m = String(r.rota||'').match(/^\s*(.+?)\s*\(\s*([A-Za-z]{2})\s*\)\s*-\s*(.+?)\s*\(\s*([A-Za-z]{2})\s*\)\s*$/);
  if(!m) return false;
  return matchKey(nk(tabNorm(m[1]), m[2].toUpperCase()), o) && matchKey(nk(tabNorm(m[3]), m[4].toUpperCase()), d);
}
function crmGerarOpcoes(db, o, d, cat){
  const isDest = k => matchKey(k, d);
  const isO = k=> matchKey(k, o);
  const preco = r => precoCat(r.valores,cat);
  const catInv = tabNorm(cat);
  const leg = (r,t)=>({ transportadora:r.transportadora, valor:preco(r), valores:r.valores, oNome:t.oNome,oUF:t.oUF,dNome:t.dNome,dUF:t.dUF, oN:nk(t.o,t.oUF),dN:nk(t.d,t.dUF), prazo:r.prazoDias, precoInv:!!(r._precoInv && r._precoInv[catInv]) });
  const diretas=[];
  for(const r of db.rotas){
    const nomeada = rotaNomeadaPar(r, o, d);   // a rota que LEVA O NOME deste par = a vaga certa
    for(const t of (r.trajetos||[])){
      if(matchKey(nk(t.o,t.oUF),o) && matchKey(nk(t.d,t.dUF),d)){ diretas.push({ tipo:'direta', legs:[leg(r,t)], total:preco(r), prazo:r.prazoDias||0, _nomeada:nomeada && preco(r)!=null, _rotaNome:r.rota }); }
    }
  }
  for(const r of db.rotas){
    const s=crmSubTrecho(r,isO,isDest); if(!s) continue;
    const p=precoCat(s.valores,cat); if(p==null) continue;
    diretas.push({ tipo:'direta', legs:[{ transportadora:s.transportadora, valor:p, valores:s.valores, oNome:s.oNome,oUF:s.oUF,dNome:s.dNome,dUF:s.dUF, oN:s.oN,dN:s.dN, prazo:s.prazo, precoInv:!!(r._precoInv && r._precoInv[catInv]) }], total:p, prazo:s.prazo||0, _rotaNome:r.rota });
  }
  // VAGA NOMEADA MANDA: a mesma transportadora costuma ter a rota especifica do par
  // (ex.: "SBC - Foz do Iguacu", R$ 1.200) E uma rota guarda-chuva que lista a mesma cidade
  // como destino de passagem (ex.: "SBC - Medianeira", R$ 1.100). As duas casam o par pedido
  // e a mais barata vencia -> o frete saia abaixo do valor real da vaga. Havendo rota nomeada
  // com preco na categoria, as guarda-chuva DA MESMA transportadora saem da disputa.
  const _comNomeada = new Set(diretas.filter(x=>x._nomeada).map(x=>normTxt(x.legs[0].transportadora)));
  if(_comNomeada.size){   // sem rota nomeada nao ha o que desempatar — nao mexe na lista
    const _filtradas = diretas.filter(x=>x._nomeada || !_comNomeada.has(normTxt(x.legs[0].transportadora)));
    diretas.length=0; diretas.push(..._filtradas);
  }
  const { custo, prox } = crmCustoAteDestino(db, cat, isDest);
  const adj = crmAdjacencia(db);
  const recon = (m)=>{ const path=[]; let cur=m, g=0; while(prox[cur] && g++<15){ path.push(prox[cur].leg); cur=prox[cur].to; if(isDest(cur)) break; } return path; };
  const legB = b => ({ transportadora:b.carrier, valor:precoCat(b.valores,cat), valores:b.valores, oNome:b.oNome,oUF:b.oUF,dNome:b.dNome,dUF:b.dUF, oN:b.oN, dN:b.to, prazo:b.prazo });
  const saemDaOrigem=[];
  for(const k in adj){ if(!matchKey(k,o)) continue; for(const b of adj[k]) saemDaOrigem.push(legB(b)); }
  if(!saemDaOrigem.length){ for(const b of crmArestasDaOrigem(db,o)) saemDaOrigem.push(legB(b)); }
  const combos=[]; const vc=new Set();
  const addCombo = (legs)=>{
    if(!legs.length || legs.some(l=>l.valor==null)) return;
    const seqC=[nk(normTxt(legs[0].oNome),legs[0].oUF)]; for(const l of legs) seqC.push(nk(normTxt(l.dNome),l.dUF));
    if(new Set(seqC).size !== seqC.length) return;
    const sig = legs.map(l=>l.transportadora+'>'+l.dNome+'/'+l.dUF).join('|');
    if(vc.has(sig)) return; vc.add(sig);
    combos.push({ tipo:'combinacao', legs, total:legs.reduce((s,l)=>s+numMoeda(l.valor),0), prazo:legs.reduce((s,l)=>s+(l.prazo||0),0) });
  };
  for(const a of saemDaOrigem){
    if(a.valor==null || isDest(a.dN)) continue;
    if(custo[a.dN]!=null){ addCombo([a].concat(recon(a.dN))); }
    for(const b of (adj[a.dN]||[])){
      if(combos.length>500) break;
      if(precoCat(b.valores,cat)==null || b.to===a.oN || matchKey(b.to,o)) continue;
      if(isDest(b.to)){ addCombo([a, legB(b)]); }
      else if(custo[b.to]!=null){ addCombo([a, legB(b)].concat(recon(b.to))); }
    }
    if(combos.length>500) break;
  }
  const dvist=new Set(); const diretasU=diretas.filter(x=>{ const k=x.legs[0].transportadora+'|'+x.total; if(dvist.has(k))return false; dvist.add(k); return true; });
  diretasU.sort((a,b)=>(a.total==null)-(b.total==null)||(a.total||0)-(b.total||0));
  combos.sort((a,b)=>a.total-b.total);
  const opts = diretasU.concat(combos.slice(0,40));
  return { diretasU, combos, opts };
}
const CRM_TETO = CRM_TETO_DIRETA;
function crmPadraoDireta(barata, menos){
  if(menos && barata && menos.legs.length < barata.legs.length
     && (menos.total??1e12) <= (barata.total??0) + CRM_TETO) return menos;
  return barata;
}

/* ---------------------------------------------------------------------------
   Composição de taxas / valor médio / prazo (verbatim, sem DOM)
   --------------------------------------------------------------------------- */
function crmVeics(l){
  if(!l) return [{}];
  if(!Array.isArray(l.veiculosCalc) || !l.veiculosCalc.length){
    const cat = l.categoria || crmCategoriaSugerida(l);
    const n = Math.max(1, parseInt(l.qtdVeic,10)||1);
    const molde = { modelo:l.veiculoDesc||'', categoria:cat, valor:l.valorVeiculo||'', funciona:l.funciona||'', blindado:l.blindado||'' };
    l.veiculosCalc = Array.from({length:n}, ()=>({...molde}));
  }
  return l.veiculosCalc;
}
function crmValoresOrc(l){
  const comp = l.composicao||[];
  const val = desc => { const c=comp.find(c=>normTxt(c.desc)===normTxt(desc)); return (c && c.ativo)?numMoeda(c.valor):0; };
  const seguro = val('Seguro'), imposto = val('Imposto'), coleta = val('Coleta'), entrega = val('Entrega');
  const excl = ['seguro','imposto','coleta','entrega'];
  const valorFrete = comp.filter(c=>c.ativo && !excl.includes(normTxt(c.desc))).reduce((s,c)=>s+numMoeda(c.valor),0);
  const totalBase = valorFrete + seguro + imposto;
  const totalPorta = totalBase + coleta + entrega;
  return { valorFrete, seguro, imposto, coleta, entrega, totalBase, totalPorta };
}
function crmCompRecalcImposto(l){
  if(!l||!l.composicao) return;
  const imp = l.composicao.find(c=>normTxt(c.desc)==='imposto'); if(!imp) return;
  const base = l.composicao.filter(c=>c.ativo && normTxt(c.desc)!=='imposto').reduce((s,c)=>s+numMoeda(c.valor),0);
  imp.valor = (Math.round(base*IMPOSTO_PCT*100)/100).toString();
}
function segBelemManaus(t){
  const a=normTxt((t.de||'').split('/')[0]), b=normTxt((t.para||'').split('/')[0]);
  return (a==='belem'&&b==='manaus')||(a==='manaus'&&b==='belem');
}
function crmRecalcCalc(l, db){
  if(!l) return;
  const trs = l.trajetos||[];
  const veics = crmVeics(l);
  const q = veics.length;
  let base = 0;
  for(const t of trs){
    if(t.valores){ for(const v of veics){ const p=precoCat(t.valores, v.categoria); base += (p!=null?p:0); } }
    else base += numMoeda(t.valor) * q;
  }
  const txSeg=(o,d)=> (SEGURO_TX[o] && SEGURO_TX[o][d]!=null) ? SEGURO_TX[o][d] : null;
  const seguroVeics=(tx)=>{ let s=0; for(const v of veics){ const vv=numMoeda(v.valor); if(vv) s+=(tx/100)*vv; } return s; };
  let seguro = 0, temUFtrecho=false;
  for(const t of trs){
    const ou = (t.oUF||ufTxt(t.de)).toUpperCase(), du = (t.dUF||ufTxt(t.para)).toUpperCase();
    const tx = txSeg(ou,du);
    if(tx!=null){ temUFtrecho=true; seguro += seguroVeics(tx); }
  }
  if(!temUFtrecho){
    const oUF = ufTxt(l.origem).toUpperCase();
    const dUF = ufTxt(l.destino).toUpperCase();
    const tx = txSeg(oUF,dUF);
    if(tx!=null) seguro = seguroVeics(tx);
  }
  const setComp=(desc,val,ativo)=>{
    let c = l.composicao.find(c=>normTxt(c.desc)===normTxt(desc));
    if(!c){ c={desc, valor:'', ativo:!!ativo, opcional:false}; l.composicao.push(c); }
    c.valor = (val!=null? (Math.round(val*100)/100).toString() : c.valor);
  };
  setComp('Frete Base', base, true);
  setComp('Seguro', seguro, true);
  const prim = trs[0], ult = trs[trs.length-1];
  if((prim||ult) && db && db.cidades){
    const cds = db.cidades;
    const recDe = nome => { const c=cds[normTxt((nome||'').split('/')[0])]; return (c && c.recebimento!=null)?c.recebimento:null; };
    let ro = recDe(prim&&prim.de); if(ro==null) ro = recDe(l.origem);
    let rd = recDe(ult&&ult.para); if(rd==null) rd = recDe(l.destino);
    let recTot=0, achou=false;
    if(ro!=null){ recTot+=ro; achou=true; }
    if(rd!=null){ recTot+=rd; achou=true; }
    if(achou) setComp('Recebimento', recTot * q, true);
  }
  { const rb=l.composicao.find(c=>normTxt(c.desc)==='reembarque');
    if(rb){
      if(trs.length>1){
        rb.ativo=true;
        let reemb=0;
        for(let i=1;i<trs.length;i++){
          const t0=normTxt(trs[i-1].transportadora), t1=normTxt(trs[i].transportadora);
          if(t0 && t1 && t0===t1) continue;
          reemb += (segBelemManaus(trs[i]) || segBelemManaus(trs[i-1])) ? 200 : 100;
        }
        rb.valor = String(reemb * q);
      } else { rb.ativo=false; rb.valor='0'; }
    } }
  { const lc=l.composicao.find(c=>normTxt(c.desc)==='taxa fixa (lucro)');
    if(lc){
      if(l.lucroUnit==null || l.lucroUnit==='') l.lucroUnit = (numMoeda(lc.valor)||500);
      lc.valor = String(Math.round(numMoeda(l.lucroUnit)*q*100)/100);
    } }
  crmCompRecalcImposto(l);
  const V = crmValoresOrc(l);
  l.valorCotacaoSW = V.totalBase ? String(Math.round(V.totalBase*100)/100) : l.valorCotacaoSW;
  if(!l._prazoManual){
    const prazoCalc = (l.trajetos||[]).reduce((s,t)=>s+(parseInt(t.prazo)||0),0);
    if(prazoCalc>0){ l.prazoSW = String(prazoCalc); }
  }
}

/* ---------------------------------------------------------------------------
   Orquestrador (porta crmRecalcularLead) — muta o objeto `l`
   --------------------------------------------------------------------------- */
// ---- Ganchos de base vizinha (port do crmNosProximos/crmColetarOpcoes do app) + ----
// ---- GARANTIA GEOGRÁFICA: a opção só vale se a retirada fica perto da origem E a ----
// ---- entrega perto do destino pedidos (senão o hub trazia rota que nem chega lá). ----
function crmNosProximos(db, coords, nc, uf, maxKm, limite){
  if(!coords) return [];
  const req=coords[nc+'|'+uf]; if(!req) return [];
  const proximos=(lista)=>{ const o=[]; for(const b of lista){ const bn=normTxt(b.nome); if(bn===nc&&b.uf===uf) continue;
      const dk=haversine(req,b.co); if(dk<=maxKm) o.push({ norm:bn, uf:b.uf, nome:b.nome, dist:Math.round(dk) }); }
    o.sort((a,b)=>a.dist-b.dist); return o; };
  const lim=limite||2;
  const hubs = proximos(endpointsComCoords(db,coords)).slice(0, lim);
  const nos  = proximos(basesComCoords(db,coords)).slice(0, lim);
  const seen=new Set(), out=[];
  for(const x of hubs.concat(nos)){ const k=x.norm+'|'+x.uf; if(seen.has(k)) continue; seen.add(k); out.push(x); }
  out.sort((a,b)=>a.dist-b.dist);
  return out;
}
function crmColetarOpcoes(db, coords, oR, dR, cat, oRefCo, dRefCo){
  const KM=42, LIM=2, RAIO=45;
  const oHubs = crmNosProximos(db,coords,oR.norm,oR.uf,KM,LIM);
  const dHubs = crmNosProximos(db,coords,dR.norm,dR.uf,KM,LIM);
  const oCands = [{norm:oR.norm,uf:oR.uf,nome:oR.nome||oR.norm,dist:0}].concat(oHubs);
  const dCands = [{norm:dR.norm,uf:dR.uf,nome:dR.nome||dR.norm,dist:0}].concat(dHubs);
  const seen=new Set(), all=[];
  for(const oc of oCands){ for(const dc of dCands){
    const res = crmGerarOpcoes(db, nk(oc.norm,oc.uf), nk(dc.norm,dc.uf), cat);
    for(const x of res.opts){
      const ult=x.legs[x.legs.length-1];
      const sig = x.legs.map(l=>normTxt(l.transportadora)).join('>')+'|'+normTxt(ult.dNome)+'/'+(ult.dUF||'')+'|'+(x.total==null?'?':x.total);
      if(seen.has(sig)) continue; seen.add(sig);
      all.push(x);
    }
  }}
  // COSTURA VIA SBC (hub central da OBS): embarca na ORIGEM real e transborda em SBC.
  // Cobre o caso em que a origem só ALCANÇA SBC por sub-trecho (Uberlândia via Cegonha/
  // Transprime, que PASSAM por Uberlândia) — o combinador por adjacência só via Myrelle→
  // Betim e desviava por Betim, embarcando fora da origem.
  try{
    const HUB=nk('sao bernardo do campo','SP');
    if(!matchKey(nk(oR.norm,oR.uf),HUB) && !matchKey(nk(dR.norm,dR.uf),HUB)){
      const aa=crmGerarOpcoes(db, nk(oR.norm,oR.uf), HUB, cat).opts.filter(x=>x.total!=null).slice(0,5);
      const bb=crmGerarOpcoes(db, HUB, nk(dR.norm,dR.uf), cat).opts.filter(x=>x.total!=null).slice(0,6);
      for(const a of aa){ for(const b of bb){
        const legs=a.legs.concat(b.legs);
        const seqC=[nk(normTxt(legs[0].oNome),legs[0].oUF)]; for(const l of legs) seqC.push(nk(normTxt(l.dNome),l.dUF));
        if(new Set(seqC).size!==seqC.length) continue;   // sem cidade repetida (loop)
        const sig=legs.map(l=>normTxt(l.transportadora)).join('>')+'|'+normTxt(legs[legs.length-1].dNome)+'/'+(legs[legs.length-1].dUF||'')+'|'+(a.total+b.total);
        if(seen.has(sig)) continue; seen.add(sig);
        all.push({ tipo:'combinacao', legs, total:a.total+b.total, prazo:(a.prazo||0)+(b.prazo||0) });
      }}
    }
  }catch(_){}
  // VAGA NOMEADA MANDA (par REALMENTE pedido): o desempate feito ao gerar as opções só
  // vale para o par exato; as tentativas por cidade VIZINHA escapavam dele. Era assim que
  // a vaga de Foz do Iguaçu (R$ 1.200) perdia para a mesma rota guarda-chuva entregando em
  // Santa Terezinha (R$ 1.100), e a de Marabá (R$ 2.900) para a de Marituba (R$ 2.600).
  // Havendo rota com o nome do par pedido, só ela vale PARA AQUELA transportadora — as
  // outras transportadoras e as combinações seguem disputando pelo mais barato.
  const _nomeadas = new Map();
  { const _oK = nk(oR.norm,oR.uf), _dK = nk(dR.norm,dR.uf);
    for(const r of db.rotas){
      if(!rotaNomeadaPar(r,_oK,_dK) || precoCat(r.valores,cat)==null) continue;
      const k = normTxt(r.transportadora);
      if(!_nomeadas.has(k)) _nomeadas.set(k,new Set());
      _nomeadas.get(k).add(String(r.rota||''));
    } }
  const _all = _nomeadas.size ? all.filter(x=>{
    if(x.legs.length !== 1) return true;                       // combinação não entra no desempate
    const _s = _nomeadas.get(normTxt(x.legs[0].transportadora));
    return !_s || _s.has(String(x._rotaNome||''));
  }) : all;

  // GARANTIA GEOGRÁFICA: a retirada (1º trecho) tem que ficar perto da ORIGEM REAL
  // pedida e a entrega (último trecho) perto do DESTINO REAL — usando as coords da
  // cidade ORIGINAL (oRefCo/dRefCo), NÃO a "encaixada" pela resolverCidade. Sem isto,
  // uma cidade não atendida que encaixa numa base a 100+ km (Viçosa→João Monlevade)
  // passaria batido e mandaria média errada. Sem coordenada de um ponto, não bloqueia.
  const perto=(nomeA,ufA, refCo)=>{
    if(!refCo) return true;
    const a=coords && coords[normTxt(nomeA)+'|'+String(ufA||'').toUpperCase()];
    if(!a) return true;
    return haversine(a,refCo) <= RAIO;
  };
  const coDe=(nome,uf)=> (coords && coords[normTxt(nome)+'|'+String(uf||'').toUpperCase()]) || null;
  const distA=(co,refCo)=> (co&&refCo)?haversine(co,refCo):9999;
  const lista = _all.filter(x=>{
    const f=x.legs[0], u=x.legs[x.legs.length-1];
    return perto(f.oNome,f.oUF, oRefCo) && perto(u.dNome,u.dUF, dRefCo);
  });
  // diretas primeiro; depois preço; EMPATE → embarque mais perto da origem real
  // (prefere embarcar na própria cidade, ex.: Uberlândia, não num hub vizinho como Araguari).
  lista.sort((a,b)=> (a.tipo!=='direta')-(b.tipo!=='direta')
      || (a.total??1e12)-(b.total??1e12)
      || distA(coDe(a.legs[0].oNome,a.legs[0].oUF),oRefCo) - distA(coDe(b.legs[0].oNome,b.legs[0].oUF),oRefCo));
  return lista.slice(0, 60);
}
// coords da cidade ORIGINAL (string crua "Cidade UF") — base da garantia geográfica.
function coordsCidadeRaw(coords, raw){
  if(!coords) return null;
  const uf=ufTxt(raw).toUpperCase();
  const nc=normTxt(String(raw||'').replace(new RegExp('[\\s/,()\\-]+'+uf+'\\)?\\s*$','i'),'').replace(/[\/,\-\s(]+$/,''));
  return coords[nc+'|'+uf] || null;
}
function calcularFreteLead(l, db, coords){
  if(!l || !l.origem || !l.destino) return false;
  if(!db) return false;
  _COORDS_SUB = coords || null;   // habilita ordem geográfica no crmSubTrecho
  let oR=resolverCidade(db,coords,l.origem), dR=resolverCidade(db,coords,l.destino);
  const cat=crmCategoriaSugerida(l);
  const oRefCo=coordsCidadeRaw(coords,l.origem), dRefCo=coordsCidadeRaw(coords,l.destino);
  let opts=crmColetarOpcoes(db, coords, oR, dR, cat, oRefCo, dRefCo);   // exata + hubs, com garantia geográfica vs. origem/destino REAIS
  if(!opts.length){
    const of=ancoraForteMaisProxima(db,coords,oR.norm,oR.uf), df=ancoraForteMaisProxima(db,coords,dR.norm,dR.uf);
    if(of) oR={norm:normTxt(of.nome),uf:of.uf,aproximada:true,nome:of.nome,dist:of.dist};
    if(df) dR={norm:normTxt(df.nome),uf:df.uf,aproximada:true,nome:df.nome,dist:df.dist};
    opts=crmGerarOpcoes(db, nk(oR.norm,oR.uf), nk(dR.norm,dR.uf), cat).opts;
  }
  if(!opts.length){ l.trajetos=[]; l.valorCotacaoSW=''; l.valorEstimado=''; l.prazoSW=''; return false; }
  // Só considera opções com PREÇO para a categoria do veículo (todas as pernas com valor).
  // Uma rota que EXISTE mas não tem preço p/ a categoria (ex.: moto numa rota só de carro —
  // caso Kroth Caxias→SP) NÃO pode virar média: sem esse filtro o Frete Base ia a 0 e a
  // composição (seguro+lucro+imposto) ainda gerava um total > 0 → média ERRADA ao cliente.
  // Filtrando aqui, essa rota vira "sem rota automática" → atenção humana (orçamento manual).
  const comPreco = opts.filter(o => o.total!=null && o.legs.every(g=>g.valor!=null));
  if(!comPreco.length){ l.trajetos=[]; l.valorCotacaoSW=''; l.valorEstimado=''; l.prazoSW=''; return false; }
  const barata=comPreco.slice().sort((a,b)=>(a.total??1e12)-(b.total??1e12)||a.legs.length-b.legs.length)[0];
  const menos =comPreco.slice().sort((a,b)=>(a.legs.length-b.legs.length)||(a.total??1e12)-(b.total??1e12))[0];
  const escolhida = crmPadraoDireta(barata, menos);
  l.trajetos=escolhida.legs.map(g=>({ de:`${g.oNome}/${g.oUF}`, para:`${g.dNome}/${g.dUF}`,
    transportadora:g.transportadora, valor:g.valor!=null?String(g.valor):'', valores:g.valores||null, oUF:g.oUF, dUF:g.dUF, prazo:g.prazo||null }));
  l.composicao=CRM_COMP_MODELO.map(c=>({...c}));
  l._prazoManual=false;
  crmRecalcCalc(l, db);
  l.valorEstimado = l.valorCotacaoSW || '';
  return true;
}

/* ---------------------------------------------------------------------------
   Carregamento da tabela (Firestore → fallback arquivo) e coordenadas
   --------------------------------------------------------------------------- */
let CIDADES_COORDS = null;
let TABELA_CACHE = null, TABELA_CACHE_AT = 0;
const TABELA_TTL_MS = 5 * 60 * 1000;   // recarrega a cada 5 min (pega o import novo da planilha)

function carregarCoords(){
  if(CIDADES_COORDS) return CIDADES_COORDS;
  try { CIDADES_COORDS = JSON.parse(fs.readFileSync(path.join(__dirname,'cidades-coords.json'),'utf8')); }
  catch(e){ console.error('[calc-fretes] falha ao ler cidades-coords.json:', e.message); CIDADES_COORDS = {}; }
  return CIDADES_COORDS;
}
async function carregarTabela(){
  if(TABELA_CACHE && (Date.now() - TABELA_CACHE_AT) < TABELA_TTL_MS) return TABELA_CACHE;
  let db = null;
  const USAR_PG = process.env.OBS_USAR_PG === 'true' || process.env.OBS_USAR_PG === '1';
  // 1) tabela fretes/_tabela (a MESMA que o admin importa da planilha).
  //    Com a chave OBS_USAR_PG ligada, lê do PostgreSQL; senão, do Firestore.
  try {
    let getDoc;
    if(USAR_PG){ const { pgDb } = require('./pg-api'); getDoc = (id) => pgDb.collection('fretes').doc(id).get(); }
    else { const fsx = getFirestore(); getDoc = (id) => fsx.collection('fretes').doc(id).get(); }
    const snap = await getDoc('_tabela');
    if(snap.exists && snap.data() && snap.data().data){
      const d = snap.data(); let raw = d.data; const partes = d.partes || 1;
      for(let i=1;i<partes;i++){ const sp = await getDoc('_tabela_p'+i); if(sp.exists && sp.data() && sp.data().data) raw += sp.data().data; }
      if(d.comp === 'gz'){ raw = zlib.gunzipSync(Buffer.from(raw, 'base64')).toString('utf8'); }
      if(raw) db = JSON.parse(raw);
    }
  } catch(e){ console.warn('[calc-fretes] tabela _tabela indisponível, tentando arquivo local:', e.message); }
  // 2) fallback: arquivo empacotado
  if(!db){
    try { db = JSON.parse(fs.readFileSync(path.join(__dirname,'tabela-fretes.json'),'utf8')); }
    catch(e){ console.error('[calc-fretes] falha ao ler tabela-fretes.json:', e.message); return null; }
  }
  db = crmPreencherInversos(_repararRotasTabela(db));
  TABELA_CACHE = db; TABELA_CACHE_AT = Date.now();
  return db;
}

/* ---------------------------------------------------------------------------
   API pública: calcularFrete({origem, destino, categoria, valorVeiculo, ...})
   Retorna { ok, valorEstimado, prazoSW, trajetos, composicao } — mesmos números
   que o app calcularia para o mesmo lead.
   --------------------------------------------------------------------------- */
async function calcularFrete(dados){
  const db = await carregarTabela();
  const coords = carregarCoords();
  if(!db) return { ok:false, motivo:'tabela_indisponivel' };
  const l = {
    origem: dados.origem,
    destino: dados.destino,
    categoria: dados.categoria || '',
    veiculoDesc: dados.veiculoDesc || '',
    valorVeiculo: dados.valorVeiculo != null ? String(dados.valorVeiculo) : '',
    funciona: dados.funciona || '',
    blindado: dados.blindado || '',
    qtdVeic: dados.qtdVeic || 1,
  };
  const ok = calcularFreteLead(l, db, coords);
  if(!ok || !(numMoeda(l.valorCotacaoSW) > 0)) return { ok:false, motivo:'sem_rota_automatica' };
  return {
    ok: true,
    valorEstimado: l.valorCotacaoSW,
    valorCotacaoSW: l.valorCotacaoSW,
    prazoSW: l.prazoSW || '',
    trajetos: l.trajetos || [],
    composicao: l.composicao || [],
  };
}

module.exports = { calcularFrete, _internos: { normTxt, numMoeda, calcularFreteLead, carregarTabela, carregarCoords } };
