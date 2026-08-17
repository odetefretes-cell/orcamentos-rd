#!/usr/bin/env node
/* ============================================================================
 *  captar-explorar.mjs — SÓ LEITURA. Usa a sessão salva do ChatGuru para:
 *    1) descobrir o filtro certo que lista as conversas EM ABERTO (testa variações);
 *    2) mostrar os "Ninguém Delegado" (fluxo principal de leads);
 *    3) de alguns, os campos do bot + as mensagens do cliente.
 *  NÃO grava nada (nem ChatGuru, nem Firestore).
 *  Uso (como obsrobo, em /opt/obs-robo):  node captar-explorar.mjs
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
try { const d = await import('dotenv'); d.config({ path: fs.existsSync('/etc/obs-robo/.env') ? '/etc/obs-robo/.env' : '.env', quiet: true }); } catch {}

const DIR = process.cwd();
const SESSAO = path.join(DIR, 'estado', 'chatguru-sessao.json');
const BASE = 'https://s22.chatguru.app';
const ATTEND = {
  '697742aabe1efe4ea6f09c8c': 'Yasmim Freitas',
  '67ec4c84cd147df9a46d6c1c': 'Flavia Ottati',
  '68b217e269ff36d6cae7fbd7': 'Thiago Lucca',
};
const log = (...a) => console.log(...a);

if (!fs.existsSync(SESSAO)) { log('ERRO: sessão não encontrada em', SESSAO, '— rode o seed-login.mjs.'); process.exit(1); }

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({
  storageState: SESSAO, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1440, height: 900 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

// Consulta o /chatlist/store. Faz JSON.parse pelo CORPO (o ChatGuru manda content-type
// text/html mesmo sendo JSON). status='' = todos; noDeleg=true = só "Ninguém Delegado".
async function consultar(status, noDeleg, pageNum) {
  return await page.evaluate(async (args) => {
    const { status, noDeleg, pageNum } = args;
    const payload = { page_num: pageNum || 0, filter_order_by: '', filter_tag: [], filter_tag_rule: 'or',
      filter_user_rule: 'or', filter_user: { users: [], groups: [], noDelegated: !!noDeleg },
      filter_phone: '', filter_funnel_step: [], filter_status: status,
      filter_search_number: '', filter_search_name: '', filter_new_messages: '',
      filter_archived: '', filter_broadcast: '', filter_favorited: '', filter_scheduled: '' };
    const meta = document.querySelector('meta[name="csrf-token"]');
    const cm = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    if (meta) headers['X-CSRF-TOKEN'] = meta.getAttribute('content');
    if (cm) headers['X-XSRF-TOKEN'] = decodeURIComponent(cm[1]);
    let r; try { r = await fetch('/chatlist/store', { method: 'POST', headers, body: JSON.stringify(payload) }); }
    catch (e) { return { erro: 'fetch falhou: ' + String(e && e.message || e) }; }
    const httpStatus = r.status; const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch (e) {}
    if (data) return { ok: true, data };
    return { erro: 'não parseou JSON', httpStatus, amostra: text.slice(0, 400).replace(/\s+/g, ' ') };
  }, { status, noDeleg, pageNum });
}

async function customFields(chatId) {
  return await page.evaluate(async (id) => {
    try {
      const meta = document.querySelector('meta[name="csrf-token"]');
      const cm = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
      const headers = { 'X-Requested-With': 'XMLHttpRequest' };
      if (meta) headers['X-CSRF-TOKEN'] = meta.getAttribute('content');
      if (cm) headers['X-XSRF-TOKEN'] = decodeURIComponent(cm[1]);
      const r = await fetch('/chat/custom_fields/' + id + '/view', { method: 'POST', headers });
      if (!r.ok) return { _erro: 'HTTP ' + r.status };
      const html = await r.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = {};
      doc.querySelectorAll('tr').forEach(tr => { const tds = tr.querySelectorAll('td'); if (tds.length >= 2) { const k = (tds[0].innerText || '').trim(); const v = (tds[1].innerText || '').trim(); if (k) out[k] = v; } });
      return out;
    } catch (e) { return { _erro: String(e && e.message || e) }; }
  }, chatId);
}
async function mensagensCliente(chatId) {
  return await page.evaluate(async (id) => {
    try {
      const r = await fetch('/messages2/' + id + '/page/1', { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (!r.ok) return ['_erro HTTP ' + r.status];
      const j = await r.json();
      const arr = (j.messages_and_notes || []).filter(x => x.type === 'message' && x.m && x.m.is_out === false);
      arr.sort((a, b) => (a.m.timestamp || 0) - (b.m.timestamp || 0));
      const clean = s => String(s || '').replace(/https?:\/\/\S+/g, '[url]').replace(/[A-Za-z0-9_-]{24,}/g, '[id]').replace(/\s+/g, ' ').trim();
      return arr.map(x => clean(x.m.text)).filter(Boolean).slice(0, 12);
    } catch (e) { return ['_erro ' + String(e && e.message || e)]; }
  }, chatId);
}

function resumo(r) { return r.ok ? `total=${r.data.total_chats}, retornou=${(r.data.chats || []).length}` : `ERRO: ${r.erro}${r.amostra ? ' | ' + r.amostra : ''}`; }

try {
  log('Abrindo o ChatGuru com a sessão salva...');
  await page.goto(BASE + '/chats', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  if (/\/login/i.test(page.url())) { log('❌ Sessão expirou (voltou pro login). Rode o seed-login.mjs.'); await browser.close(); process.exit(2); }
  log('Sessão OK.\n');

  log('===== TESTE DE FILTROS (pra achar o que traz os chats) =====');
  const testes = [
    ['ABERTO', false, 'A) ABERTO, todos'],
    ['ABERTO', true, 'B) ABERTO, só Ninguém Delegado'],
    ['', false, 'C) sem status, todos'],
    ['aberto', false, 'D) aberto (minúsculo), todos'],
  ];
  const resultados = {};
  for (const [st, nd, rot] of testes) { const r = await consultar(st, nd, 0); resultados[rot] = r; log(`  ${rot}: ${resumo(r)}`); await page.waitForTimeout(300); }

  // escolhe a melhor lista disponível (prioriza a que traz mais chats)
  let melhor = null, melhorN = -1;
  for (const rot in resultados) { const r = resultados[rot]; const n = r.ok ? (r.data.chats || []).length : -1; if (n > melhorN) { melhorN = n; melhor = r; } }
  const todos = (melhor && melhor.ok && melhor.data.chats) || [];

  if (!todos.length) {
    log('\n⚠️ Nenhuma variação trouxe chats. Pode ser permissão do usuário do robô no ChatGuru');
    log('   (precisa de "Ver Todos os Chats" ativo) ou não há abertos agora. Me manda este print.');
    await browser.close(); process.exit(0);
  }

  const semDeleg = todos.filter(c => !((c.users_delegated_ids || []).length)).map(c => ({ id: c.id, name: c.name, wa: c.wa_chat_id }));
  const dosOper = todos.filter(c => (c.users_delegated_ids || []).some(id => ATTEND[id]))
    .map(c => { const aid = (c.users_delegated_ids || []).find(id => ATTEND[id]); return { id: c.id, name: c.name, wa: c.wa_chat_id, attendant: ATTEND[aid] }; });

  log(`\n===== Usando a melhor lista: ${todos.length} chats =====`);
  log(`  ▶ NINGUÉM DELEGADO (fluxo principal): ${semDeleg.length}`);
  log(`  ▶ delegados aos 3 operadores: ${dosOper.length}`);
  log('\n--- NINGUÉM DELEGADO ---');
  semDeleg.slice(0, 40).forEach((a, i) => log(`${String(i + 1).padStart(2)}. ${a.name || '(sem nome)'} — ${a.wa || a.id}`));

  const base = semDeleg.length ? semDeleg : todos.map(c => ({ id: c.id, name: c.name, wa: c.wa_chat_id }));
  const AMOSTRA = Math.min(4, base.length);
  log(`\n===== AMOSTRA de ${AMOSTRA} (campos do bot + mensagens do cliente) =====`);
  for (let i = 0; i < AMOSTRA; i++) {
    const a = base[i];
    log(`\n--- ${i + 1}) ${a.name || '(sem nome)'} | ${a.wa || ''} | chatId=${a.id} ---`);
    log('  Campos do bot:', JSON.stringify(await customFields(a.id)));
    const msgs = await mensagensCliente(a.id);
    log('  Mensagens do cliente:'); msgs.forEach(m => log('     • ' + m));
    await page.waitForTimeout(400);
  }
  log('\n===== fim (nada foi gravado) =====');
  await browser.close(); process.exit(0);
} catch (e) {
  log('ERRO inesperado:', String(e && e.message || e).split('\n')[0]);
  await browser.close(); process.exit(1);
}
