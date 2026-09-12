/* ============================================================================
   OBS Transportes — CONVERSÕES OFFLINE → PLANILHA DO GOOGLE ADS

   Fecha o ciclo do rastreamento sem ninguém baixar CSV. O Google aposentou o
   upload manual de arquivo (Metas → Uploads só redireciona para a Central de
   dados); o que ficou é uma PLANILHA no Drive conectada ao Google Ads, que ele
   relê sozinho todo dia entre 04:00 e 05:00 (Brasília). Este job escreve nela.

   Roda de hora em hora no orquestrador (integracao/vps/orquestrador.js). Não
   está preso ao clique de "Venda Fechada" de propósito: um job varrendo os
   fechados é menos invasivo no Kanban, e o Google só lê de madrugada mesmo.

   Regras — só entra quem passa em TODAS (espelham crmColetarConversoesAds do
   index.html, o botão "📤 Exportar conversões", que continua como plano B):
     1. etapa 'fechado' (Venda Fechada);
     2. tem gclid (ou gbraid/wbraid) — sem clique não há o que enviar, pula calado;
     3. total da composição > 0;
     4. tem momento de fechamento (entrada 'convertido' da timeline) e ele não
        está no futuro;
     5. ainda não carimbado em `conversao_exportada_em`.
   Mais a janela de 90 dias do clique, que o botão também aplica: o Ads recusa
   clique mais velho e a linha só geraria erro na importação.

   ANTI-DUPLICAÇÃO — o mais importante aqui. O Google relê a planilha INTEIRA
   toda madrugada; a mesma venda com dois horários diferentes conta DUAS vezes,
   e conversão importada não sai fácil. O carimbo `conversao_exportada_em` é o
   MESMO do botão de CSV, então os dois caminhos não brigam. Ele só é gravado
   DEPOIS de a API confirmar a escrita; se a chamada falhar, o lead fica sem
   carimbo e entra na próxima rodada sozinho.

   ⚠️ NUNCA mexer no cabeçalho da planilha (linha 1): ele está amarrado ao
   mapeamento de campos dentro do Google Ads e a importação para em silêncio.
   Por isso o job CONFERE o cabeçalho antes de escrever e aborta se não bater.
   `values.append` só acrescenta depois da última linha com dados — nunca
   sobrescreve. E nunca apaga linha: quem some da planilha some do histórico.

   Acesso: conta de serviço (service account) com a Google Sheets API, JWT RS256
   assinado com o crypto nativo — sem SDK, sem dependência nova. A chave JSON
   fica FORA do repositório, em /etc/obs-automacao/ (ver .env.example).

   Config (env):
     GOOGLE_SA_KEY_FILE   caminho da chave JSON da service account
                          (ou GOOGLE_SA_KEY_JSON com o JSON inteiro)
     ADS_SHEET_ID         id da planilha (padrão: a "OBS - Conversoes Google Ads")
     ADS_SHEET_MAX_LOTE   máx. de linhas por rodada (padrão 100)

   Rodar avulso na VPS (de /opt/obs-automacao/integracao):
     node conversoes-sheets.js --dry-run   # mostra o que escreveria, não toca em nada
     node conversoes-sheets.js --once      # escreve de verdade uma vez
   ========================================================================== */
'use strict';
const fs = require('fs');
const crypto = require('crypto');

// Rodando AVULSO (node conversoes-sheets.js …): o require do firebase-admin abaixo
// precisa resolver para os stubs → pg-compat ANTES de acontecer, e o .env da VPS
// precisa estar carregado. Dentro do orquestrador isso já vem pronto.
if (require.main === module) {
  const path = require('path'), Module = require('module');
  // vps/node_modules entra no caminho porque é lá que o dotenv está instalado (o
  // npm install do deploy roda em vps/, não em integracao/). Sem isso o require
  // falharia calado, o .env não carregaria e o job diria "sem chave".
  process.env.NODE_PATH = [path.join(__dirname, 'vps', 'stubs'), path.join(__dirname, 'vps', 'node_modules'), process.env.NODE_PATH || '']
    .filter(Boolean).join(path.delimiter);
  Module._initPaths();
  try { require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '/etc/obs-automacao/.env' }); } catch (_) {}
}
const { getFirestore } = require('firebase-admin/firestore');   // no VPS → pg-compat

const TZ = 'America/Sao_Paulo';
// Precisa bater LETRA POR LETRA com a ação criada no Google Ads (mesma constante
// do index.html). A coluna não é mapeada na conexão, mas documenta a linha.
const ADS_NOME_CONVERSAO = 'OBS - Frete fechado';
const ADS_JANELA_DIAS = 90;
const CABECALHO = ['Google Click ID', 'Conversion Name', 'Conversion Time', 'Conversion Value', 'Conversion Currency'];
const SHEET_ID_PADRAO = '1kaDe2x6UqnPOpiJ1ZeXF9B0T5rbK83_VwsgvSzKYTQg';
const ESCOPO = 'https://www.googleapis.com/auth/spreadsheets';

/* ---------------------------------------------------------------- utilidades */
// "2.339,80" | "2339.80" | "50.000" | "R$ 950" → número (cópia fiel do numMoeda do app)
function numMoeda(v) {
  if (v === '' || v == null) return 0;
  let s = String(v).trim().replace(/[R$\s]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s.replace(/[^\d.-]/g, ''));
  return isNaN(n) ? 0 : n;
}
function compTotal(l) {
  return (l.composicao || []).filter((c) => c && c.ativo).reduce((s, c) => s + numMoeda(c.valor), 0);
}
function clique(l) { return String((l && (l.gclid || l.gbraid || l.wbraid)) || '').trim(); }

// Momento da venda: a entrada 'convertido' da timeline é a única fonte com HORA
// (dataFechamento só tem o dia). Pega a mais recente.
function momentoFechamento(l) {
  const t = (l && Array.isArray(l.timeline)) ? l.timeline : [];
  for (let i = t.length - 1; i >= 0; i--) {
    const e = t[i];
    if (e && (e.tipo === 'convertido' || /venda fechada/i.test(String(e.texto || '')))) {
      const d = new Date(e.data);
      if (!isNaN(d)) return d;
    }
  }
  return null;
}
function nascimento(l) {
  const cand = [l.data_lead, l.dataEnvio, l.timeline && l.timeline[0] && l.timeline[0].data, l.dataEntrada];
  for (const c of cand) { if (c) { const d = new Date(c); if (!isNaN(d)) return d; } }
  return null;
}

// "AAAA-MM-DD HH:MM:SS" no fuso de Brasília — sem T, sem Z, sem offset. O servidor
// roda em UTC, então formatar com a hora local do processo daria 3h de erro.
function dataAds(d) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  const hh = p.hour === '24' ? '00' : p.hour;   // en-CA às vezes devolve "24" à meia-noite
  return `${p.year}-${p.month}-${p.day} ${hh}:${p.minute}:${p.second}`;
}

/* ---------------------------------------------------------------- seleção */
// Varre os leads e separa o que entra do que fica de fora, com o motivo.
function selecionar(leads, agora = new Date()) {
  const dentro = [], fora = [];
  for (const { id, l } of leads) {
    if (!l || l.etapa !== 'fechado') continue;                          // 1
    if (String(l.conversao_exportada_em || '').trim()) continue;        // 5 — já foi; nem conta como descarte
    const gclid = clique(l);
    if (!gclid) continue;                                               // 2 — sem clique: pula em silêncio
    const quando = momentoFechamento(l);
    if (!quando) { fora.push({ id, motivo: 'sem data de fechamento no histórico' }); continue; }   // 4
    if (quando > agora) { fora.push({ id, motivo: 'fechamento no futuro (data inconsistente)' }); continue; }
    const valor = compTotal(l);
    if (!(valor > 0)) { fora.push({ id, motivo: 'total do frete não confirmado' }); continue; }   // 3
    const nasc = nascimento(l);
    if (nasc) {
      if (quando < nasc) { fora.push({ id, motivo: 'fechamento anterior à criação do lead' }); continue; }
      const dias = (agora - nasc) / 86400000;
      if (dias > ADS_JANELA_DIAS) { fora.push({ id, motivo: `clique tem ${Math.round(dias)} dias — passou da janela de ${ADS_JANELA_DIAS}` }); continue; }
    }
    dentro.push({ id, nome: l.nome || id, gclid, quando, valor });
  }
  dentro.sort((a, b) => a.quando - b.quando);
  return { dentro, fora };
}

// Uma linha da planilha, na ordem exata do cabeçalho. Tudo string: a escrita é
// RAW, então o Sheets não converte data em número de série nem valor em moeda.
function linha(c) {
  return [c.gclid, ADS_NOME_CONVERSAO, dataAds(c.quando), c.valor.toFixed(2), 'BRL'];
}

/* ---------------------------------------------------------------- Google API */
function carregarChave() {
  const inline = process.env.GOOGLE_SA_KEY_JSON;
  const arquivo = process.env.GOOGLE_SA_KEY_FILE;
  let txt = null;
  if (inline && inline.trim().startsWith('{')) txt = inline;
  else if (arquivo) txt = fs.readFileSync(arquivo, 'utf8');
  if (!txt) return null;
  const k = JSON.parse(txt);
  if (!k.client_email || !k.private_key) throw new Error('chave da service account sem client_email/private_key');
  return k;
}

let _token = null;   // { valor, expiraEm }
async function tokenAcesso(chave) {
  if (_token && Date.now() < _token.expiraEm - 60000) return _token.valor;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const agora = Math.floor(Date.now() / 1000);
  const jwtSemAssin = b64({ alg: 'RS256', typ: 'JWT' }) + '.' +
    b64({ iss: chave.client_email, scope: ESCOPO, aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600 });
  const assin = crypto.sign('RSA-SHA256', Buffer.from(jwtSemAssin), chave.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwtSemAssin + '.' + assin }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`token Google falhou (${r.status}): ${JSON.stringify(j).slice(0, 200)}`);
  _token = { valor: j.access_token, expiraEm: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return _token.valor;
}

// 429 e 5xx são transitórios (cota, instabilidade): tenta de novo com espera crescente.
// 4xx de outro tipo (401 chave errada, 403 sem acesso à planilha, 404 id errado)
// não melhora repetindo — falha na hora, com a mensagem do Google no log.
async function chamar(url, opts, tentativas = 3) {
  let ultimo;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.ok) return r.json();
      const corpo = await r.text().catch(() => '');
      ultimo = new Error(`Sheets ${r.status}: ${corpo.slice(0, 300)}`);
      if (r.status !== 429 && r.status < 500) throw ultimo;
    } catch (e) {
      if (e === ultimo) throw e;
      ultimo = e;                                            // rede — tenta de novo
    }
    if (i < tentativas - 1) await new Promise((res) => setTimeout(res, 2000 * 2 ** i));   // 2s, 4s
  }
  throw ultimo;
}

function api(sheetId, sufixo) {
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/${sufixo}`;
}
// Sem nome de aba no range, o Sheets usa a PRIMEIRA aba — a planilha só tem uma.
async function conferirCabecalho(sheetId, token) {
  const j = await chamar(api(sheetId, 'values/A1:E1'), { headers: { Authorization: `Bearer ${token}` } });
  const lido = (j.values && j.values[0]) || [];
  const ok = CABECALHO.every((c, i) => String(lido[i] || '').trim() === c);
  if (!ok) throw new Error(`cabeçalho da planilha não bate — esperado [${CABECALHO.join(', ')}], lido [${lido.join(', ')}]. NADA foi escrito.`);
}
async function acrescentar(sheetId, token, linhas) {
  const url = api(sheetId, 'values/A1:append') + '?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
  return chamar(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ majorDimension: 'ROWS', values: linhas }),
  });
}

/* ---------------------------------------------------------------- o ciclo */
async function processarConversoes({ dryRun = false } = {}) {
  const chave = carregarChave();
  if (!chave && !dryRun) {
    console.warn('[conversoes] GOOGLE_SA_KEY_FILE/GOOGLE_SA_KEY_JSON não configurado — job desligado nesta rodada.');
    return { pulado: 'sem chave' };
  }
  const sheetId = process.env.ADS_SHEET_ID || SHEET_ID_PADRAO;
  const maxLote = Number(process.env.ADS_SHEET_MAX_LOTE) || 100;

  const db = getFirestore();
  const snap = await db.collection('crm_leads').get();
  const leads = [];
  snap.forEach((d) => leads.push({ id: d.id, l: d.data() || {} }));

  const { dentro, fora } = selecionar(leads);
  const lote = dentro.slice(0, maxLote);
  const resumo = { candidatos: dentro.length, descartados: fora.length, escritos: 0 };
  if (fora.length) resumo.motivos = fora.reduce((o, f) => { o[f.motivo] = (o[f.motivo] || 0) + 1; return o; }, {});
  if (!lote.length) return resumo;

  const linhas = lote.map(linha);
  if (dryRun) {
    console.log(`[conversoes] DRY-RUN — ${lote.length} linha(s) que seriam escritas:`);
    linhas.forEach((r) => console.log('   ' + r.join(',')));
    return { ...resumo, dryRun: true, linhas };
  }

  const token = await tokenAcesso(chave);
  await conferirCabecalho(sheetId, token);                    // aborta antes de escrever se a planilha não for a esperada
  const r = await acrescentar(sheetId, token, linhas);        // ou escreve TODAS, ou lança (e nada é carimbado)
  const faixa = (r && r.updates && r.updates.updatedRange) || '?';

  // Carimba SÓ depois da confirmação. Mesmo carimbo do botão de CSV.
  const agora = new Date().toISOString();
  for (const c of lote) {
    try {
      await db.collection('crm_leads').doc(c.id).set({ conversao_exportada_em: agora }, { merge: true });
      resumo.escritos++;
      console.log(`[conversoes] ✔ ${c.nome} (${c.id}) gclid=${c.gclid.slice(0, 12)}… R$ ${c.valor.toFixed(2)} em ${dataAds(c.quando)} → ${faixa}`);
    } catch (e) {
      // A linha JÁ está na planilha e o carimbo falhou: na próxima rodada ela iria
      // de novo, e o Google contaria duas vezes. Gritar no log é o mínimo.
      console.error(`[conversoes] ⚠️ ${c.id} escrito na planilha mas o carimbo FALHOU — corrigir à mão (conversao_exportada_em) antes das 04:00:`, (e && e.message) || e);
    }
  }
  return resumo;
}

module.exports = { processarConversoes, _internos: { selecionar, linha, dataAds, numMoeda, compTotal, CABECALHO, ADS_NOME_CONVERSAO } };

/* ---------------------------------------------------------------- CLI */
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  if (!dryRun && !process.argv.includes('--once')) {
    console.log('uso: node conversoes-sheets.js --dry-run | --once'); process.exit(2);
  }
  processarConversoes({ dryRun })
    .then((r) => { console.log('[conversoes] resultado:', JSON.stringify(r, null, 1)); process.exit(0); })
    .catch((e) => { console.error('[conversoes] ERRO:', (e && e.stack) || e); process.exit(1); });
}
