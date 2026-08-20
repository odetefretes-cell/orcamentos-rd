// Configuração central. Tudo vem de variáveis de ambiente (.env).
// Nenhum segredo fica no código — ver .env.example.
import 'dotenv/config';

function required(name, fallback = undefined) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    // Não derruba em import: algumas rotas (health, oauth/start) funcionam sem
    // tudo preenchido. As rotas que precisam validam na hora.
    return '';
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  // Caminho do banco SQLite. EM PRODUÇÃO precisa ser um volume PERSISTENTE,
  // senão o refresh_token some no redeploy e a integração quebra.
  dbPath: process.env.DB_PATH || './data/obs-ca.db',

  // Segredo compartilhado que o site do OBS envia no header X-OBS-Secret.
  obsSharedSecret: required('OBS_SHARED_SECRET'),

  contaAzul: {
    clientId: required('CA_CLIENT_ID'),
    clientSecret: required('CA_CLIENT_SECRET'),
    // URL pública deste backend + /oauth/callback. Tem que bater EXATAMENTE
    // com a cadastrada no app de produção do Conta Azul (sem barra no fim).
    redirectUri: required('CA_REDIRECT_URI'),
    authUrl: process.env.CA_AUTH_URL || 'https://login.contaazul.com/#/oauth/authorize',
    tokenUrl: process.env.CA_TOKEN_URL || 'https://api-v2.contaazul.com/oauth/token',
    apiBase: process.env.CA_API_BASE || 'https://api-v2.contaazul.com',
    scope: process.env.CA_SCOPE || 'openid profile aws.cognito.signin.user.admin',
  },

  // UUIDs dos serviços já cadastrados no Conta Azul (a API exige serviço, não
  // aceita item avulso). Ver README, passo "Cadastrar serviços".
  servicos: {
    cegonha: process.env.SERVICE_CEGONHA_ID || '',
    guincho: process.env.SERVICE_GUINCHO_ID || '',
  },

  // Nomes das categorias/centros de custo no Conta Azul. O backend resolve o
  // ID por nome (a API não cria categoria; tem que já existir).
  catalogo: {
    categoriaReceita: process.env.CAT_RECEITA || 'Fretes recebidos',
    categoriaDespesa: process.env.CAT_DESPESA || 'Materiais Aplicados na Prestação de Serviços',
    centroCustoPadrao: process.env.CENTRO_CUSTO_PADRAO || 'FRETES',
    centroCustoGuincho: process.env.CENTRO_CUSTO_GUINCHO || 'GUINCHO',
  },

  // Vencimento da 2ª parcela do PIX 50/50 quando o OBS não manda a previsão
  // de chegada. Decisão pendente no spec (ver docs/ARQUITETURA.md).
  parcela2FallbackDias: Number(process.env.PARCELA2_FALLBACK_DIAS || 15),

  // Reconciliação do 202 (contas a pagar não devolve ID). Intervalo em ms.
  reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS || 5 * 60 * 1000),

  env: process.env.NODE_ENV || 'development',
};

export function assertContaAzulConfigured() {
  const c = config.contaAzul;
  const faltando = [];
  if (!c.clientId) faltando.push('CA_CLIENT_ID');
  if (!c.clientSecret) faltando.push('CA_CLIENT_SECRET');
  if (!c.redirectUri) faltando.push('CA_REDIRECT_URI');
  if (faltando.length) {
    throw new Error(`Configuração do Conta Azul incompleta: faltam ${faltando.join(', ')}`);
  }
}
