// Configuração central do obs-fiscal. Lê /etc/obs-fiscal/.env (VPS) com fallback
// pro .env local (dev). override:true → editar o .env + reiniciar sempre vale.
import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const envVps = '/etc/obs-fiscal/.env';
const envLocal = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
dotenv.config({ override: true, path: existsSync(envVps) ? envVps : envLocal });
// Postgres: mesmas credenciais do obs-api (os fretes moram lá)
dotenv.config({ path: '/etc/obs-db/.env' });

export const config = {
  port: Number(process.env.PORT || 3003),
  obsSharedSecret: String(process.env.OBS_SHARED_SECRET || ''),

  focus: {
    token: String(process.env.FOCUS_TOKEN || ''),
    ambiente: process.env.FOCUS_AMBIENTE === 'producao' ? 'producao' : 'homologacao',
    baseUrl: process.env.FOCUS_AMBIENTE === 'producao'
      ? 'https://api.focusnfe.com.br'
      : 'https://homologacao.focusnfe.com.br',
  },

  emitente: {
    cnpj: String(process.env.EMIT_CNPJ || '').replace(/\D/g, ''),
    ie: String(process.env.EMIT_IE || ''),
    razao: process.env.EMIT_RAZAO || 'OBS TRANSPORTES',
    fantasia: process.env.EMIT_FANTASIA || 'OBS Transportes',
    logradouro: process.env.EMIT_LOGRADOURO || '',
    numero: process.env.EMIT_NUMERO || '',
    bairro: process.env.EMIT_BAIRRO || '',
    municipio: process.env.EMIT_MUNICIPIO || '',
    uf: process.env.EMIT_UF || '',
    cep: String(process.env.EMIT_CEP || '').replace(/\D/g, ''),
    crt: Number(process.env.EMIT_CRT || 3),
  },

  // ⚠️ Parametrização FISCAL — vazia até o contador definir (Fase 0).
  fiscal: {
    cfopIntra: process.env.FISCAL_CFOP_INTRA || '',
    cfopInter: process.env.FISCAL_CFOP_INTER || '',
    icmsCst: process.env.FISCAL_ICMS_CST || '',
    icmsAliq: process.env.FISCAL_ICMS_ALIQ || '',
  },

  averbadora: {
    tipo: process.env.AVERBADORA || '',
    atm: {
      usuario: process.env.ATM_USUARIO || '',
      senha: process.env.ATM_SENHA || '',
      codigo: process.env.ATM_CODIGO || '',
    },
  },

  pg: {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  },

  env: process.env.NODE_ENV || 'development',
};

/** true quando dá pra EMITIR de verdade (token + emitente + fiscal preenchidos). */
export function prontoParaEmitir() {
  const faltando = [];
  if (!config.focus.token) faltando.push('FOCUS_TOKEN');
  if (!config.emitente.cnpj) faltando.push('EMIT_CNPJ');
  if (!config.emitente.ie) faltando.push('EMIT_IE');
  if (!config.fiscal.cfopIntra || !config.fiscal.cfopInter) faltando.push('FISCAL_CFOP_*');
  if (!config.fiscal.icmsCst) faltando.push('FISCAL_ICMS_CST');
  return { pronto: faltando.length === 0, faltando };
}
