/* ============================================================================
   Teste de conexão do robô OBS (roda no VPS) — 100% SEGURO: só LÊ, não grava nada,
   não manda mensagem pra ninguém. Serve só pra provar o "encanamento" antes de
   escrever a captação.

     1) Firestore: confere que a chave de administrador funciona e LÊ crm_config/config
        + conta quantos leads existem (só leitura).
     2) ChatGuru: abre o Chromium headless na tela de login e confirma que o navegador
        roda no servidor. (O login real — preencher usuário/senha — eu ajusto quando
        vir a tela; cada painel tem os campos com nomes próprios.)

   Rodar no VPS:  cd robo && npm install && node testar-conexao.js
   ============================================================================ */
require('dotenv').config();
const fs = require('fs');
const admin = require('firebase-admin');

// Aceita a chave do Firebase de 3 jeitos (o mais fácil primeiro):
//  1) arquivo robo/serviceAccount.json (só salvar o JSON baixado ali) — PADRÃO;
//  2) FIREBASE_SERVICE_ACCOUNT = caminho de um arquivo .json;
//  3) FIREBASE_SERVICE_ACCOUNT = o JSON inteiro numa linha.
function carregarCredencial() {
  const v = (process.env.FIREBASE_SERVICE_ACCOUNT || './serviceAccount.json').trim();
  if (v.startsWith('{')) return JSON.parse(v);
  if (fs.existsSync(v)) return JSON.parse(fs.readFileSync(v, 'utf8'));
  return null;
}

async function testarFirestore() {
  let cred;
  try { cred = carregarCredencial(); }
  catch (e) { console.log('❌ Firestore: chave inválida —', e.message); return; }
  if (!cred) { console.log('❌ Firestore: não achei a chave. Salve o JSON em robo/serviceAccount.json (ou aponte FIREBASE_SERVICE_ACCOUNT).'); return; }
  admin.initializeApp({ credential: admin.credential.cert(cred) });
  const db = admin.firestore();
  const cfg = await db.collection('crm_config').doc('config').get();
  const total = (await db.collection('crm_leads').count().get()).data().count;
  console.log(`✅ Firestore OK — projeto ${cred.project_id} | crm_config/config existe: ${cfg.exists} | leads no CRM: ${total}`);
}

async function testarChatguru() {
  const base = process.env.CHATGURU_URL_WEB || 'https://s22.chatguru.app';
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) { console.log('❌ Playwright não instalado. Rode: npx playwright install --with-deps chromium'); return; }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(base + '/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const titulo = await page.title();
    console.log(`✅ ChatGuru: Chromium headless OK — abriu ${base}/login (título: "${titulo}").`);
    if (!process.env.CHATGURU_LOGIN_USER || !process.env.CHATGURU_LOGIN_PASS) {
      console.log('   ℹ️  Login do robô ainda não configurado (CHATGURU_LOGIN_USER/PASS) — o login real entra no próximo passo.');
    }
  } finally { await browser.close(); }
}

(async () => {
  console.log('===== Teste de conexão do robô OBS =====');
  try { await testarFirestore(); } catch (e) { console.log('❌ Firestore erro:', e.message); }
  try { await testarChatguru(); } catch (e) { console.log('❌ ChatGuru/Chromium erro:', e.message); }
  console.log('===== fim =====');
  process.exit(0);
})();
