#!/usr/bin/env node
/* ============================================================================
 *  Semeia os USUÁRIOS do login próprio (tabela `usuarios`) no PostgreSQL,
 *  substituindo o login do Firebase. Senha guardada com hash scrypt (mesmo
 *  algoritmo do server.mjs). Roda NA VPS (lê /etc/obs-db/.env).
 *
 *  Uso:
 *    node seed-usuarios.mjs                 → cria quem falta com senha ALEATÓRIA e IMPRIME
 *                                             (não mexe na senha de quem já existe)
 *    node seed-usuarios.mjs senhas.json     → usa senhas de um arquivo {"email":"senha"}
 *    node seed-usuarios.mjs --force         → REDEFINE a senha de todos (aleatória ou do arquivo)
 * ========================================================================== */
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
const dotenv = await import('dotenv');
dotenv.config({ path: '/etc/obs-db/.env', quiet: true });

function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(senha), salt, 32).toString('hex');
  return `scrypt$${salt}$${h}`;
}
function senhaAleatoria() {
  const base = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 9);
  return base + '@' + crypto.randomInt(10, 99);
}

// Mesma lista/papel do app (EQUIPE_EMAIL). O admin entra com atendimento@…
const EQUIPE = [
  { email: 'atendimento@obstransportes.com.br', nome: 'Luiz Gustavo',        papel: 'admin' },
  { email: 'yasminfreitas.obs@outlook.com',     nome: 'Yasmim Freitas',      papel: 'comercial' },
  { email: 'thiagolucca.obs@outlook.com',       nome: 'Thiago Lucca',        papel: 'comercial' },
  { email: 'flavia.obs@outlook.com',            nome: 'Flavia Ottati',       papel: 'comercial' },
  { email: 'nataly.obs@outlook.com',            nome: 'Nataly Birk',         papel: 'operacional' },
  { email: 'yasmindesa.obs@outlook.com',        nome: 'Yasmin de Sá',        papel: 'operacional' },
  { email: 'financeiro@obstransportes.com.br',  nome: 'Gabrielle Domingues', papel: 'financeiro' },
];

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const arqSenhas = args.find(a => !a.startsWith('--'));
let senhasFixas = {};
if (arqSenhas) {
  senhasFixas = JSON.parse(fs.readFileSync(arqSenhas, 'utf8'));
  console.log(`Usando senhas de ${arqSenhas} (${Object.keys(senhasFixas).length} definidas).`);
}

const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD, max: 3,
});
await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (email text PRIMARY KEY, senha_hash text NOT NULL, nome text NOT NULL, papel text NOT NULL DEFAULT 'operacional', ativo boolean NOT NULL DEFAULT true, criado_em timestamptz DEFAULT now())`);

const geradas = [];
for (const u of EQUIPE) {
  const existe = (await pool.query(`SELECT 1 FROM usuarios WHERE email = $1`, [u.email])).rows.length > 0;
  const definirSenha = FORCE || !!senhasFixas[u.email] || !existe;
  if (definirSenha) {
    const senha = senhasFixas[u.email] || senhaAleatoria();
    const hash = hashSenha(senha);
    await pool.query(
      `INSERT INTO usuarios (email, senha_hash, nome, papel, ativo) VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (email) DO UPDATE SET senha_hash=EXCLUDED.senha_hash, nome=EXCLUDED.nome, papel=EXCLUDED.papel, ativo=true`,
      [u.email, hash, u.nome, u.papel]
    );
    geradas.push({ ...u, senha });
  } else {
    // já existe e não é --force: só atualiza nome/papel, mantém a senha
    await pool.query(`UPDATE usuarios SET nome=$2, papel=$3, ativo=true WHERE email=$1`, [u.email, u.nome, u.papel]);
  }
}
await pool.end();

if (geradas.length) {
  console.log('\n=== SENHAS (guarde e entregue a cada pessoa — some da tela depois) ===');
  for (const g of geradas) console.log(`${g.papel.padEnd(11)} | ${g.email.padEnd(38)} | senha: ${g.senha}`);
  console.log('=====================================================================\n');
} else {
  console.log('Nenhuma senha nova (todos já existem; use --force para redefinir).');
}
console.log(`OK — ${EQUIPE.length} usuários na tabela \`usuarios\` (${geradas.length} com senha nova).`);
process.exit(0);
