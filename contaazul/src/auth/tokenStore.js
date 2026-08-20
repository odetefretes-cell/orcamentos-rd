// Persistência dos tokens OAuth do Conta Azul.
// REGRA DE OURO: toda renovação pode devolver um refresh_token NOVO. Se não
// salvar o novo, a integração quebra em silêncio (bug nº 1 do Conta Azul).
import { getDb } from '../store/db.js';

export function saveTokens({ access_token, refresh_token, expires_in }) {
  const db = getDb();
  const now = Date.now();
  // margem de segurança de 60s antes do vencimento real
  const accessExpiresAt = now + Math.max(0, (Number(expires_in) || 3600) - 60) * 1000;
  const existing = getTokens();
  const refresh = refresh_token || existing?.refresh_token || null;
  db.prepare(`
    INSERT INTO oauth_tokens (id, access_token, refresh_token, access_expires_at, updated_at)
    VALUES (1, @access_token, @refresh_token, @access_expires_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      access_expires_at = excluded.access_expires_at,
      updated_at = excluded.updated_at
  `).run({
    access_token,
    refresh_token: refresh,
    access_expires_at: accessExpiresAt,
    updated_at: now,
  });
  return getTokens();
}

export function getTokens() {
  const db = getDb();
  return db.prepare('SELECT * FROM oauth_tokens WHERE id = 1').get() || null;
}

export function hasValidAccessToken() {
  const t = getTokens();
  return !!(t && t.access_token && t.access_expires_at && t.access_expires_at > Date.now());
}

export function clearTokens() {
  getDb().prepare('DELETE FROM oauth_tokens WHERE id = 1').run();
}

// --- state (CSRF) do fluxo de autorização ---
export function saveState(state) {
  getDb().prepare('INSERT OR REPLACE INTO oauth_states (state, created_at) VALUES (?, ?)')
    .run(state, Date.now());
}

export function consumeState(state) {
  const db = getDb();
  const row = db.prepare('SELECT state, created_at FROM oauth_states WHERE state = ?').get(state);
  if (!row) return false;
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  // válido por 10 minutos
  return Date.now() - row.created_at < 10 * 60 * 1000;
}
