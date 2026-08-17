#!/usr/bin/env node
/* ============================================================================
 *  captar-explorar.mjs — SÓ LEITURA. Usa a sessão salva do ChatGuru e:
 *    1) lista as conversas EM ABERTO delegadas aos 3 atendentes;
 *    2) mostra, de algumas, os campos do bot + as mensagens do cliente.
 *  NÃO grava nada (nem no ChatGuru, nem no Firestore). Serve pra provar que a
 *  leitura pelas APIs internas do ChatGuru funciona com a sessão salva.
 *
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

if (!fs.existsSync(SESSAO)) { log('ERRO: sessão não encontrada em', SESSAO, '— rode o seed-login.mjs primeiro.'); process.exit(1); }

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({
  storageState: SESSAO, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1440, height: 900 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

async function chatlistAbertos() {
  return await page.evaluate(async () => {
    const payload = { page_num: 0, filter_order_by: '', filter_tag: [], filter_tag_rule: 'or',
      filter_user_rule: 'or', filter_user: { users: [], groups: [], noDelegated: false },
      filter_phone: '', filter_funnel_step: [], filter_status: 'ABERTO',
      filter_search_number: '', filter_search_name: '', filter_new_messages: '',
      filter_archived: '', filter_broadcast: '', filter_favorited: '', filter_scheduled: '' };
    const meta = document.querySelector('meta[name="csrf-token"]');
    const tokenMeta = meta ? meta.getAttribute('content') : '';
    const cm = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
    const tokenCookie = cm ? decodeURIComponent(cm[1]) : '';
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    if (tokenMeta) headers['X-CSRF-TOKEN'] = tokenMeta;
    if (tokenCookie) headers['X-XSRF-TOKEN'] = tokenCookie;
    const r = await fetch('/chatlist/store', { method: 'POST', headers, body: JSON.stringify(payload) });
    const status = r.status;
    const ct = r.headers.get('content-type') || '';
    const finalUrl = r.url;
    const text = await r.text();
    const diag = { status, ct, finalUrl, temMeta: !!tokenMeta, temCookie: !!tokenCookie };
    if (ct.includes('json')) { try { return { ok: true, data: JSON.parse(text) }; } catch (e) { return { erro: 'JSON inválido', ...diag, amostra: text.slice(0, 400) }; } }
    return { erro: 'não-JSON', ...diag, amostra: text.slice(0, 400).replace(/\s+/g, ' ') };
  });
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
      doc.querySelectorAll('tr').forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length >= 2) { const k = (tds[0].innerText || '').trim(); const v = (tds[1].innerText || '').trim(); if (k) out[k] = v; }
      });
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

try {
  log('Abrindo o ChatGuru com a sessão salva...');
  await page.goto(BASE + '/chats', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  if (/\/login/i.test(page.url())) {
    log('❌ A sessão expirou (voltou pro login). Rode o seed-login.mjs de novo pra renovar.');
    await browser.close(); process.exit(2);
  }
  log('Sessão OK. Buscando conversas EM ABERTO...\n');

  const res = await chatlistAbertos();
  if (res.erro) {
    log('❌ Erro ao listar /chatlist/store:', res.erro);
    log('   status:', res.status, '| content-type:', res.ct, '| URL final:', res.finalUrl);
    log('   csrf meta:', res.temMeta, '| csrf cookie:', res.temCookie);
    log('   Resposta (trecho):', res.amostra);
    await browser.close(); process.exit(1);
  }
  const todos = (res.data && res.data.chats) || [];

  // FLUXO PRINCIPAL: "Ninguém Delegado" (users_delegated_ids vazio) — é de onde saem os leads novos.
  const semDeleg = todos.filter(c => !((c.users_delegated_ids || []).length))
    .map(c => ({ id: c.id, name: c.name, wa: c.wa_chat_id }));
  // SECUNDÁRIO: delegados aos 3 operadores (retornos esporádicos).
  const dosOper = todos.filter(c => (c.users_delegated_ids || []).some(id => ATTEND[id]))
    .map(c => { const aid = (c.users_delegated_ids || []).find(id => ATTEND[id]); return { id: c.id, name: c.name, wa: c.wa_chat_id, attendant: ATTEND[aid] }; });

  log(`===== ABERTOS: ${todos.length} no total =====`);
  log(`  ▶ NINGUÉM DELEGADO (fluxo principal de leads): ${semDeleg.length}`);
  log(`  ▶ delegados aos 3 operadores (retornos esporádicos): ${dosOper.length}`);
  log('\n--- NINGUÉM DELEGADO (os que viram lead) ---');
  semDeleg.forEach((a, i) => log(`${String(i + 1).padStart(2)}. ${a.name || '(sem nome)'} — ${a.wa || a.id}`));

  const AMOSTRA = Math.min(4, semDeleg.length);
  log(`\n===== AMOSTRA dos ${AMOSTRA} primeiros SEM DELEGADO (campos do bot + mensagens do cliente) =====`);
  for (let i = 0; i < AMOSTRA; i++) {
    const a = semDeleg[i];
    log(`\n--- ${i + 1}) ${a.name || '(sem nome)'} | ${a.wa || ''} | chatId=${a.id} ---`);
    const cf = await customFields(a.id);
    log('  Campos do bot:', JSON.stringify(cf));
    const msgs = await mensagensCliente(a.id);
    log('  Mensagens do cliente:');
    msgs.forEach(m => log('     • ' + m));
    await page.waitForTimeout(400);
  }
  log('\n===== fim (nada foi gravado) =====');
  await browser.close(); process.exit(0);
} catch (e) {
  log('ERRO inesperado:', String(e && e.message || e).split('\n')[0]);
  await browser.close(); process.exit(1);
}
