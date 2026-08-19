/* ============================================================================
   OBS — memstore.js  (banco em MEMÓRIA para o selftest)

   Implementa a MESMA interface do Firestore/pg-compat E do pg-api, sobre um
   único `store` em memória. Assim:
     - getFirestore() (via test-stub firebase-admin/firestore) → este db
     - o mock de ../pg-api → o MESMO db + listar/claim/proximoVendedorPG
   compartilham o store, então crm_leads_intake (compat) e crm_leads (pgDb) são
   consistentes, e o selftest exercita o pipeline REAL de ponta a ponta.
   ============================================================================ */

'use strict';

const store = {}; // { colName: { id: dataObj } }
function col(c) { return (store[c] || (store[c] = {})); }

const FieldValue = {
  serverTimestamp: () => new Date().toISOString(),
  arrayUnion: (...items) => ({ __arrayUnion: items }),
  increment: (n) => ({ __increment: n }),
};

function resolver(cur, data) {
  const out = { ...data };
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && '__arrayUnion' in v) {
      const arr = Array.isArray(cur[k]) ? cur[k].slice() : [];
      for (const it of v.__arrayUnion) {
        if (!arr.some(x => JSON.stringify(x) === JSON.stringify(it))) arr.push(it);
      }
      out[k] = arr;
    } else if (v && typeof v === 'object' && '__increment' in v) {
      out[k] = (Number(cur[k]) || 0) + Number(v.__increment);
    }
  }
  return out;
}

function docRef(c, id) {
  const ref = {
    _col: c, _id: id, id,
    async get() {
      const has = Object.prototype.hasOwnProperty.call(col(c), id);
      return { exists: has, id, data: () => (has ? { ...col(c)[id] } : undefined), ref };
    },
    async set(data, opts) {
      const cur = col(c)[id] || {};
      const resolved = resolver(cur, data);
      col(c)[id] = (opts && opts.merge) ? { ...cur, ...resolved } : resolved;
      return true;
    },
    async update(data) {
      const cur = col(c)[id];
      if (cur === undefined) throw new Error('update em doc inexistente ' + c + '/' + id);
      col(c)[id] = { ...cur, ...resolver(cur, data) };
      return true;
    },
  };
  return ref;
}

function snapshot(c, entries) {
  const docs = entries.map(([id, d]) => ({ id, data: () => ({ ...d }), ref: docRef(c, id) }));
  return { docs, empty: docs.length === 0, size: docs.length, forEach: cb => docs.forEach(cb) };
}

function collection(c) {
  return {
    doc(id) { return docRef(c, id); },
    async add(data) {
      const id = 'auto_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const r = docRef(c, id); await r.set(data); return r;
    },
    where(f, op, val) {
      return {
        async get() {
          const entries = Object.entries(col(c)).filter(([, d]) => {
            const fv = d[f];
            if (op === '==') return fv === val;
            if (op === '!=') return fv !== val;
            return false;
          });
          return snapshot(c, entries);
        },
      };
    },
    async get() { return snapshot(c, Object.entries(col(c))); },
  };
}

async function runTransaction(fn) {
  const ops = [];
  const tx = {
    get: r => r.get(),
    set: (r, d, o) => ops.push(() => r.set(d, o)),
    update: (r, d) => ops.push(() => r.update(d)),
  };
  const res = await fn(tx);
  for (const op of ops) await op();
  return res;
}

const db = { collection, runTransaction };

/* ---- interface pg-api sobre o MESMO store ---- */
async function listar(c) { return Object.entries(col(c)).map(([id, d]) => ({ id, ...d })); }

async function claim(c, id, campo, extra) {
  const cur = col(c)[id];
  if (!cur) return false;
  if (cur[campo]) return false;               // já reivindicado
  col(c)[id] = { ...cur, [campo]: true, ...(extra || {}) };
  return true;
}

let rodizioN = 0;
async function proximoVendedorPG(vs) {
  if (!vs || !vs.length) return '';
  const v = vs[rodizioN % vs.length]; rodizioN++; return v;
}

const pgDb = { collection, runTransaction };

module.exports = {
  store, db, pgDb, FieldValue, listar, claim, proximoVendedorPG,
  // reexport p/ o test-stub firebase-admin/firestore:
  firebaseFirestore: { getFirestore: () => db, FieldValue, initializeApp: () => ({}) },
  // objeto que substitui ../pg-api no require.cache do selftest:
  pgApiMock: { pgDb, listar, claim, proximoVendedorPG, _req: async () => ({}), BASE: 'memory://' },
};
