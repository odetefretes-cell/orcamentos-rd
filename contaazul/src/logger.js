// Logger mínimo em JSON, sem dependência. Suficiente para servidor.
// Nunca logue token, client_secret ou chave PIX inteira.

function line(level, msg, extra) {
  const rec = { t: new Date().toISOString(), level, msg, ...(extra || {}) };
  const out = level === 'error' ? process.stderr : process.stdout;
  out.write(JSON.stringify(rec) + '\n');
}

export const log = {
  info: (msg, extra) => line('info', msg, extra),
  warn: (msg, extra) => line('warn', msg, extra),
  error: (msg, extra) => line('error', msg, extra),
  debug: (msg, extra) => {
    if (process.env.DEBUG) line('debug', msg, extra);
  },
};

// Mascara um documento/chave para log (mostra só o fim).
export function mask(v) {
  if (!v) return v;
  const s = String(v);
  return s.length <= 4 ? '****' : '****' + s.slice(-4);
}
