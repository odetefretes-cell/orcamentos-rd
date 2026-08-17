#!/usr/bin/env node
/* ============================================================================
 *  seed-login.mjs — login UMA VEZ no ChatGuru (fecha pop-ups, passa o codigo de
 *  verificacao se pedir) e SALVA a sessao (cookies) para o robo reusar.
 *
 *  Uso (como obsrobo, dentro de /opt/obs-robo):  node seed-login.mjs
 *  Se cair na tela de codigo: leia o codigo no email do robo e rode
 *        echo 'OCODIGO' > /opt/obs-robo/estado/codigo.txt
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

async function fecharPopups(page) {
  const alvos = [
    '[aria-label="Close"]', '[aria-label="Fechar"]', 'button.close', '.close',
    '.modal .close', '.swal2-close', 'button:has-text("Fechar")', 'button:has-text("Depois")',
    'button:has-text("Agora não")', 'button:has-text("Agora nao")', 'button:has-text("Entendi")',
    'button:has-text("Não, obrigado")', 'button:has-text("Nao, obrigado")', 'button:has-text("Pular")',
    'button:has-text("Lembrar depois")', 'button:has-text("Dispensar")', '[class*="close" i] >> visible=true',
  ];
  for (let round = 0; round < 4; round++) {
    let fechou = false;
    for (const s of alvos) {
      try {
        const b = page.locator(s).first();
        if (await b.count() && await b.isVisible().catch(() => false)) {
          await b.click({ timeout: 1500 }).catch(() => {});
          fechou = true; await page.waitForTimeout(400);
        }
      } catch {}
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
    if (!fechou) break;
  }
}

async function diagnostico(page, tag) {
  const inputs = await page.$$eval('input', els => els.map(e => ({
    type: e.type, name: e.name || '', id: e.id || '', ph: e.placeholder || '', vis: !!(e.offsetParent),
  }))).catch(() => []);
  const checks = await page.$$eval('input[type=checkbox]', els => els.map(e => ({ name: e.name || '', id: e.id || '' }))).catch(() => []);
  const botoes = await page.$$eval('button', els => els.slice(0, 14).map(e => (e.innerText || '').trim()).filter(Boolean)).catch(() => []);
  const alertas = await page.$$eval('[role=alert], .alert, .toast, .swal2-popup, .swal2-html-container, [class*="error" i], [class*="invalid" i], [class*="danger" i]',
    els => els.slice(0, 8).map(e => (e.innerText || '').trim()).filter(Boolean)).catch(() => []);
  const texto = ((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 900);
  log(`--- DIAGNOSTICO (${tag}) ---`);
  log('URL     :', page.url());
  log('inputs  :', JSON.stringify(inputs));
  log('checks  :', JSON.stringify(checks));
  log('botoes  :', JSON.stringify(botoes));
  log('alertas :', JSON.stringify(alertas));
  log('texto   :', texto);
  log('--- fim diagnostico ---');
}

async function estaLogado(page) {
  const url = page.url();
  if (/\/login|\/signin/i.test(url)) return false;   // URL de login = NÃO logado (mesmo com ?uri=/chats)
  const nPass = await page.locator('input[type=password]:visible').count().catch(() => 0);
  return /\/chats?(\b|\/|\?|$)/i.test(url) || nPass === 0;
}
async function ehTelaCodigo(page) {
  const html = (await page.content().catch(() => '')).toLowerCase();
  const temTextoCodigo = /c[oó]digo de verifica|c[oó]digo enviado|token|autentica[cç][aã]o de dois|verifica[cç][aã]o|one-time|otp/.test(html);
  const nPass = await page.locator('input[type=password]:visible').count().catch(() => 0);
  const nOutros = await page.locator('input[type=text]:visible, input[type=tel]:visible, input[type=number]:visible, input[inputmode=numeric]:visible, input[autocomplete="one-time-code"]:visible').count().catch(() => 0);
  // tela de codigo: sem senha visivel, tem campo de texto/numero, e o texto fala de codigo/verificacao
  return nPass === 0 && nOutros >= 1 && temTextoCodigo;
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({
  locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1440, height: 900 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

try {
  log('Abrindo a tela de login...');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  log('Fechando pop-ups/avisos, se houver...');
  await fecharPopups(page);

  const campoUser = page.locator('input[type="email"], input[name="email"], input[name="username"], input[name="login"], input[id*="mail" i]').first();
  const campoPass = page.locator('input[type="password"]').first();
  await campoUser.waitFor({ timeout: 20000 });
  await campoUser.fill(USER);
  await campoPass.fill(PASS);
  await page.waitForTimeout(500);
  log('Enviando usuario e senha (clicando em Acessar)...');
  const botaoLogin = page.locator('button:has-text("Acessar"), button[type="submit"], input[type="submit"], button:has-text("Entrar"), button:has-text("Login")').first();
  await botaoLogin.click({ timeout: 8000 }).catch(async () => { await campoPass.press('Enter').catch(() => {}); });
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4500);
  await fecharPopups(page);

  await page.screenshot({ path: path.join(DIR, 'seed-apos-login.png') }).catch(() => {});

  if (await estaLogado(page)) {
    await page.goto(CHATS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await ctx.storageState({ path: SESSAO }); fs.chmodSync(SESSAO, 0o600);
    log('OK: entrou direto, sem pedir codigo. Sessao salva em', SESSAO, '| URL:', page.url());
    await browser.close(); process.exit(0);
  }

  await diagnostico(page, 'apos login');

  if (!(await ehTelaCodigo(page))) {
    log('AVISO: nao parece a tela de codigo (nem entrou). Veja o diagnostico acima.');
    log('Se ainda estiver na tela de login, provavelmente o login nao passou (senha, pop-up ou anti-robo).');
    await browser.close(); process.exit(2);
  }

  // Tela de codigo: tenta marcar "confiar/lembrar" e espera o codigo
  for (const sel of ['input[type=checkbox]']) {
    try { const c = page.locator(sel).first(); if (await c.count() && await c.isVisible().catch(() => false)) { await c.check({ timeout: 2000 }).catch(() => {}); log('marquei um checkbox (possivel "confiar/lembrar")'); } } catch {}
  }
  if (fs.existsSync(CODIGO_FILE)) fs.unlinkSync(CODIGO_FILE);
  log('==================================================================');
  log('TELA DE CODIGO detectada! AGUARDANDO O CODIGO.');
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

  const digs = codigo.replace(/\D/g, '').split('');
  const caixas = page.locator('input[name="code_number"], input[autocomplete="one-time-code"], input[inputmode="numeric"]:visible, input[type="number"]:visible, input[type="tel"]:visible');
  const nb = await caixas.count().catch(() => 0);
  if (nb >= 2) {
    log(`Detectei ${nb} caixinhas de 1 digito — preenchendo uma a uma (${digs.length} digitos).`);
    for (let k = 0; k < Math.min(nb, digs.length); k++) {
      await caixas.nth(k).click().catch(() => {});
      await caixas.nth(k).fill(digs[k]).catch(() => {});
      await page.waitForTimeout(120);
    }
  } else if (nb === 1) {
    await caixas.first().fill(codigo).catch(() => {});
  } else {
    const alt = page.locator('input[type="text"]:visible, input[name*="cod" i], input[name*="token" i], input[name*="otp" i]').first();
    if (await alt.count()) await alt.fill(codigo).catch(() => {});
  }
  await page.waitForTimeout(600);
  await Promise.race([
    page.locator('button:has-text("Confirmar"), button:has-text("Verificar"), button:has-text("Validar"), button:has-text("Acessar"), button:has-text("Enviar"), button:has-text("Entrar"), button[type="submit"], input[type="submit"]').first().click({ timeout: 8000 }).catch(() => {}),
    page.keyboard.press('Enter').catch(() => {}),
  ]).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4500);
  await fecharPopups(page);
  await page.screenshot({ path: path.join(DIR, 'seed-final.png') }).catch(() => {});

  await page.goto(CHATS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);

  if (await estaLogado(page)) {
    await ctx.storageState({ path: SESSAO }); fs.chmodSync(SESSAO, 0o600);
    log('SUCESSO! Entrou e a sessao foi salva em', SESSAO, '| URL:', page.url());
    await browser.close(); process.exit(0);
  } else {
    await diagnostico(page, 'apos o codigo (ainda nao entrou)');
    log('ERRO: nao confirmou o login apos o codigo.');
    await browser.close(); process.exit(1);
  }
} catch (e) {
  log('ERRO inesperado:', String(e && e.message || e).split('\n')[0]);
  try { await page.screenshot({ path: path.join(DIR, 'seed-erro.png') }); } catch {}
  await browser.close(); process.exit(1);
}
