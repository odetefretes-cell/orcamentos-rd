#!/usr/bin/env node
/* ============================================================================
 *  seed-login.mjs — login UMA VEZ no ChatGuru passando o codigo de verificacao,
 *  e SALVA a sessao (cookies) para o robo reusar sem logar de novo.
 *
 *  Uso (roda como obsrobo, dentro de /opt/obs-robo):
 *     node seed-login.mjs
 *  Ele loga com CHATGURU_LOGIN_USER/PASS. Se cair na tela de codigo:
 *   - mostra um DIAGNOSTICO da tela (pra ajustar se preciso);
 *   - fica AGUARDANDO o arquivo estado/codigo.txt aparecer;
 *   - voce le o codigo no email do robo e roda, em outro terminal:
 *        echo 'OCODIGO' > /opt/obs-robo/estado/codigo.txt
 *   - ele digita o codigo, entra e salva estado/chatguru-sessao.json
 *
 *  So LE/loga. Nao envia mensagem, nao grava nada no Firestore.
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
try { const d = await import('dotenv'); d.config({ path: fs.existsSync('/etc/obs-robo/.env') ? '/etc/obs-robo/.env' : '.env', quiet: true }); } catch {}

const DIR = process.cwd();
const ESTADO = path.join(DIR, 'estado');
const SESSAO = path.join(ESTADO, 'chatguru-sessao.json');
const CODIGO_FILE = path.join(ESTADO, 'codigo.txt');
const LOGIN_URL = process.env.CHATGURU_LOGIN_URL || 'https://s22.chatguru.app/login';
const CHATS_URL = 'https://s22.chatguru.app/chats';
const USER = process.env.CHATGURU_LOGIN_USER;
const PASS = process.env.CHATGURU_LOGIN_PASS;
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('pt-BR')}]`, ...a);

if (!USER || !PASS) { log('ERRO: CHATGURU_LOGIN_USER/PASS ausentes no .env'); process.exit(1); }
fs.mkdirSync(ESTADO, { recursive: true });

async function diagnostico(page, tag) {
  const inputs = await page.$$eval('input', els => els.map(e => ({
    type: e.type, name: e.name || '', id: e.id || '', ph: e.placeholder || '',
    im: e.getAttribute('inputmode') || '', vis: !!(e.offsetParent),
  }))).catch(() => []);
  const checks = await page.$$eval('input[type=checkbox]', els => els.map(e => ({ name: e.name || '', id: e.id || '' }))).catch(() => []);
  const botoes = await page.$$eval('button', els => els.slice(0, 12).map(e => (e.innerText || '').trim()).filter(Boolean)).catch(() => []);
  const texto = ((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 500);
  log(`--- DIAGNOSTICO (${tag}) ---`);
  log('URL     :', page.url());
  log('inputs  :', JSON.stringify(inputs));
  log('checks  :', JSON.stringify(checks));
  log('botoes  :', JSON.stringify(botoes));
  log('texto   :', texto);
  log('--- fim diagnostico ---');
}

async function jaLogado(page) {
  const html = await page.content().catch(() => '');
  return /\/chats?(\b|\/|\?|$)/i.test(page.url()) && !/type="password"/i.test(html);
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({
  locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1440, height: 900 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

try {
  log('Abrindo a tela de login...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

  const campoUser = page.locator('input[type="email"], input[name="email"], input[name="username"], input[name="login"], input[id*="mail" i]').first();
  const campoPass = page.locator('input[type="password"]').first();
  await campoUser.waitFor({ timeout: 20000 });
  await campoUser.fill(USER);
  await campoPass.fill(PASS);
  log('Enviando usuario e senha...');
  await Promise.race([
    page.locator('button[type="submit"], input[type="submit"], button:has-text("Entrar"), button:has-text("Login")').first().click({ timeout: 8000 }).catch(() => {}),
    campoPass.press('Enter'),
  ]).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3500);

  if (await jaLogado(page)) {
    await ctx.storageState({ path: SESSAO }); fs.chmodSync(SESSAO, 0o600);
    log('OK: entrou direto, sem pedir codigo. Sessao salva em', SESSAO);
    await browser.close(); process.exit(0);
  }

  await diagnostico(page, 'tela apos login (provavel codigo)');
  await page.screenshot({ path: path.join(DIR, 'seed-codigo.png') }).catch(() => {});

  // Tenta marcar alguma opcao de "confiar/lembrar deste dispositivo" (se existir)
  for (const sel of ['input[type=checkbox]']) {
    try { const c = page.locator(sel).first(); if (await c.count()) { await c.check({ timeout: 2500 }).catch(() => {}); log('marquei um checkbox (possivel "confiar/lembrar")'); } } catch {}
  }

  // Espera o codigo chegar via arquivo
  if (fs.existsSync(CODIGO_FILE)) fs.unlinkSync(CODIGO_FILE);
  log('==================================================================');
  log('AGUARDANDO O CODIGO.');
  log('1) Leia o codigo no email do robo (chatgururoboobs@gmail.com).');
  log('2) Rode no terminal (troque 123456 pelo codigo):');
  log(`      echo '123456' > ${CODIGO_FILE}`);
  log('Vou verificar a cada 5s por ate ~16 minutos...');
  log('==================================================================');

  let codigo = null;
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(CODIGO_FILE)) {
      codigo = ((fs.readFileSync(CODIGO_FILE, 'utf8')) || '').trim();
      try { fs.unlinkSync(CODIGO_FILE); } catch {}
      if (codigo) break;
    }
    await page.waitForTimeout(5000);
  }
  if (!codigo) { log('ERRO: nao recebi o codigo a tempo. Rode o script de novo.'); await browser.close(); process.exit(1); }
  log(`Codigo recebido (${codigo.length} digitos). Preenchendo...`);

  // Campo do codigo: input visivel de texto/numero que nao seja email/senha
  const campoCod = page.locator('input[type="text"]:visible, input[type="tel"]:visible, input[type="number"]:visible, input[inputmode="numeric"]:visible, input[name*="cod" i], input[name*="token" i], input[name*="otp" i], input[autocomplete="one-time-code"]').first();
  let preencheu = false;
  if (await campoCod.count()) {
    await campoCod.fill(codigo).then(() => { preencheu = true; }).catch(() => {});
  }
  if (!preencheu) {
    // pode ser varios campos de 1 digito
    const campos = page.locator('input:visible');
    const n = await campos.count();
    for (let k = 0; k < Math.min(n, codigo.length); k++) { await campos.nth(k).fill(codigo[k]).catch(() => {}); }
  }
  await page.waitForTimeout(600);
  await Promise.race([
    page.locator('button[type="submit"], input[type="submit"], button:has-text("Confirmar"), button:has-text("Verificar"), button:has-text("Validar"), button:has-text("Enviar"), button:has-text("Entrar")').first().click({ timeout: 8000 }).catch(() => {}),
    page.keyboard.press('Enter').catch(() => {}),
  ]).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(DIR, 'seed-final.png') }).catch(() => {});

  // Confirma abrindo /chats
  await page.goto(CHATS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);

  if (await jaLogado(page)) {
    await ctx.storageState({ path: SESSAO }); fs.chmodSync(SESSAO, 0o600);
    log('SUCESSO! Entrou e a sessao foi salva em', SESSAO, '| URL:', page.url());
    await browser.close(); process.exit(0);
  } else {
    await diagnostico(page, 'apos o codigo (ainda nao entrou)');
    log('ERRO: nao confirmou o login apos o codigo. Veja o diagnostico acima e o seed-final.png.');
    await browser.close(); process.exit(1);
  }
} catch (e) {
  log('ERRO inesperado:', String(e && e.message || e).split('\n')[0]);
  try { await page.screenshot({ path: path.join(DIR, 'seed-erro.png') }); } catch {}
  await browser.close(); process.exit(1);
}
