/* Stub de firebase-admin/firestore (VPS): reexporta getFirestore + FieldValue
   da camada de compatibilidade pg-compat.js. Assim `getFirestore()` do pipeline
   devolve o db compatível que grava no PostgreSQL (via a API do servidor). */
'use strict';
const { getFirestore, FieldValue, initializeApp } = require('../../pg-compat.js');
module.exports = { getFirestore, FieldValue, initializeApp };
