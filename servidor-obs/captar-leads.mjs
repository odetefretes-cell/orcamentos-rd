#!/usr/bin/env node
/* ============================================================================
 *  captar-leads.mjs — CAPTAÇÃO (começa em DRY_RUN = só mostra, não grava).
 *  Lê a fila "Ninguém Delegado + ABERTO" do ChatGuru, extrai os dados do lead,
 *  confere duplicidade no CRM e MOSTRA o que criaria. Só grava se DRY_RUN=false.
 *
 *  Uso (como obsrobo, em /opt/obs-robo):  node captar-leads.mjs
 *  DRY_RUN vem do /etc/obs-robo/.env (comece SEMPRE com DRY_RUN=true).
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import admin from 'firebase-admin';
try { const d = await import('dotenv'); d.config({ path: fs.existsSync('/etc/obs-robo/.env') ? '/etc/obs-robo/.env' : '.env', quiet: true }); } catch {}

const DIR = process.cwd();
const SESSAO = path.join(DIR, 'estado', 'chatguru-sessao.json');
const BASE = 'https://s22.chatguru.app';
const DRY_RUN = String(process.env.DRY_RUN ?? 'true') !== 'false';   // padrão: seguro (não grava)
const log = (...a) => console.log(...a);

if (!fs.existsSync(SESSAO)) { log('ERRO: sessão não encontrada — rode seed-login.mjs.'); process.exit(1); }

// ---------- Firebase (admin) ----------
function credFirebase() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const raw = b64 ? Buffer.from(b64, 'base64').toString('utf8') : process.env.FIREBASE_SERVICE_ACCOUNT;
  return JSON.parse(raw);
}
const cred = credFirebase();
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(cred), projectId: cred.project_id });
const db = admin.firestore();

// ---------- helpers de dados ----------
const soDig = s => String(s || '').replace(/\D/g, '');
function ult8(tel) { const d = soDig(tel); return d.slice(-8); }
function fmtTel(raw) { let d = soDig(raw); if (d.startsWith('55') && d.length >= 12) d = d.slice(2); if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`; if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`; return raw || ''; }

// Extrai os campos do template "*Solicitação de orçamento — OBS Transportes*"
function parseTemplate(txt) {
  if (!/Solicita[çc][ãa]o de or[çc]amento/i.test(txt)) return null;
  const labels = ['Nome:', 'Telefone:', 'E-mail:', 'Tipo de cliente:', 'Veículo:', 'Tipo de veículo:', 'Valor do veículo:', 'Funciona/liga:', 'Blindado:', 'Origem:', 'Destino:'];
  const pos = labels.map(l => ({ l, i: txt.indexOf(l) }));   // case-sensitive (separa "Veículo:" de "Tipo de veículo:")
  const out = {};
  for (let k = 0; k < pos.length; k++) {
    if (pos[k].i < 0) continue;
    const start = pos[k].i + pos[k].l.length;
    let end = txt.length;
    for (let m = 0; m < pos.length; m++) { if (pos[m].i > start && pos[m].i < end) end = pos[m].i; }
    const g = txt.indexOf('Gostaria', start); if (g >= 0 && g < end) end = g;
    out[pos[k].l.replace(':', '')] = txt.slice(start, end).trim();
  }
  return out;
}
const simNao = v => /^sim|^s$|^liga|funciona/i.test(String(v || '').trim());
// Limpa placeholders que a IA às vezes devolve quando o dado não foi informado.
function limpoTxt(s) { s = String(s || '').trim(); if (/^(<?unknown>?|n\/?a|não informado|nao informado|desconhecido|indefinido|-+)$/i.test(s)) return ''; return s; }

// ---------- ChatGuru (leitura) ----------
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ storageState: SESSAO, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1440, height: 900 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' });
const page = await ctx.newPage();

async function filaAbertosSemDelegado() {
  return await page.evaluate(async () => {
    const payload = { page_num: 0, filter_order_by: '', filter_tag: [], filter_tag_rule: 'or',
      filter_user_rule: 'or', filter_user: { users: [], groups: [], noDelegated: true },
      filter_phone: '', filter_funnel_step: [], filter_status: 'ABERTO',
      filter_search_number: '', filter_search_name: '', filter_new_messages: '',
      filter_archived: '', filter_broadcast: '', filter_favorited: '', filter_scheduled: '' };
    const meta = document.querySelector('meta[name="csrf-token"]');
    const cm = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    if (meta) headers['X-CSRF-TOKEN'] = meta.getAttribute('content');
    if (cm) headers['X-XSRF-TOKEN'] = decodeURIComponent(cm[1]);
    const r = await fetch('/chatlist/store', { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) {}
    return data ? (data.chats || []) : { erro: text.slice(0, 300) };
  });
}
async function mensagensCliente(chatId) {
  return await page.evaluate(async (id) => {
    try {
      const r = await fetch('/messages2/' + id + '/page/1', { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (!r.ok) return [];
      const j = await r.json();
      const arr = (j.messages_and_notes || []).filter(x => x.type === 'message' && x.m && x.m.is_out === false);
      arr.sort((a, b) => (a.m.timestamp || 0) - (b.m.timestamp || 0));
      return arr.map(x => String(x.m.text || '')).filter(Boolean);
    } catch (e) { return []; }
  }, chatId);
}

// ---------- Extração por IA (Claude) p/ mensagens livres (sem formulário) ----------
async function extrairIA(mensagens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { erro: 'sem ANTHROPIC_API_KEY' };
  const modelo = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const tool = {
    name: 'registrar_lead',
    description: 'Registra os dados de transporte de veículo informados pelo cliente na conversa.',
    input_schema: {
      type: 'object',
      properties: {
        ehLead: { type: 'boolean', description: 'true SE a conversa é um pedido de transporte de veículo com dados (origem/destino/veículo). false se for só dúvida, saudação, retorno de cliente já atendido, ou conversa sem pedido novo.' },
        nome: { type: 'string', description: 'nome do cliente, se informado' },
        veiculo: { type: 'string', description: 'modelo do veículo (ex.: "Onix 2020")' },
        valorVeiculo: { type: 'number', description: 'valor do veículo em reais, inteiro (ex.: "50 mil"->50000, "R$ 83.000"->83000). 0 se não informado.' },
        origem: { type: 'string', description: 'cidade e UF de origem (ex.: "Guarulhos SP")' },
        destino: { type: 'string', description: 'cidade e UF de destino' },
        funciona: { type: 'boolean', description: 'o veículo funciona/liga? (true se sim ou não informado)' },
        blindado: { type: 'boolean', description: 'é blindado?' },
      },
      required: ['ehLead', 'nome', 'veiculo', 'valorVeiculo', 'origem', 'destino', 'funciona', 'blindado'],
    },
  };
  const body = {
    model: modelo, max_tokens: 1000,
    system: 'Você extrai dados de transporte de veículo de conversas de WhatsApp da OBS Transportes (transporte de carros e motos por cegonha/guincho). NUNCA invente: o que o cliente não informou fica vazio (0 para valor). Se a conversa NÃO for um pedido de transporte com dados (só dúvida, "ok", saudação, retorno), marque ehLead=false.',
    tools: [tool], tool_choice: { type: 'tool', name: 'registrar_lead' },
    messages: [{ role: 'user', content: 'Mensagens do cliente (em ordem):\n' + mensagens.join('\n') }],
  };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) return { erro: 'HTTP ' + r.status + ' ' + JSON.stringify(j).slice(0, 200) };
    const use = (j.content || []).find(c => c.type === 'tool_use');
    return use ? use.input : { erro: 'sem tool_use na resposta' };
  } catch (e) { return { erro: String(e && e.message || e) }; }
}

try {
  if (process.argv.includes('--demo-ia')) {
    log('===== DEMO da extração por IA (não usa o ChatGuru) =====');
    const casos = [
      ['DEVE ser lead', ['Boa tarde! Preciso transportar um Honda Civic 2019', 'de São Paulo SP para Salvador BA', 'o carro funciona normal, vale uns 90 mil']],
      ['NÃO é lead (dúvida)', ['a entrega não é feita no local?', 'ok', 'combinado']],
    ];
    for (const [rot, msgs] of casos) { log(`\n[${rot}] ${JSON.stringify(msgs)}`); log('  IA →', JSON.stringify(await extrairIA(msgs))); }
    log('\n(demo — nada gravado)');
    await browser.close(); process.exit(0);
  }
  log(`===== CAPTAÇÃO ${DRY_RUN ? '(DRY_RUN — só mostra, NÃO grava)' : '⚠️ AO VIVO (VAI GRAVAR)'} =====\n`);
  await page.goto(BASE + '/chats', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  if (/\/login/i.test(page.url())) { log('❌ Sessão expirou. Rode seed-login.mjs.'); await browser.close(); process.exit(2); }

  const chats = await filaAbertosSemDelegado();
  if (chats.erro) { log('❌ Erro ao ler a fila:', chats.erro); await browser.close(); process.exit(1); }
  log(`Fila "Ninguém Delegado + ABERTO": ${chats.length} conversa(s).\n`);

  // Dedup: carrega telefones (últimos 8) e nomes já existentes no CRM
  log('Carregando leads existentes do CRM (pra não duplicar)...');
  const snap = await db.collection('crm_leads').select('telefone', 'nome').get();
  const fones = new Set(), nomes = new Set();
  snap.forEach(doc => { const d = doc.data(); const u = ult8(d.telefone); if (u) fones.add(u); if (d.nome) nomes.add(String(d.nome).trim().toLowerCase()); });
  log(`  ${snap.size} leads no CRM (${fones.size} telefones distintos).\n`);

  let criaria = 0, pula = 0, precisaIA = 0;
  for (const c of chats) {
    const wa = c.wa_chat_id || '';
    const nomeChat = c.name || '';
    const msgs = await mensagensCliente(c.id);
    const juntas = msgs.join('  ||  ');
    const tpl = parseTemplate(juntas);

    const telefone = fmtTel(wa || (tpl && tpl.Telefone) || '');
    const chave = ult8(wa || (tpl && tpl.Telefone) || '');
    const jaExiste = (chave && fones.has(chave)) || (tpl && tpl.Nome && nomes.has(tpl.Nome.trim().toLowerCase())) || (nomeChat && nomes.has(nomeChat.trim().toLowerCase()));

    log(`\n--- ${nomeChat || '(sem nome)'} | ${telefone} | chatId=${c.id} ---`);
    if (jaExiste) { log('  ⏭️  JÁ EXISTE no CRM (últimos 8 dígitos ou nome) → PULA.'); pula++; continue; }

    // extrai: formulário (regex, instantâneo) OU IA (mensagens livres)
    let d = null, fonte = '';
    if (tpl) {
      d = { nome: tpl.Nome, veiculo: tpl['Veículo'], valorVeiculo: soDig(tpl['Valor do veículo']), origem: tpl.Origem, destino: tpl.Destino, funciona: simNao(tpl['Funciona/liga']), blindado: /sim/i.test(tpl.Blindado || ''), email: tpl['E-mail'] || '', ehLead: true };
      fonte = 'formulário';
    } else {
      const ia = await extrairIA(msgs);
      if (ia.erro) { log('  ⚠️  IA falhou:', ia.erro); msgs.slice(0, 6).forEach(m => log('      • ' + m.replace(/https?:\/\/\S+/g, '[url]').replace(/\s+/g, ' ').slice(0, 160))); precisaIA++; continue; }
      d = ia; fonte = 'IA';
    }

    if (!d.ehLead || !(d.origem || d.destino || d.veiculo)) {
      log(`  ⏭️  Não é lead novo (${fonte}: sem pedido de transporte) → PULA.`);
      msgs.slice(0, 4).forEach(m => log('      • ' + m.replace(/https?:\/\/\S+/g, '[url]').replace(/\s+/g, ' ').slice(0, 120)));
      pula++; continue;
    }

    const vv = String(d.valorVeiculo ?? '').replace(/\D/g, '');
    const lead = {
      id: 'lead_wpp_' + chave,
      nome: limpoTxt(d.nome) || nomeChat || '',
      telefone,
      email: limpoTxt(d.email),
      veiculoDesc: limpoTxt(d.veiculo),
      valorVeiculo: (vv && vv !== '0') ? vv : '',
      origem: limpoTxt(d.origem),
      destino: limpoTxt(d.destino),
      funciona: d.funciona ? 'SIM' : 'NÃO',
      blindado: d.blindado ? 'SIM' : 'NÃO',
      origemLead: 'whatsapp', etapa: 'novo', prioridade: 'quente',
    };
    log(`  ✅ CRIARIA este lead (via ${fonte}):`);
    log('     ', JSON.stringify(lead));
    criaria++;
  }

  log(`\n===== RESUMO: ${criaria} criaria | ${pula} já existem | ${precisaIA} precisam de IA =====`);
  log(DRY_RUN ? '(DRY_RUN — nada foi gravado. Quando você aprovar, a gente liga o modo real.)' : '(AO VIVO)');
  await browser.close(); process.exit(0);
} catch (e) {
  log('ERRO inesperado:', String(e && e.message || e).split('\n')[0]);
  await browser.close(); process.exit(1);
}
