'use strict';
const raw = (opts, handler) => (typeof opts === 'function' ? opts : handler);
exports.onDocumentUpdated = raw; exports.onDocumentCreated = raw;
exports.onDocumentWritten = raw; exports.onDocumentDeleted = raw;
