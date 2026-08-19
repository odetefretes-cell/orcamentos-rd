/* ============================================================================
   OBS — selftest.mjs  (teste ponta-a-ponta do orquestrador, TUDO em memória)

   Carrega o pipeline REAL (webhook.js e cia., inalterados), mas com:
     - firebase-functions/* e firebase-admin/*  → test-stubs (via NODE_PATH)
     - firebase-admin/firestore → banco EM MEMÓRIA (test-stubs/memstore.js)
     - @anthropic-ai/sdk        → mock (extração canônica 'automatico')
     - ../pg-api                → mock em memória (require.cache)
     - ../chatguru-api          → mock (enviarMensagem conta os envios)
     - ../calc-fretes           → mock (média fixa R$ 1040)

   Depois: empurra 1 webhook do ChatGuru por chatguruWebhook, roda a cadeia do
   cron 1x (driver.drivePipelineOnce) e verifica:
     1. o lead foi criado em crm_leads (lead_wpp_{últimos8});
     2. o envio saiu EXATAMENTE 1x (respostaEnviada reivindicada);
     3. rodar de novo NÃO reenvia (idempotência).

   Uso: node integracao/vps/selftest.mjs
   ============================================================================ */

import { createRequire } from 'module';
import Module from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FALHOU:', msg); throw new Error('ASSERT: ' + msg); }
  console.log('  ✓', msg);
}

/* ---- ambiente ---- */
process.env.OBS_USAR_PG = 'true';
process.env.CHATGURU_API_KEY = 'x';
process.env.CHATGURU_ACCOUNT_ID = 'x';
process.env.CHATGURU_PHONE_ID = 'x';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.VENDEDORES = 'Yasmim Freitas,Thiago Lucca,Flavia Ottati';

/* ---- 1) NODE_PATH → test-stubs (firebase-*, @anthropic-ai/sdk) ---- */
const TSTUBS = path.join(__dirname, 'test-stubs');
process.env.NODE_PATH = [TSTUBS, process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
Module._initPaths();

/* ---- 2) store em memória + seed do envioAtivo ---- */
const mem = require('./test-stubs/memstore.js');
mem.store.crm_config = { config: { envioAtivo: true } };

/* ---- 3) injeta mocks dos requires relativos do pipeline (require.cache) ---- */
let enviarCount = 0;
let contextoCount = 0;
const chatguruMock = {
  enviarMensagem: async (a) => { enviarCount++; console.log(`    [MOCK enviarMensagem #${enviarCount}] -> ${a.chatNumber}`); return { message_id: 'MOCK' + enviarCount, result: 'success' }; },
  atualizarContexto: async () => { contextoCount++; return { result: 'success' }; },
  criarChat: async () => ({ result: 'success' }),
  normalizarNumeroBR: (n) => String(n == null ? '' : n).replace(/\D/g, ''),
};
const calcMock = {
  calcularFrete: async () => ({ ok: true, valorEstimado: '1040', valorCotacaoSW: '1040', prazoSW: '7', trajetos: [], composicao: [] }),
  _internos: {},
};

function injectCache(relPath, exportsObj) {
  const abs = require.resolve(relPath);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
  return abs;
}
injectCache('../chatguru-api.js', chatguruMock);
injectCache('../pg-api.js', mem.pgApiMock);
injectCache('../calc-fretes.js', calcMock);

/* ---- 4) carrega o pipeline REAL (resolve via stubs/mocks) ---- */
const pipeline = require('../webhook.js');

console.log('\n== Verificação de carga (requires resolvem via stubs) ==');
for (const nome of ['chatguruWebhook', 'fecharLeadsCompletos', 'processarLeadCompleto', 'criarLeadNoCrm', 'prepararResposta', 'enviarPendentesPG', 'obsIntegracao', 'preCadastrarLead', 'openerDisparou']) {
  assert(typeof pipeline[nome] === 'function', `pipeline.${nome} é função`);
}

/* ---- 5) monta o driver com os mocks ---- */
const { criarDriver } = require('./driver.js');
const driver = criarDriver({
  fsdb: mem.db,
  listar: mem.listar,
  handlers: {
    fecharLeadsCompletos: pipeline.fecharLeadsCompletos,
    processarLeadCompleto: pipeline.processarLeadCompleto,
    criarLeadNoCrm: pipeline.criarLeadNoCrm,
    enviarPendentesPG: pipeline.enviarPendentesPG,
  },
});

/* ---- helpers de req/res ---- */
function mockRes() {
  return { _status: 200, _json: null, status(s) { this._status = s; return this; }, json(j) { this._json = j; return this; } };
}

async function run() {
  console.log('\n== 1) POST webhook do ChatGuru (com marcador "fechar" → fecha na hora) ==');
  const req = {
    method: 'POST',
    get: () => '',
    body: {
      celular: '5511999998888',
      nome: 'Cliente Teste',
      texto_mensagem: 'Origem Santo André SP, destino Betim MG, carro passeio, valor R$ 50.000',
      acao: 'fechar',   // marcador (querFecharAgora) → statusIntake=completo imediato
    },
  };
  const res = mockRes();
  await pipeline.chatguruWebhook(req, res);
  console.log('    resposta webhook:', JSON.stringify(res._json));
  assert(res._json && res._json.ok, 'webhook respondeu ok');
  const intake0 = mem.store.crm_leads_intake['5511999998888'];
  assert(intake0 && intake0.statusIntake === 'completo', 'intake marcado completo na hora');

  console.log('\n== 2) roda a cadeia do cron 1x (fechar → IA → criarLead → enviar) ==');
  await driver.drivePipelineOnce();

  const intake1 = mem.store.crm_leads_intake['5511999998888'];
  assert(intake1.iaProcessado === true, 'IA processou o intake');
  assert(intake1.statusIntake === 'automatico', 'decisão = automatico');
  assert(intake1.leadCriado === true, 'lead marcado como criado no intake');

  const lead = mem.store.crm_leads['lead_wpp_99998888'];
  assert(!!lead, 'lead criado em crm_leads (lead_wpp_99998888)');
  assert(lead.origemLead === 'whatsapp', 'origemLead = whatsapp');
  assert(String(lead.valorEstimado) === '1040', 'média R$ 1040 gravada no lead');
  assert(lead.respostaEnviada === true, 'respostaEnviada reivindicada (claim)');
  assert(enviarCount === 1, `enviarMensagem chamado EXATAMENTE 1x (foi ${enviarCount})`);

  console.log('\n== 3) idempotência: roda a cadeia de novo → NÃO reenvia ==');
  await driver.drivePipelineOnce();
  assert(enviarCount === 1, `sem envio duplicado no re-run (continua ${enviarCount})`);

  console.log('\n==== SELFTEST PASSOU ====');
}

run().catch((e) => { console.error('\n==== SELFTEST FALHOU ====\n', e); process.exit(1); });
