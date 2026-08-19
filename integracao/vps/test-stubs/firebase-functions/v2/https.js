'use strict';
exports.onRequest = (opts, handler) => (typeof opts === 'function' ? opts : handler);
