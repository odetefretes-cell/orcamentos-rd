'use strict';
exports.onSchedule = (opts, handler) => (typeof opts === 'function' ? opts : handler);
