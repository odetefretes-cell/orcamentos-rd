/* ============================================================================
   OBS — Adaptador PostgreSQL (via API do servidor novo).

   Dá à automação a MESMA "cara" do Firestore que ela já usa, mas gravando no
   PostgreSQL do servidor próprio (através da API em OBS_API_URL):

       pgDb.collection('crm_leads').doc(id).get()/.set(data,{merge})/.update(data)
       pgDb.runTransaction(async tx => { ... })          // leve (single-doc)
       proximoVendedorPG([...])                          // rodízio ATÔMICO no servidor
       listar('crm_leads')                               // coleção inteira

   Config por ambiente (Cloud Functions):
       OBS_API_URL    ex.: https://api.obstransportes.com.br
       OBS_API_TOKEN  o API_TOKEN do servidor (segredo do Functions)
   ============================================================================ */

const BASE  = (process.env.OBS_API_URL || 'https://api.obstransportes.com.br').replace(/\/$/, '');
const TOKEN = process.env.OBS_API_TOKEN || '';

async function req(metodo, caminho, corpo) {
  const headers = { 'Authorization': 'Bearer ' + TOKEN };
  if (corpo !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + caminho, {
    method: metodo, headers,
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  if (metodo === 'GET' && r.status === 404) return { __404: true };
  if (!r.ok) { let m; try { m = (await r.json()).erro; } catch (_) {} throw new Error('API ' + r.status + (m ? (' ' + m) : '')); }
  const t = await r.text();
  return t ? JSON.parse(t) : {};
}

function docRef(col, id) {
  return {
    _col: col, _id: id,
    async get() {
      const j = await req('GET', `/api/${col}/${encodeURIComponent(id)}`);
      const existe = !(j && j.__404);
      let data;
      if (existe) { const { id: _i, ...d } = j; data = d; }
      return { exists: existe, id, data: () => data };
    },
    async set(data, opts) {
      const merge = (opts && opts.merge) ? '?merge=1' : '';
      await req('PUT', `/api/${col}/${encodeURIComponent(id)}${merge}`, data || {});
      return true;
    },
    async update(data) {
      // Firestore update = mescla os campos informados (não apaga o resto).
      await req('PUT', `/api/${col}/${encodeURIComponent(id)}?merge=1`, data || {});
      return true;
    },
  };
}

const pgDb = {
  collection(col) { return { doc(id) { return docRef(col, id); } }; },

  /* Transação "leve": como no Firestore, as LEITURAS acontecem durante o callback
     e as GRAVAÇÕES são aplicadas DEPOIS que ele termina. Serve para os usos de
     1 documento do backend. Para o rodízio (contador compartilhado), use
     proximoVendedorPG, que é atômico no servidor. */
  async runTransaction(fn) {
    const ops = [];
    const tx = {
      get: (ref) => ref.get(),
      set: (ref, data, opts) => { ops.push(() => ref.set(data, opts)); },
      update: (ref, data) => { ops.push(() => ref.update(data)); },
    };
    const resultado = await fn(tx);
    for (const op of ops) await op();
    return resultado;
  },
};

/* Rodízio de vendedor — contador ATÔMICO no servidor (evita dois leads pegarem
   o mesmo vendedor ao mesmo tempo). */
async function proximoVendedorPG(vendedores) {
  const j = await req('POST', '/api/rodizio/next', { vendedores });
  return (j && j.vendedor) || '';
}

/* Lista uma coleção inteira (usado pelo verificador periódico de envios). */
async function listar(col) {
  const j = await req('GET', `/api/${col}`);
  return Array.isArray(j) ? j : [];
}

/* Trava ATÔMICA de envio: marca `campo`=true SÓ se ainda estiver desligado.
   Retorna true se ESTE chamador ganhou (pode enviar), false se outro já pegou.
   `extra` são campos gravados junto (ex.: { respostaEnviadaEm: '...' }). */
async function claim(col, id, campo, extra) {
  const j = await req('POST', `/api/${col}/${encodeURIComponent(id)}/claim?campo=${encodeURIComponent(campo)}`, extra || {});
  return !!(j && j.claimed);
}

module.exports = { pgDb, proximoVendedorPG, listar, claim, _req: req, BASE };
