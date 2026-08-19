/* Stub de firebase-functions/v2/firestore (VPS).
   No Firebase, onDocumentUpdated(opts, handler) registra um gatilho que dispara
   quando um doc muda. No PostgreSQL não há gatilhos: devolvemos o handler cru
   (async (event) => ...) e o ORQUESTRADOR constrói o `event` e chama na ordem
   certa (fecharLeadsCompletos → processarLeadCompleto → criarLeadNoCrm).
   onDocumentCreated/onDocumentWritten idem, por robustez. */
'use strict';
const raw = (opts, handler) => (typeof opts === 'function' ? opts : handler);
exports.onDocumentUpdated = raw;
exports.onDocumentCreated = raw;
exports.onDocumentWritten = raw;
exports.onDocumentDeleted = raw;
