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

/* Categorias como estão cadastradas na tabela (a busca é tolerante a acento/caixa). */
const CATS = { p:'Carro Passeio', g:'Carro Grande', m300:'Moto até 300cc', m700:'Moto até 700cc', 'm700+':'Moto acima de 700cc' };
const norm = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
/* Nome da rota no sistema: "Cidade (UF) - Cidade (UF)" */
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
        mudancas.push({ rota, cat: catReal || nomeCat, de: atual, para: valor,
                        txt: `${rota.rota} · ${nomeCat}: ${atual==null?'(sem valor)':'R$ '+atual} → R$ ${valor}` });
      }
    }
  }
}

if(naoAchadas.length){
  console.log(`\n⚠️  ${naoAchadas.length} rota(s) do reajuste NÃO existem na tabela (nada foi feito nelas):`);
  naoAchadas.forEach(t => console.log('   ·', t));
}

if(!mudancas.length){
  console.log('\n✔ Nada a mudar — a tabela já está com os valores do reajuste.');
  await pool.end(); process.exit(0);
}

console.log(`\n${mudancas.length} valor(es) a alterar:`);
mudancas.forEach(m => console.log('   ·', m.txt));

if(!APLICAR){
  console.log('\nDRY-RUN — nada foi gravado. Confira a lista acima e rode de novo com --aplicar.');
  await pool.end(); process.exit(0);
}

const arqBackup = `/root/backup-tabela-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
writeFileSync(arqBackup, JSON.stringify(tabela));
console.log(`\nBackup salvo em ${arqBackup}`);

for(const m of mudancas){ m.rota.valores[m.cat] = m.para; }
const doc = await gravarTabela(tabela);
console.log(`✔ Tabela atualizada: ${mudancas.length} valores em ${doc.rotas} rotas. Publicada em ${doc.em}.`);
console.log('   Os operadores pegam a tabela nova ao recarregar a página (Ctrl+Shift+R).');
console.log(`   Reverter: node atualizar-tabela-precos.mjs --restaurar ${arqBackup} --aplicar`);
await pool.end();
