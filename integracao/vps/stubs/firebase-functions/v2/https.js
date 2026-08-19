/* Stub de firebase-functions/v2/https (VPS).
   No Firebase, onRequest(opts, handler) devolve uma Cloud Function. Aqui só
   devolvemos o handler cru (req, res) => ... para o Express chamar direto.
   Aceita tanto onRequest(handler) quanto onRequest(opts, handler). */
'use strict';
exports.onRequest = (opts, handler) => (typeof opts === 'function' ? opts : handler);
