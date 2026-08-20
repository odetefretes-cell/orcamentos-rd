// Utilidades de data puras (fáceis de testar).
export function hojeISO(base) {
  const d = base ? new Date(base) : new Date();
  return d.toISOString().slice(0, 10);
}

export function addDias(iso, dias) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(dias));
  return d.toISOString().slice(0, 10);
}

export function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
