/* ===========================================================================
 *  ATUALIZAÇÃO DE PREÇOS na tabela de fretes (fretes/_tabela do Postgres).
 *
 *  Existe porque a transportadora manda o reajuste em PDF/print e o app só
 *  importa .xlsx — e a importação SUBSTITUI a tabela inteira (risco de perder
 *  as outras rotas). Aqui a alteração é cirúrgica: só as rotas listadas em
 *  REAJUSTES mudam; todo o resto fica intacto.
 *
 *  Uso — COPIE para /opt/obs-api antes de rodar: o Node procura os módulos
 *  (pg, dotenv) na pasta do ARQUIVO, não na pasta em que você está.
 *     cp ~/obs-repo/servidor-obs/atualizar-tabela-precos.mjs /opt/obs-api/
 *     cd /opt/obs-api
 *     node atualizar-tabela-precos.mjs              # DRY-RUN: mostra "de → para", NÃO grava
 *     node atualizar-tabela-precos.mjs --aplicar    # grava (faz BACKUP antes)
 *
 *  O backup sai em /root/backup-tabela-<timestamp>.json (a tabela inteira,
 *  descomprimida). Para reverter: node atualizar-tabela-precos.mjs --restaurar <arquivo>
 *
 *  ⚠️ Se alguém reimportar a planilha .xlsx pelo app depois disto, a planilha
 *  vence e o reajuste se perde — atualize a planilha-mestre também.
 * ===========================================================================*/
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import pg from 'pg';

const d = await import('dotenv');
d.config({ path: '/etc/obs-db/.env', quiet: true });

const APLICAR = process.argv.includes('--aplicar');
// Reduzir preco de venda quase nunca e a intencao de um "reajuste": o PDF traz um
// RETORNO unico por regiao, mas algumas cidades tem retorno mais caro cadastrado de
// proposito. Por padrao essas quedas ficam de fora e sao listadas a parte.
const PERMITIR_REDUCAO = process.argv.includes('--permitir-reducao');
const RESTAURAR = process.argv.includes('--restaurar') ? process.argv[process.argv.indexOf('--restaurar') + 1] : null;

/* --------------------------------------------------------------------------
 *  REAJUSTES — o que muda. Uma entrada por transportadora.
 *  `rotas`: nome da cidade (como está no nome da rota do sistema) → preços.
 *    ida    = São Bernardo do Campo → cidade
 *    volta  = cidade → São Bernardo do Campo   (omitir = não mexe na volta)
 *  Categorias: p = Carro Passeio · g = Carro Grande · m300/m700/m700+ = motos.
 *  Omitir uma categoria = mantém o valor atual.
 *
 *  FMartins — tabela recebida em 04/09/2026 (vigência 01/09). Nordeste: +R$ 150
 *  nas idas; retornos e motos seguem iguais aos que já estão cadastrados.
 * ------------------------------------------------------------------------ */
/* ⚠️ ESVAZIADO EM 11/09/2026. O bloco do reajuste FMartins de 04/09 já foi
   aplicado em produção; deixá-lo aqui só gera ruído no dry-run (e reaplicaria
   tudo se alguém rodasse contra uma tabela antiga). O conteúdo está no histórico
   do git, em `git log -p servidor-obs/atualizar-tabela-precos.mjs`. */
const REAJUSTES = [];


/* --------------------------------------------------------------------------
 *  PRECOS_ROTA — reajuste avulso, apontando a rota pelo nome exato.
 *  (o bloco REAJUSTES acima e para tabela inteira de uma transportadora)
 * ------------------------------------------------------------------------ */
const PRECOS_ROTA = [
  /* (entradas de 25/08 e 31/08 removidas — já aplicadas em produção) */
  /* ---- Relatório do grupo TREINAMENTO IA, item 4 (09/09/2026) ----
     Emerson = IDEAL TRANSPORTES 2. O comercial pediu carro pequeno 2.900 e
     "carro grande e SUV" 3.000. Carro Grande JÁ está 3.000 na tabela, então só o
     Carro Passeio muda (2.800 → 2.900).
     ⚠️ A mesma transportadora tem "Brasília (DF) - São Luís (MA)" também a 2.800.
        O relatório só citou Goiânia → São Luís; Brasília fica como está até o
        comercial confirmar se subiu junto. */
  { transportadora:/ideal transportes 2/i, rota:'Goiânia (GO) - São Luís (MA)',
    valores:{ p:2900 }, fonte:'reporte do comercial 09/09/2026 (Emerson)' },

  /* ---- Relatório do grupo TREINAMENTO IA, item 3 (08/09/2026) ----
     "Moto P com a Angela: R$ 500 → R$ 700". Angela = TRANSVELLA (confirmado pelo
     Luiz em 11/09; o relatório usa o nome da pessoa, a tabela o da empresa).
     A Transvella só tem estas duas rotas, e as DUAS estão com moto a R$ 500 —
     por isso as duas sobem. O relatório não separou sentido.
     ⚠️ Se o reajuste valer só num sentido, apagar a linha que não vale. */
  { transportadora:/transvella/i, rota:'São Bernardo do Campo (SP) - Serra (ES)',
    valores:{ m300:700 }, fonte:'reporte do comercial 08/09/2026 (Angela = Transvella)' },
  { transportadora:/transvella/i, rota:'Serra (ES) - São Bernardo do Campo (SP)',
    valores:{ m300:700 }, fonte:'reporte do comercial 08/09/2026 (Angela = Transvella)' },
];


/* --------------------------------------------------------------------------
 *  NOVAS_ROTAS — vaga que existe na operação mas não estava na tabela.
 *  Sem ela o motor monta o trecho a partir de uma rota que só PASSA pela
 *  cidade e cobra o preço daquela rota (o caso Uberlândia→Betim: saía R$ 400,
 *  o preço da rota Goiânia→Betim, em vez dos R$ 500 da vaga real).
 *  Informe só as categorias que a transportadora realmente atende: categoria
 *  sem preço aqui continua sendo cotada como antes.
 * ------------------------------------------------------------------------ */
const NOVAS_ROTAS = [
  /* (entrada Militão de 25/08 removida — já aplicada em produção) */
  /* ---- Relatório do grupo TREINAMENTO IA, item 6 (11/09/2026) ----
     Sydnei, João Pessoa × Campina Grande. Os valores valem IDA E VOLTA, por isso
     as duas rotas com os mesmos preços.
     ⚠️ O relatório diz "carro passeio / veículo pequeno E MOTO: R$ 600" sem dizer
        a cilindrada. Cadastrado em "Moto até 300cc". Se a vaga também leva moto
        acima de 300cc, acrescentar m700 e 'm700+' aqui.
     ⚠️ Prazo não informado (item 8 do relatório está aguardando o prestador):
        prazoDias fica null e o motor soma 0 dia neste trecho. */
  { transportadora:/sydnei|sidnei/i, nomeSeNova:'Sydnei Transportes',
    rota:'João Pessoa (PB) - Campina Grande (PB)',
    valores:{ p:600, g:700, m300:600 },
    trechos:[['João Pessoa','PB','Campina Grande','PB']],
    fonte:'vaga passada pelo comercial 11/09/2026' },
  { transportadora:/sydnei|sidnei/i, nomeSeNova:'Sydnei Transportes',
    rota:'Campina Grande (PB) - João Pessoa (PB)',
    valores:{ p:600, g:700, m300:600 },
    trechos:[['Campina Grande','PB','João Pessoa','PB']],
    fonte:'vaga passada pelo comercial 11/09/2026 (mesmo valor ida e volta)' },

  /* ---- Relatório do grupo TREINAMENTO IA, item 2 (08/09/2026) ----
     "Vaga rota Caruaru/PE — Advaldo, carro pequeno: R$ 2.000 → R$ 1.900."
     Caruaru não tinha vaga própria: era só um trajeto da rota "SBC - Natal" e
     herdava o preço dela. Com a rota nomeada, o desempate do `rotaNomeadaPar`
     faz o par SBC→Caruaru usar esta vaga.
     ✔ SÓ Carro Passeio de propósito, e isso é SEGURO: `_nomeada` exige que a rota
       tenha preço NAQUELA categoria (`preco(r)!=null`), então Carro Grande e moto
       seguem cotando como hoje. Medido em 11/09 — passeio 2.000 (Kroth) → 1.900
       (Advaldo); grande 2.100 e moto 800 sem mudança. */
  { transportadora:/advaldo/i, nomeSeNova:'Advaldo Transportes',
    rota:'São Bernardo do Campo (SP) - Caruaru (PE)',
    valores:{ p:1900 },
    trechos:[['São Bernardo do Campo','SP','Caruaru','PE']],
    fonte:'reporte do comercial 08/09/2026' },
];

/* --------------------------------------------------------------------------
 *  BASES — taxa de recebimento por cidade (cobrada na base de origem E na de
 *  destino). Vem da aba Configurações da planilha.
 * ------------------------------------------------------------------------ */
/* ⚠️ ESVAZIADO EM 11/09/2026 — bases TRANSPADRE de 27/08 já aplicado em produção. */
const BASES = [];

/* --------------------------------------------------------------------------
 *  TRECHOS — cidades que a rota atende mas que não estavam na lista de
 *  trajetos. Sem o trecho, o motor não enxerga a vaga e o comercial não
 *  consegue cotar. O preço é o da rota (por isso a cidade tem que ter mesmo
 *  o mesmo valor da rota — senão ela precisa de rota própria).
 * ------------------------------------------------------------------------ */
/* ⚠️ ESVAZIADO EM 11/09/2026 — trechos FMartins de 04/09 já aplicado em produção. */
const TRECHOS = [];

/* --------------------------------------------------------------------------
 *  REMOVER_TRECHOS — o oposto de TRECHOS: tira da rota uma cidade que ela NÃO
 *  atende. Enquanto o trecho errado existe, o motor oferece uma vaga que não
 *  existe e o comercial só descobre ao tentar embarcar.
 * ------------------------------------------------------------------------ */
const REMOVER_TRECHOS = [
  /* ---- Relatório do grupo TREINAMENTO IA, item 1 (04/09/2026) ----
     "Docarmo não passa em Brasília, somente Goiânia." Brasília aparece nos
     trajetos das duas rotas SBC ↔ São Luís. Goiânia não está lá e continua fora —
     se a Docarmo atende Goiânia nessa rota, é um TRECHOS a acrescentar depois. */
  { transportadora:/docarmo/i, rota:'São Bernardo do Campo (SP) - São Luís (MA)',
    remover:[['Brasília','DF']], fonte:'reporte do comercial 04/09/2026' },
  { transportadora:/docarmo/i, rota:'São Luís (MA) - São Bernardo do Campo (SP)',
    remover:[['Brasília','DF']], fonte:'reporte do comercial 04/09/2026' },
];

/* Categorias como estão cadastradas na tabela (a busca é tolerante a acento/caixa). */
const CATS = { p:'Carro Passeio', g:'Carro Grande', m300:'Moto até 300cc', m700:'Moto até 700cc', 'm700+':'Moto acima de 700cc' };
const norm = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
/* Nome da rota no sistema: "Cidade (UF) - Cidade (UF)" */
const tabNorm = s => String(s||'').replace(/\u00a0/g,' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
const parNome = r => { const m=String(r.rota||'').match(/^\s*(.+?)\s*\(([A-Za-z]{2})\)\s*-\s*(.+?)\s*\(([A-Za-z]{2})\)\s*$/); return m?{o:m[1].trim(),oUF:m[2],d:m[3].trim(),dUF:m[4]}:null; };

const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

async function lerTabela(){
  const { rows } = await pool.query("SELECT data FROM fretes WHERE id='_tabela'");
  if(!rows.length) throw new Error('fretes/_tabela não encontrada no banco.');
  const d0 = rows[0].data;
  let raw = d0.data; const partes = d0.partes || 1;
  for(let i=1;i<partes;i++){
    const r2 = await pool.query('SELECT data FROM fretes WHERE id=$1', ['_tabela_p'+i]);
    if(r2.rows.length && r2.rows[0].data && r2.rows[0].data.data) raw += r2.rows[0].data.data;
  }
  const json = d0.comp === 'gz' ? gunzipSync(Buffer.from(raw,'base64')).toString() : raw;
  return { tabela: JSON.parse(json), meta: { em:d0.em, rotas:d0.rotas, cidades:d0.cidades, comp:d0.comp, partes } };
}

async function gravarTabela(tabela){
  const str = JSON.stringify(tabela);
  const b64 = gzipSync(Buffer.from(str)).toString('base64');
  if(b64.length >= 950000) throw new Error('tabela comprimida passou de 950 KB — publique pelo app (ele quebra em partes).');
  const doc = { data:b64, comp:'gz', partes:1, em:new Date().toISOString(), rotas:tabela.rotas.length, cidades:Object.keys(tabela.cidades||{}).length };
  await pool.query("UPDATE fretes SET data=$1, updated_at=now() WHERE id='_tabela'", [JSON.stringify(doc)]);
  // pedaços antigos (de uma publicação sem compressão) deixariam lixo — some com eles
  await pool.query("DELETE FROM fretes WHERE id LIKE '\\_tabela\\_p%'");
  return doc;
}

/* ---------------------------------------------------------------------- */
if(RESTAURAR){
  const tabela = JSON.parse(readFileSync(RESTAURAR,'utf8'));
  if(!tabela.rotas || !tabela.rotas.length) throw new Error('backup inválido (sem rotas).');
  if(!APLICAR){ console.log(`Backup lido: ${tabela.rotas.length} rotas. Rode com --aplicar para restaurar.`); process.exit(0); }
  const doc = await gravarTabela(tabela);
  console.log(`✔ Tabela restaurada de ${RESTAURAR}: ${doc.rotas} rotas.`);
  await pool.end(); process.exit(0);
}

const { tabela, meta } = await lerTabela();
console.log(`Tabela atual: ${tabela.rotas.length} rotas · publicada em ${meta.em}\n`);

const mudancas = [];
const reducoes = [];
const naoAchadas = [];

for(const grupo of REAJUSTES){
  const daTransp = tabela.rotas.filter(r => grupo.transportadora.test(r.transportadora||''));
  console.log(`── ${daTransp.length ? daTransp[0].transportadora : '(transportadora não encontrada)'} — ${grupo.fonte}`);
  for(const [cidade, alvo] of Object.entries(grupo.rotas)){
    for(const [sentido, precos] of Object.entries(alvo)){
      const [de, para] = sentido === 'ida' ? [grupo.origem, cidade] : [cidade, grupo.origem];
      const rota = daTransp.find(r => { const p=parNome(r); return p && norm(p.o)===norm(de) && norm(p.d)===norm(para); });
      if(!rota){ naoAchadas.push(`${de} → ${para}`); continue; }
      for(const [chave, valor] of Object.entries(precos)){
        const nomeCat = CATS[chave]; if(!nomeCat) continue;
        // acha a categoria como ela está escrita na tabela (acento/caixa podem variar)
        const catReal = Object.keys(rota.valores||{}).find(k => norm(k) === norm(nomeCat));
        const atual = catReal != null ? rota.valores[catReal] : undefined;
        if(Number(atual) === Number(valor)) continue;                 // já está certo
        const item = { rota, cat: catReal || nomeCat, de: atual, para: valor,
                       txt: `${rota.rota} · ${nomeCat}: ${atual==null?'(sem valor)':'R$ '+atual} → R$ ${valor}` };
        if(atual != null && Number(valor) < Number(atual) && !PERMITIR_REDUCAO) reducoes.push(item);
        else mudancas.push(item);
      }
    }
  }
}


/* ---- PRECOS_ROTA: reajuste avulso por nome de rota ---- */
for(const item of PRECOS_ROTA){
  const rota = tabela.rotas.find(r => item.transportadora.test(r.transportadora||'') && norm(r.rota)===norm(item.rota));
  if(!rota){ naoAchadas.push(`${item.rota} [${String(item.transportadora)}] — rota não existe na tabela`); continue; }
  for(const [chave, valor] of Object.entries(item.valores)){
    const nomeCat = CATS[chave]; if(!nomeCat) continue;
    const catReal = Object.keys(rota.valores||{}).find(k => norm(k) === norm(nomeCat));
    const atual = catReal != null ? rota.valores[catReal] : undefined;
    if(Number(atual) === Number(valor)) continue;
    const it = { rota, cat: catReal || nomeCat, de: atual, para: valor,
                 txt: `${rota.transportadora} · ${rota.rota} · ${nomeCat}: ${atual==null?'(sem valor)':'R$ '+atual} → R$ ${valor}` };
    if(atual != null && Number(valor) < Number(atual) && !PERMITIR_REDUCAO) reducoes.push(it); else mudancas.push(it);
  }
}


/* ---- NOVAS_ROTAS: cria a vaga que faltava ---- */
const rotasNovas = [];
for(const n of NOVAS_ROTAS){
  const jaExiste = tabela.rotas.find(r => n.transportadora.test(r.transportadora||'') && norm(r.rota)===norm(n.rota));
  if(jaExiste){
    // já existe: vira ajuste de preço normal
    for(const [chave, valor] of Object.entries(n.valores)){
      const nomeCat = CATS[chave]; if(!nomeCat) continue;
      const catReal = Object.keys(jaExiste.valores||{}).find(k => norm(k) === norm(nomeCat));
      const atual = catReal != null ? jaExiste.valores[catReal] : undefined;
      if(Number(atual) === Number(valor)) continue;
      const it = { rota:jaExiste, cat: catReal || nomeCat, de: atual, para: valor,
                   txt: `${jaExiste.transportadora} · ${jaExiste.rota} · ${nomeCat}: ${atual==null?'(sem valor)':'R$ '+atual} → R$ ${valor}` };
      if(atual != null && Number(valor) < Number(atual) && !PERMITIR_REDUCAO) reducoes.push(it); else mudancas.push(it);
    }
    continue;
  }
  // nome da transportadora como ela já está escrita na tabela (evita duplicar por grafia)
  const existente = tabela.rotas.find(r => n.transportadora.test(r.transportadora||''));
  const transp = existente ? existente.transportadora : n.nomeSeNova;
  if(!transp){ naoAchadas.push(`${n.rota} — transportadora não encontrada e sem nomeSeNova`); continue; }
  const valores = {};
  for(const [chave, valor] of Object.entries(n.valores)){ const c = CATS[chave]; if(c) valores[c] = valor; }
  const trajetos = (n.trechos||[]).map(([oc,ou,dc,du]) => ({ o:tabNorm(oc), oUF:ou, d:tabNorm(dc), dUF:du, oNome:oc, dNome:dc }));
  const nova = { transportadora:transp, rota:n.rota, prazoDias:n.prazoDias!=null?n.prazoDias:null, valores, trajetos };
  rotasNovas.push({ nova, txt: `${transp} · ${n.rota} · ${Object.entries(valores).map(([k,v])=>k+' R$ '+v).join(' · ')} · ${trajetos.length} trecho(s)` });
}

/* ---- BASES: taxa de recebimento por cidade ---- */
const basesMud = [];
for(const b of BASES){
  const chave = Object.keys(tabela.cidades||{}).find(k => norm(k) === norm(b.cidade));
  if(!chave){ naoAchadas.push(`base ${b.cidade}/${b.uf} — cidade não cadastrada`); continue; }
  const c = tabela.cidades[chave];
  for(const campo of ['recebimento','coletaEntrega']){
    if(b[campo] == null) continue;
    if(Number(c[campo]) === Number(b[campo])) continue;
    const it = { base:c, campo, de:c[campo], para:b[campo],
                 txt: `base ${c.cidade}/${c.uf} · ${campo}: ${c[campo]==null?'(sem valor)':'R$ '+c[campo]} → R$ ${b[campo]}` };
    if(c[campo] != null && Number(b[campo]) < Number(c[campo]) && !PERMITIR_REDUCAO) reducoes.push(it); else basesMud.push(it);
  }
}

/* ---- TRECHOS: cidades atendidas que faltavam na rota ---- */
const trechosMud = [];
for(const t of TRECHOS){
  const rota = tabela.rotas.find(r => t.transportadora.test(r.transportadora||'') && norm(r.rota)===norm(t.rota));
  if(!rota){ naoAchadas.push(`${t.rota} — rota não existe (trechos não incluídos)`); continue; }
  const p = parNome(rota); if(!p) continue;
  rota.trajetos = rota.trajetos || [];
  for(const [sentido, lista] of [['ida', t.ida||[]], ['volta', t.volta||[]]]){
    for(const [cidade, uf] of lista){
      // ida: base da rota → cidade | volta: cidade → base da rota
      const novo = sentido==='ida'
        ? { o:tabNorm(p.o), oUF:p.oUF, d:tabNorm(cidade), dUF:uf, oNome:p.o, dNome:cidade }
        : { o:tabNorm(cidade), oUF:uf, d:tabNorm(p.d), dUF:p.dUF, oNome:cidade, dNome:p.d };
      const existe = rota.trajetos.some(j => tabNorm(j.o)===novo.o && (j.oUF||'')===novo.oUF && tabNorm(j.d)===novo.d && (j.dUF||'')===novo.dUF);
      if(existe) continue;
      trechosMud.push({ rota, trecho:novo,
        txt: `${rota.transportadora} · ${rota.rota} · NOVO trecho: ${novo.oNome}/${novo.oUF} → ${novo.dNome}/${novo.dUF}` });
    }
  }
}

/* ---- REMOVER_TRECHOS: cidade que a rota NÃO atende ---- */
const trechosFora = [];
for(const t of REMOVER_TRECHOS){
  const rota = tabela.rotas.find(r => t.transportadora.test(r.transportadora||'') && norm(r.rota)===norm(t.rota));
  if(!rota){ naoAchadas.push(`${t.rota} — rota não existe (remoção de trecho ignorada)`); continue; }
  for(const [cidade, uf] of (t.remover||[])){
    // casa nos DOIS sentidos: a cidade pode estar como origem ou como destino do trecho
    const achados = (rota.trajetos||[]).filter(j =>
      (tabNorm(j.oNome||j.o)===tabNorm(cidade) && norm(j.oUF||'')===norm(uf)) ||
      (tabNorm(j.dNome||j.d)===tabNorm(cidade) && norm(j.dUF||'')===norm(uf)));
    if(!achados.length){ naoAchadas.push(`${rota.rota} — ${cidade}/${uf} já não está nos trajetos`); continue; }
    for(const j of achados){
      trechosFora.push({ rota, trecho:j,
        txt: `${rota.transportadora} · ${rota.rota} · REMOVER trecho: ${(j.oNome||j.o)}/${j.oUF||'?'} → ${(j.dNome||j.d)}/${j.dUF||'?'}` });
    }
  }
}
if(trechosFora.length){
  console.log(`\n${trechosFora.length} trecho(s) a REMOVER (rota não atende a cidade):`);
  trechosFora.forEach(m => console.log('   ·', m.txt));
}

if(naoAchadas.length){
  console.log(`\n⚠️  ${naoAchadas.length} rota(s) do reajuste NÃO existem na tabela (nada foi feito nelas):`);
  naoAchadas.forEach(t => console.log('   ·', t));
}

if(reducoes.length){
  console.log(`\n⛔ ${reducoes.length} valor(es) DIMINUIRIAM e foram deixados de fora:`);
  reducoes.forEach(m => console.log('   ·', m.txt));
  console.log('   (confirme com a transportadora; para aplicar mesmo assim: --permitir-reducao)');
}

if(basesMud.length){
  console.log(`\n${basesMud.length} taxa(s) de base a alterar:`);
  basesMud.forEach(m => console.log('   ·', m.txt));
}
if(rotasNovas.length){
  console.log(`\n${rotasNovas.length} rota(s) NOVA(s) a criar:`);
  rotasNovas.forEach(m => console.log('   ·', m.txt));
}
if(trechosMud.length){
  console.log(`\n${trechosMud.length} trecho(s) a incluir (cidades que a rota atende):`);
  trechosMud.forEach(m => console.log('   ·', m.txt));
}

if(!mudancas.length && !basesMud.length && !trechosMud.length && !rotasNovas.length && !trechosFora.length){
  console.log('\n✔ Nada a mudar — a tabela já está com os valores do reajuste.');
  await pool.end(); process.exit(0);
}

if(mudancas.length){
  console.log(`\n${mudancas.length} valor(es) de rota a alterar:`);
  mudancas.forEach(m => console.log('   ·', m.txt));
}

if(!APLICAR){
  console.log('\nDRY-RUN — nada foi gravado. Confira a lista acima e rode de novo com --aplicar.');
  await pool.end(); process.exit(0);
}

const arqBackup = `/root/backup-tabela-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
writeFileSync(arqBackup, JSON.stringify(tabela));
console.log(`\nBackup salvo em ${arqBackup}`);

for(const m of mudancas){ m.rota.valores[m.cat] = m.para; }
for(const m of basesMud){ m.base[m.campo] = m.para; }
for(const m of trechosMud){ m.rota.trajetos.push(m.trecho); }
// remoção por identidade do objeto — não por índice, que muda a cada splice
for(const m of trechosFora){ const i = m.rota.trajetos.indexOf(m.trecho); if(i>=0) m.rota.trajetos.splice(i,1); }
for(const m of rotasNovas){ tabela.rotas.push(m.nova); }
const doc = await gravarTabela(tabela);
console.log(`✔ Tabela atualizada: ${mudancas.length} valores, ${basesMud.length} bases, ${trechosMud.length} trechos incluídos, ${trechosFora.length} removidos e ${rotasNovas.length} rota(s) nova(s) — ${doc.rotas} rotas no total. Publicada em ${doc.em}.`);
console.log('   Os operadores pegam a tabela nova ao recarregar a página (Ctrl+Shift+R).');
console.log(`   Reverter: node atualizar-tabela-precos.mjs --restaurar ${arqBackup} --aplicar`);
await pool.end();
