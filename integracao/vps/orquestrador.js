/* ============================================================================
   OBS Transportes — Orquestrador STANDALONE (Hostinger VPS)

   Roda o MESMO pipeline das Cloud Functions, sem Firebase: Express recebe os
   webhooks, node-cron faz o papel do Cloud Scheduler e a cadeia de gatilhos do
   Firestore é reconstruída pelo driver (driver.js).

   Como os requires do pipeline resolvem para a plataforma nova:
     - NODE_PATH inclui ./stubs (firebase-functions/*, firebase-admin/*) e
       ./node_modules ANTES de carregar o pipeline. Module._initPaths() aplica.
     - firebase-functions/v2/* → devolvem o handler cru (sem registrar gatilho).
     - firebase-admin/firestore → getFirestore()/FieldValue da pg-compat (PostgreSQL).
     - @anthropic-ai/sdk é dependência normal (node_modules), achada via NODE_PATH.

   NÃO altera nenhum arquivo do pipeline (webhook.js e cia. seguem byte-idênticos,
   servindo de rollback para as Cloud Functions).
   ============================================================================ */

'use strict';

const path = require('path');
const Module = require('module');

/* ---- 1) Torna os stubs vendorizados + node_modules local resolvíveis ANTES
         de carregar o pipeline. --------------------------------------------- */
const STUBS = path.join(__dirname, 'stubs');
const NM = path.join(__dirname, 'node_modules');
process.env.NODE_PATH = [STUBS, NM, process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
Module._initPaths();

/* ---- 2) Ambiente -------------------------------------------------------------
   .env carregado pelo dotenv (ou pelo PM2 via env). Este serviço SEMPRE fala
   com o PostgreSQL (via a API do servidor), então força OBS_USAR_PG. */
try { require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '/etc/obs-automacao/.env' }); } catch (_) { /* dotenv opcional */ }
if (!process.env.OBS_USAR_PG) process.env.OBS_USAR_PG = 'true';

const express = require('express');
const cron = require('node-cron');

/* ---- 3) Carrega o pipeline INALTERADO (os requires resolvem p/ os stubs) --- */
const pipeline = require('../webhook.js');
const {
  obsIntegracao,
  chatguruWebhook,
  fecharLeadsCompletos,
  processarLeadCompleto,
  criarLeadNoCrm,
  enviarPendentesPG,
  preCadastrarLead,
  openerDisparou,
} = pipeline;

/* db compatível (para o driver montar os events e listar o intake). */
const { getFirestore } = require('firebase-admin/firestore'); // → pg-compat
const fsdb = getFirestore();
const { listar } = require('../pg-api');

/* ---- 4) Driver da cadeia de gatilhos -------------------------------------- */
const { criarDriver } = require('./driver');
const driver = criarDriver({
  fsdb,
  listar,
  handlers: { fecharLeadsCompletos, processarLeadCompleto, criarLeadNoCrm, enviarPendentesPG },
});

/* ---- 5) HTTP (Express) ----------------------------------------------------- */
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// CORS — o formulário do site (github.io) chama /webhook/precadastro pelo NAVEGADOR,
// que exige cabeçalho de permissão + responder o preflight OPTIONS. O stub do VPS não
// aplica o `cors:true` das funções, então tratamos aqui. Endpoints públicos, sem
// cookie/token e sem dado sensível na resposta → liberar '*' é seguro (só afeta browser).
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});

// Health
app.get('/webhook/health', (req, res) => {
  res.json({ ok: true, servico: 'obs-automacao', pgMode: process.env.OBS_USAR_PG === 'true', ts: new Date().toISOString() });
});

// ChatGuru (entrada de leads / encaminhador / botão do atendente)
app.all('/webhook/chatguru', (req, res) => chatguruWebhook(req, res));

// Ponte legada de cotação (obsIntegracao inspeciona req.path p/ decidir a rota)
app.all('/cotar', (req, res) => obsIntegracao(req, res));
app.all('/interesse', (req, res) => obsIntegracao(req, res));

// Pré-cadastro do formulário do site + disparo do Opener.
// Expomos TAMBÉM sob /webhook/* porque o Caddy só encaminha /webhook/* para este
// serviço (3001). Assim o formulário chama https://api.obstransportes.com.br/webhook/precadastro.
// (As rotas curtas seguem para compatibilidade/uso interno.)
app.all(['/precadastro', '/webhook/precadastro'], (req, res) => preCadastrarLead(req, res));
app.all(['/opener', '/webhook/opener'], (req, res) => openerDisparou(req, res));

// Envio direto de mensagem ao cliente pelo ChatGuru (botões do financeiro no app).
// SÓ com o segredo compartilhado (o obs-api injeta o X-OBS-Secret — nunca o navegador).
const { enviarMensagem } = require('../chatguru-api');
app.post(['/enviar-cliente', '/webhook/enviar-cliente'], async (req, res) => {
  try {
    const seg = req.get('x-obs-secret') || '';
    if (!process.env.OBS_SHARED_SECRET || seg !== process.env.OBS_SHARED_SECRET) {
      return res.status(401).json({ ok: false, erro: 'não autorizado' });
    }
    const { telefone, texto } = req.body || {};
    if (!telefone || !texto) return res.status(400).json({ ok: false, erro: 'informe telefone e texto' });
    const r = await enviarMensagem({ chatNumber: telefone, texto });
    console.log(`[enviar-cliente] → ${telefone}: ${String(texto).slice(0, 60)}…`);
    res.json({ ok: true, chatguru: r });
  } catch (e) {
    console.error('[enviar-cliente] ERRO:', e.message || e);
    res.status(200).json({ ok: false, erro: e.message || String(e) });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[orquestrador] HTTP ouvindo em http://${HOST}:${PORT}`);
  console.log(`[orquestrador] OBS_USAR_PG=${process.env.OBS_USAR_PG} | OBS_API_URL=${process.env.OBS_API_URL || '(padrão)'}`);
});

/* ---- 6) Cron (TZ America/Sao_Paulo), 1x por minuto ------------------------- */
let rodando = false;
cron.schedule('* * * * *', async () => {
  if (rodando) { console.warn('[cron] ciclo anterior ainda rodando — pula esta volta.'); return; }
  rodando = true;
  const t0 = Date.now();
  try {
    await driver.drivePipelineOnce();
    console.log(`[cron] ciclo OK em ${Date.now() - t0}ms.`);
  } catch (e) {
    console.error('[cron] erro no ciclo:', (e && e.stack) || e);
  } finally {
    rodando = false;
  }
}, { timezone: 'America/Sao_Paulo' });

console.log('[orquestrador] cron agendado: * * * * * (America/Sao_Paulo).');

module.exports = { app, driver, pipeline };
