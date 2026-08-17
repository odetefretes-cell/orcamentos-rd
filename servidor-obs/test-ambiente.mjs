#!/usr/bin/env node
/* ===========================================================================
 *  OBS Transportes - Teste de ambiente do robo (somente LEITURA)
 *
 *  O que testa, em ordem:
 *    A. Node 20+                          E. ChatGuru: API responde
 *    B. Chromium headless abre pagina     F. ChatGuru: login na tela (Playwright)
 *    C. Variaveis de ambiente presentes   G. Salva a sessao para reuso
 *    D. Firestore: le o banco (nao grava)
 *
 *  NUNCA imprime o valor de nenhum segredo - so "definida / faltando" e
 *  os 4 ultimos caracteres em alguns casos, para conferencia.
 *  NAO grava nada no Firestore. NAO envia nenhuma mensagem no ChatGuru.
 *
 *  Uso:   node test-ambiente.mjs
 *         node test-ambiente.mjs --sem-login     (pula os testes F/G)
 * =========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ARGS = process.argv.slice(2);
const PULAR_LOGIN = ARGS.includes('--sem-login');
const DIR = process.cwd();
const SESSAO = path.join(DIR, 'estado', 'chatguru-sessao.json');

const resultados = [];
let falhas = 0, avisos = 0;

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', b: '\x1b[1m', x: '\x1b[0m' };
const titulo = (t) => console.log(`\n${C.b}=== ${t} ===${C.x}`);
function reg(nome, estado, detalhe = '') {
  const tag = estado === 'ok' ? `${C.g}  OK  ${C.x}` : estado === 'aviso' ? `${C.y} AVISO${C.x}` : `${C.r} FALHA${C.x}`;
  if (estado === 'falha') falhas++;
  if (estado === 'aviso') avisos++;
  resultados.push({ nome, estado, detalhe });
  console.log(`${tag} ${nome}${detalhe ? ' -- ' + detalhe : ''}`);
}
const mascara = (v) => !v ? 'FALTANDO' : `definida (${v.length} chars, termina em ...${v.slice(-4)})`;

// ---------------------------------------------------------------- carregar .env
try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: fs.existsSync('/etc/obs-robo/.env') ? '/etc/obs-robo/.env' : '.env', quiet: true });
} catch { /* dotenv opcional */ }

// =============================================================== A. Node
titulo('A. Runtime Node.js');
const major = Number(process.versions.node.split('.')[0]);
reg('Node 20 ou superior', major >= 20 ? 'ok' : 'falha', `v${process.versions.node}`);
reg('Plataforma', 'ok', `${process.platform}/${process.arch}`);
reg('Timezone do processo', process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone === 'America/Sao_Paulo' ? 'ok' : 'aviso',
  `${Intl.DateTimeFormat().resolvedOptions().timeZone} | agora: ${new Date().toLocaleString('pt-BR')}`);
reg('Rodando como usuario', process.getuid && process.getuid() === 0 ? 'aviso' : 'ok',
  process.getuid ? `uid=${process.getuid()}${process.getuid() === 0 ? ' (root - prefira o usuario obsrobo)' : ''}` : 'n/d');

// =============================================================== C. Variaveis
titulo('C. Variaveis de ambiente (valores NAO sao exibidos)');
const OBRIGATORIAS = [
  'CHATGURU_API_URL', 'CHATGURU_API_KEY', 'CHATGURU_ACCOUNT_ID', 'CHATGURU_PHONE_ID',
  'CHATGURU_LOGIN_USER', 'CHATGURU_LOGIN_PASS', 'ANTHROPIC_API_KEY',
];
for (const k of OBRIGATORIAS) {
  const v = process.env[k];
  const publica = k === 'CHATGURU_API_URL' || k === 'CHATGURU_ACCOUNT_ID' || k === 'CHATGURU_PHONE_ID';
  reg(k, v ? 'ok' : 'falha', publica ? (v || 'FALTANDO') : mascara(v));
}
const temSA = !!(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT);
reg('FIREBASE_SERVICE_ACCOUNT(_BASE64)', temSA ? 'ok' : 'falha', temSA ? 'definida' : 'FALTANDO');
reg('DRY_RUN (modo-teste)', String(process.env.DRY_RUN) === 'true' ? 'ok' : 'aviso',
  `DRY_RUN=${process.env.DRY_RUN ?? '(nao definido)'}${String(process.env.DRY_RUN) !== 'true' ? '  <-- ligado de verdade!' : ''}`);

// =============================================================== B. Chromium
titulo('B. Chromium headless (Playwright)');
let chromium = null;
try {
  ({ chromium } = await import('playwright'));
  reg('modulo playwright', 'ok', 'importado');
} catch (e) {
  reg('modulo playwright', 'falha', e.message.split('\n')[0]);
}
if (chromium) {
  let navegador = null;
  try {
    navegador = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    reg('Chromium inicia headless', 'ok', `versao ${navegador.version()}`);
  } catch (e) {
    reg('Chromium inicia headless', 'falha', e.message.split('\n')[0]);
  }
  if (navegador) {
    // Navegar ate o proprio ChatGuru: testa o Chromium E a rede de saida do servidor
    const alvo = (process.env.CHATGURU_LOGIN_URL || 'https://s22.chatguru.app/login');
    try {
      const pg = await (await navegador.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' })).newPage();
      await pg.goto(alvo, { waitUntil: 'domcontentloaded', timeout: 40000 });
      reg('Navega e le uma pagina', 'ok', `${alvo} | titulo: "${await pg.title()}"`);
      await pg.screenshot({ path: 'teste-chromium.png' });
      reg('Tira screenshot', 'ok', 'teste-chromium.png');
    } catch (e) {
      reg('Navega e le uma pagina', 'falha', `nao alcancou ${alvo}: ${e.message.split('\n')[0]}`);
    }
    await navegador.close().catch(() => {});
  }
}

// =============================================================== D. Firestore
titulo('D. Firestore (somente leitura)');
if (!temSA) {
  reg('Conexao com o Firestore', 'falha', 'chave de servico ausente - pulado');
} else {
  try {
    const admin = (await import('firebase-admin')).default;
    let bruto = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
      ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
      : process.env.FIREBASE_SERVICE_ACCOUNT;
    const cred = JSON.parse(bruto);
    reg('Chave de servico e um JSON valido', 'ok',
      `projeto=${cred.project_id} | conta=${String(cred.client_email).replace(/^(.{6}).*(@.*)$/, '$1***$2')}`);
    if (process.env.FIREBASE_PROJECT_ID && cred.project_id !== process.env.FIREBASE_PROJECT_ID) {
      reg('project_id confere com FIREBASE_PROJECT_ID', 'aviso', `chave=${cred.project_id} env=${process.env.FIREBASE_PROJECT_ID}`);
    }
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(cred), projectId: cred.project_id });
    const db = admin.firestore();
    const t0 = Date.now();
    const cols = await db.listCollections();
    reg('Autentica e lista colecoes', 'ok',
      `${cols.length} colecoes em ${Date.now() - t0}ms: ${cols.slice(0, 12).map(c => c.id).join(', ')}${cols.length > 12 ? ' ...' : ''}`);
    if (cols.length) {
      const amostra = await cols[0].limit(1).get();
      reg(`Le documentos (colecao "${cols[0].id}")`, 'ok', `${amostra.size} doc(s) lido(s) na amostra`);
    }
    reg('Gravacao no Firestore', 'ok', 'NAO testada de proposito (teste e somente leitura)');
  } catch (e) {
    reg('Conexao com o Firestore', 'falha', String(e.message || e).split('\n')[0]);
  }
}

// =============================================================== E. ChatGuru API
titulo('E. ChatGuru API (endpoint publico)');
const API = process.env.CHATGURU_API_URL;
if (!API || !process.env.CHATGURU_API_KEY) {
  reg('Chamada na API do ChatGuru', 'aviso', 'URL ou chave ausente - pulado');
} else {
  try {
    const corpo = new URLSearchParams({
      action: 'chat_add_status', key: process.env.CHATGURU_API_KEY,
      account_id: process.env.CHATGURU_ACCOUNT_ID ?? '', phone_id: process.env.CHATGURU_PHONE_ID ?? '',
    });
    const ctl = AbortSignal.timeout(20000);
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: corpo, signal: ctl });
    const txt = (await r.text()).slice(0, 200).replace(/\s+/g, ' ');
    reg('API do ChatGuru responde', r.status < 500 ? 'ok' : 'aviso', `HTTP ${r.status} | resposta: ${txt}`);
  } catch (e) {
    reg('API do ChatGuru responde', 'aviso', String(e.message || e).split('\n')[0]);
  }
}

// =============================================================== F/G. Login
titulo('F. Login do robo no ChatGuru (raspagem de tela)');
if (PULAR_LOGIN) {
  reg('Login no ChatGuru', 'aviso', 'pulado por --sem-login');
} else if (!chromium || !process.env.CHATGURU_LOGIN_USER || !process.env.CHATGURU_LOGIN_PASS) {
  reg('Login no ChatGuru', 'falha', 'usuario/senha ausentes ou Playwright indisponivel');
} else {
  let nav = null;
  try {
    nav = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await nav.newContext({
      locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    });
    const pg = await ctx.newPage();
    const loginUrl = process.env.CHATGURU_LOGIN_URL || 'https://s22.chatguru.app/login';
    await pg.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    reg('Abre a tela de login', 'ok', `${pg.url()}`);

    const campoUser = pg.locator('input[type="email"], input[name="email"], input[name="username"], input[name="login"], input[id*="mail" i]').first();
    const campoPass = pg.locator('input[type="password"]').first();
    await campoUser.waitFor({ timeout: 20000 });
    await campoUser.fill(process.env.CHATGURU_LOGIN_USER);
    await campoPass.fill(process.env.CHATGURU_LOGIN_PASS);
    reg('Encontra os campos de usuario e senha', 'ok');

    await Promise.race([
      pg.locator('button[type="submit"], input[type="submit"], button:has-text("Entrar"), button:has-text("Login")').first().click({ timeout: 10000 }),
      campoPass.press('Enter'),
    ]).catch(() => campoPass.press('Enter'));

    await pg.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
    await pg.waitForTimeout(4000);
    await pg.screenshot({ path: 'teste-chatguru-login.png', fullPage: false });

    const url = pg.url();
    const corpo = (await pg.textContent('body').catch(() => '')) || '';
    const aindaNoLogin = /login|signin|entrar/i.test(url) && (await pg.locator('input[type="password"]').count()) > 0;
    const erroVisivel = /senha (incorreta|invalida)|credenciais|usu[aá]rio ou senha|invalid/i.test(corpo);
    const pedeCodigo = /c[oó]digo de verifica|autentica[cç][aã]o de dois|2fa|token enviado/i.test(corpo);

    if (pedeCodigo) {
      reg('Login concluido', 'falha', '>>> A conta parece exigir 2FA/codigo. Avise o Claude: muda a estrategia de sessao.');
    } else if (erroVisivel) {
      reg('Login concluido', 'falha', 'a tela mostrou erro de credenciais. Confira usuario/senha do robo.');
    } else if (aindaNoLogin) {
      reg('Login concluido', 'falha', `continuou na tela de login (${url}). Veja teste-chatguru-login.png`);
    } else {
      reg('Login concluido', 'ok', `redirecionou para ${url}`);
      // G. sessao
      fs.mkdirSync(path.dirname(SESSAO), { recursive: true });
      await ctx.storageState({ path: SESSAO });
      fs.chmodSync(SESSAO, 0o600);
      reg('Sessao salva para reuso', 'ok', `${SESSAO} (chmod 600)`);

      await pg.goto('https://s22.chatguru.app/chats', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await pg.waitForTimeout(5000);
      await pg.screenshot({ path: 'teste-chatguru-chats.png' });
      const c2 = (await pg.textContent('body').catch(() => '')) || '';
      reg('Acessa a lista de conversas (/chats)', c2.length > 500 && !/password/i.test(await pg.content()) ? 'ok' : 'aviso',
        `${c2.length} chars de texto na tela | screenshot: teste-chatguru-chats.png`);
    }
  } catch (e) {
    reg('Login no ChatGuru', 'falha', String(e.message || e).split('\n')[0]);
  } finally { if (nav) await nav.close().catch(() => {}); }
}

// =============================================================== RESUMO
titulo('RESUMO');
const ok = resultados.filter(r => r.estado === 'ok').length;
console.log(`  ${C.g}${ok} ok${C.x}  |  ${C.y}${avisos} aviso(s)${C.x}  |  ${C.r}${falhas} falha(s)${C.x}`);
if (falhas) {
  console.log(`\n  ${C.r}Itens que falharam:${C.x}`);
  for (const r of resultados.filter(r => r.estado === 'falha')) console.log(`   - ${r.nome}: ${r.detalhe}`);
}
console.log(`\n  Screenshots gerados nesta pasta (${DIR}) ajudam a diagnosticar a tela do ChatGuru.`);
console.log(`  ${C.c}Pode copiar e colar TODA esta saida para o Claude: ela nao contem segredos.${C.x}\n`);
process.exit(falhas ? 1 : 0);
