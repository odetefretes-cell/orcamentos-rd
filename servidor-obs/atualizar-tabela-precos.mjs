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
const REAJUSTES = [
  {
    transportadora: /martins/i,
    origem: 'São Bernardo do Campo',
    fonte: 'PDF TABELA DE FRETE ANUAL — recebido 04/09/2026, vigência 01/09',
    rotas: {
      // --- Nordeste / Litoral (retorno 1.050/1.150 em todas) ---
      'Aracaju':                 { ida:{p:2300,g:2500}, volta:{p:1050,g:1150} },
      'Maceió':                  { ida:{p:2300,g:2500}, volta:{p:1050,g:1150} },
      'Recife':                  { ida:{p:2300,g:2500}, volta:{p:1050,g:1150} },
      'Garanhuns':               { ida:{p:2400,g:2550}, volta:{p:1050,g:1150} },
      'Arapiraca':               { ida:{p:2400,g:2550}, volta:{p:1050,g:1150} },
      'Caruaru':                 { ida:{p:2400,g:2550}, volta:{p:1050,g:1150} },
      'João Pessoa':             { ida:{p:2400,g:2550}, volta:{p:1050,g:1150} },
      'Natal':                   { ida:{p:2400,g:2550}, volta:{p:1050,g:1150} },
      'Juazeiro do Norte':       { ida:{p:2550,g:2700}, volta:{p:1050,g:1150} },
      'Cajazeiras':              { ida:{p:2550,g:2700}, volta:{p:1050,g:1150} },
      'Mossoró':                 { ida:{p:2550,g:2700}, volta:{p:1050,g:1150} },
      'Fortaleza':               { ida:{p:2500,g:2650}, volta:{p:1050,g:1150} },
      'Petrolina':               { ida:{p:2500,g:2650}, volta:{p:1050,g:1150} },
      'Barreiras':               { ida:{p:2500,g:2650}, volta:{p:1050,g:1150} },
      'Luís Eduardo Magalhães':  { ida:{p:2500,g:2650}, volta:{p:1050,g:1150} },
      'Canto do Buriti':         { ida:{p:2500,g:2650}, volta:{p:1050,g:1150} },
      'Bom Jesus':               { ida:{p:2500,g:2650}, volta:{p:1050,g:1150} },
      'Floriano':                { ida:{p:2500,g:2650}, volta:{p:1050,g:1150} },
      'Teresina':                { ida:{p:2500,g:2650}, volta:{p:1050,g:1150} },
      'Picos':                   { ida:{p:2500,g:2650}, volta:{p:1050,g:1150} },
      'Sobral':                  { ida:{p:2550,g:2700}, volta:{p:1050,g:1150} },
      'Piripiri':                { ida:{p:2550,g:2700}, volta:{p:1050,g:1150} },
      'Tianguá':                 { ida:{p:2550,g:2700}, volta:{p:1050,g:1150} },
      // --- Sul / Rota ---
      'Curitiba':                { ida:{p:550,g:600},  volta:{p:600,g:650} },
      'Joinville':               { ida:{p:600,g:650},  volta:{p:650,g:700} },
      'Florianópolis':           { ida:{p:600,g:650},  volta:{p:650,g:700} },
      'Itajaí':                  { ida:{p:600,g:650},  volta:{p:650,g:700} },
      'Porto Alegre':            { ida:{p:600,g:650},  volta:{p:650,g:700} },
      // --- Salvador / Rota ---
      'Salvador':                { ida:{p:1750,g:1900}, volta:{p:1000,g:1100} },
      // --- Até BH (o PDF não traz retorno — a volta fica como está) ---
      'Belo Horizonte':          { ida:{p:500,g:550} },
    },
  },
];


/* --------------------------------------------------------------------------
 *  PRECOS_ROTA — reajuste avulso, apontando a rota pelo nome exato.
 *  (o bloco REAJUSTES acima e para tabela inteira de uma transportadora)
 * ------------------------------------------------------------------------ */
const PRECOS_ROTA = [
  { transportadora:/rubens/i,      rota:'Uberlândia (MG) - Betim (MG)',
    valores:{ m300:500 }, fonte:'reporte do comercial 25/08/2026' },
  { transportadora:/transmartins/i, rota:'São Bernardo do Campo (SP) - Porto Velho (RO)',
    valores:{ p:3600, g:3600 }, fonte:'reajuste confirmado pela Luana/Transmartins 31/08/2026' },
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
  { transportadora:/milit/i, nomeSeNova:'Militão Transportes',
    rota:'Uberlândia (MG) - Betim (MG)',
    valores:{ m300:500 },
    trechos:[['Uberlândia','MG','Betim','MG']],
    fonte:'reporte do comercial 25/08/2026 (Rubens = Militão)' },
];

/* --------------------------------------------------------------------------
 *  BASES — taxa de recebimento por cidade (cobrada na base de origem E na de
 *  destino). Vem da aba Configurações da planilha.
 * ------------------------------------------------------------------------ */
const BASES = [
  { cidade:'Araçatuba',           uf:'SP', recebimento:200, fonte:'bases TRANSPADRE 27/08/2026' },
  { cidade:'Marília',             uf:'SP', recebimento:200, fonte:'bases TRANSPADRE 27/08/2026' },
  { cidade:'Presidente Prudente', uf:'SP', recebimento:250, fonte:'bases TRANSPADRE 27/08/2026' },
];

/* --------------------------------------------------------------------------
 *  TRECHOS — cidades que a rota atende mas que não estavam na lista de
 *  trajetos. Sem o trecho, o motor não enxerga a vaga e o comercial não
 *  consegue cotar. O preço é o da rota (por isso a cidade tem que ter mesmo
 *  o mesmo valor da rota — senão ela precisa de rota própria).
 * ------------------------------------------------------------------------ */
const TRECHOS = [
  // Joinville, Itajaí e São José/SC são cidades da rota de Porto Alegre (mesmo preço).
  // Florianópolis é atendida pela base de São José (a cegonha para lá).
  { transportadora:/martins/i, rota:'São Bernardo do Campo (SP) - Porto Alegre (RS)',
    ida:[['Joinville','SC'],['Itajaí','SC'],['São José','SC']], fonte:'confirmado pelo Luiz 04/09/2026' },
  { transportadora:/martins/i, rota:'Porto Alegre (RS) - São Bernardo do Campo (SP)',
    volta:[['Joinville','SC'],['Itajaí','SC'],['São José','SC']], fonte:'confirmado pelo Luiz 04/09/2026' },
  // Curitiba é atendida pela base de São José dos Pinhais (mesmo preço: 550/600).
  { transportadora:/martins/i, rota:'São Bernardo do Campo (SP) - São José dos Pinhais (PR)',
    ida:[['Curitiba','PR']], fonte:'confirmado pelo Luiz 04/09/2026' },
  { transportadora:/martins/i, rota:'São José dos Pinhais (PR) - São Bernardo do Campo (SP)',
    volta:[['Curitiba','PR']], fonte:'confirmado pelo Luiz 04/09/2026' },
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

if(!mudancas.length && !basesMud.length && !trechosMud.length && !rotasNovas.length){
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
for(const m of rotasNovas){ tabela.rotas.push(m.nova); }
const doc = await gravarTabela(tabela);
console.log(`✔ Tabela atualizada: ${mudancas.length} valores, ${basesMud.length} bases, ${trechosMud.length} trechos e ${rotasNovas.length} rota(s) nova(s) — ${doc.rotas} rotas no total. Publicada em ${doc.em}.`);
console.log('   Os operadores pegam a tabela nova ao recarregar a página (Ctrl+Shift+R).');
console.log(`   Reverter: node atualizar-tabela-precos.mjs --restaurar ${arqBackup} --aplicar`);
await pool.end();
