// Log JSON simples (mesmo padrão do obs-contaazul).
const linha = (level, msg, extra) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...(extra || {}) }));

export const log = {
  info: (msg, extra) => linha('info', msg, extra),
  warn: (msg, extra) => linha('warn', msg, extra),
  error: (msg, extra) => linha('error', msg, extra),
};
