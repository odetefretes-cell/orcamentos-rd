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
try { require('dotenv').config(); } catch (_) { /* dotenv opcional */ }
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

// Health
app.get('/webhook/health', (req, res) => {
  res.json({ ok: true, servico: 'obs-automacao', pgMode: process.env.OBS_USAR_PG === 'true', ts: new Date().toISOString() });
});

// ChatGuru (entrada de leads / encaminhador / botão do atendente)
app.all('/webhook/chatguru', (req, res) => chatguruWebhook(req, res));

// Ponte legada de cotação (obsIntegracao inspeciona req.path p/ decidir a rota)
app.all('/cotar', (req, res) => obsIntegracao(req, res));
app.all('/interesse', (req, res) => obsIntegracao(req, res));

// Pré-cadastro do formulário do site + disparo do Opener
app.all('/precadastro', (req, res) => preCadastrarLead(req, res));
app.all('/opener', (req, res) => openerDisparou(req, res));

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
