/* ============================================================================
   OBS — pg-compat.js  (camada de compatibilidade Firestore → PostgreSQL/API)

   O pipeline existente (webhook.js e amigos) foi escrito para a API do
   firebase-admin/firestore. Aqui damos a MESMA "cara" ao adaptador PostgreSQL
   (../pg-api.js), acrescentando o que o Firestore expõe e o pg-api ainda não:

     - collection(col).add(data)                — id gerado (Date.now + aleatório)
     - collection(col).where(campo, op, valor)  — filtro em JS sobre listar(col)
     - collection(col).where(...).get()         — { docs:[{id,data(),ref}], empty, size, forEach }
     - collection(col).doc(id).get()            — snapshot { exists, id, data(), ref }
     - runTransaction(fn)                        — leituras no callback, escritas ao fim
     - FieldValue.serverTimestamp/arrayUnion/increment
     - markers __arrayUnion / __increment tratados por read-modify-write no set/update

   getFirestore() devolve este db compatível; initializeApp() é no-op. Os stubs
   de firebase-admin/firestore reexportam daqui, então TODO `getFirestore()` do
   pipeline passa a gravar no PostgreSQL (via a API do servidor novo).

   Observação: as coleções crm_leads_intake e chatguru_webhook_log agora são
   expostas pela API do servidor (PostgreSQL), então este db as grava lá.
   ============================================================================ */

'use strict';

const { pgDb, listar } = require('../pg-api');

/* --- FieldValue (sentinelas) ------------------------------------------------ */
const FieldValue = {
  // No PostgreSQL não há sentinela de servidor: usamos ISO string (o pipeline
  // já lê timestamps por new Date(v) — ver paraMillis em chatguru-webhook.js).
  serverTimestamp: () => new Date().toISOString(),
  arrayUnion: (...items) => ({ __arrayUnion: items }),
  increment: (n) => ({ __increment: n }),
};

/* --- markers ---------------------------------------------------------------- */
function temMarkers(data) {
  if (!data || typeof data !== 'object') return false;
  for (const v of Object.values(data)) {
    if (v && typeof v === 'object' && ('__arrayUnion' in v || '__increment' in v)) return true;
  }
  return false;
}

/* Resolve __arrayUnion / __increment com read-modify-write sobre o doc atual. */
async function resolverMarkers(data, lerAtual) {
  const out = { ...data };
  let atual = null;
  const garantirAtual = async () => {
    if (atual === null) { const s = await lerAtual(); atual = s.exists ? (s.data() || {}) : {}; }
    return atual;
  };
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && '__arrayUnion' in v) {
      const cur = await garantirAtual();
      const arr = Array.isArray(cur[k]) ? cur[k].slice() : [];
      for (const item of v.__arrayUnion) {
        const existe = arr.some(x => JSON.stringify(x) === JSON.stringify(item));
        if (!existe) arr.push(item);
      }
      out[k] = arr;
    } else if (v && typeof v === 'object' && '__increment' in v) {
      const cur = await garantirAtual();
      out[k] = (Number(cur[k]) || 0) + Number(v.__increment);
    }
  }
  return out;
}

/* --- docRef (envolve o docRef do pg-api p/ tratar markers e expor .ref) ----- */
function docRef(col, id) {
  const inner = pgDb.collection(col).doc(id);
  const ref = {
    _col: col, _id: id, id,
    async get() {
      const s = await inner.get();               // { exists, id, data:()=>... }
      return { exists: s.exists, id: s.id != null ? s.id : id, data: s.data, ref };
    },
    async set(data, opts) {
      const payload = temMarkers(data) ? await resolverMarkers(data, () => inner.get()) : data;
      return inner.set(payload, opts);
    },
    async update(data) {
      const payload = temMarkers(data) ? await resolverMarkers(data, () => inner.get()) : data;
      return inner.update(payload);
    },
  };
  return ref;
}

/* --- snapshot de coleção (query) -------------------------------------------- */
function montarSnapshot(col, itens) {
  const docs = itens.map(item => {
    const { id, ...data } = item;
    return { id, data: () => data, ref: docRef(col, id) };
  });
  return {
    docs,
    empty: docs.length === 0,
    size: docs.length,
    forEach: (cb) => docs.forEach(cb),
  };
}

function collection(col) {
  return {
    doc(id) { return docRef(col, id); },

    async add(data) {
      const id = 'auto_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
      const r = docRef(col, id);
      await r.set(data);
      return r;
    },

    where(campo, op, valor) {
      return {
        async get() {
          const arr = await listar(col);           // [{ id, ...data }]
          const filtrado = arr.filter(item => {
            const fv = item[campo];
            if (op === '==') return fv === valor;
            if (op === '!=') return fv !== valor;
            if (op === '>')  return fv >  valor;
            if (op === '>=') return fv >= valor;
            if (op === '<')  return fv <  valor;
            if (op === '<=') return fv <= valor;
            return false;
          });
          return montarSnapshot(col, filtrado);
        },
      };
    },

    // Conveniência (usada pelo orquestrador p/ listar o intake inteiro).
    async get() {
      const arr = await listar(col);
      return montarSnapshot(col, arr);
    },
  };
}

/* --- runTransaction (leituras no callback, escritas depois) ----------------- */
async function runTransaction(fn) {
  const ops = [];
  const tx = {
    get: (ref) => ref.get(),
    set: (ref, data, opts) => { ops.push(() => ref.set(data, opts)); },
    update: (ref, data) => { ops.push(() => ref.update(data)); },
  };
  const resultado = await fn(tx);
  for (const op of ops) await op();
  return resultado;
}

const db = { collection, runTransaction };

function getFirestore() { return db; }
function initializeApp() { return {}; }

module.exports = { getFirestore, initializeApp, FieldValue, _db: db, docRef };
