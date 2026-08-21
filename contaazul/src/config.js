// Configuração central. Tudo vem de variáveis de ambiente (.env).
// Nenhum segredo fica no código — ver .env.example.
// override:true → o .env SEMPRE vence variáveis já presentes no ambiente. Sem isso,
// se o PM2 mantém um valor antigo em cache (ex.: CA_AUTH_URL trocado), o dotenv não
// sobrescrevia e o backend seguia usando a URL velha. Com override, editar o .env +
// reiniciar sempre pega o valor novo.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// Carrega o .env pela PASTA DO BACKEND (caminho absoluto), não pela cwd. O PM2 às
// vezes inicia o processo de outra pasta → o dotenv não achava o .env → PORT caía no
// default 3000 (conflito com o obs-api) e o app.listen falhava calado (log vazio, nada
// na 3002). Com o caminho absoluto, sempre acha /opt/obs-contaazul/.env.
dotenv.config({ override: true, path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

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
    // Endpoints OAuth do Conta Azul (API atual, Cognito). São PÚBLICOS e FIXOS —
    // fixados no código de propósito: um valor antigo em cache de ambiente do PM2
    // (CA_AUTH_URL=login.contaazul.com) vinha sobrescrevendo o .env e o dotenv não
    // soltava. Fixando aqui, nenhum cache/env atrapalha. (Não são segredos.)
    authUrl: 'https://auth.contaazul.com/oauth2/authorize',
    tokenUrl: 'https://auth.contaazul.com/oauth2/token',
    apiBase: process.env.CA_API_BASE || 'https://api-v2.contaazul.com',
    scope: process.env.CA_SCOPE || 'openid profile aws.cognito.signin.user.admin',

    // UUIDs REAIS lidos direto da conta do cliente (OBS Transportes). Env com
    // FALLBACK para o valor real → funciona sem depender do .env. Se um dia trocar
    // de conta, é só sobrescrever pelo .env. Substituem a resolução por NOME
    // (categorias/centros/serviços) no fluxo de venda/despesa.
    idVendedor: process.env.CA_ID_VENDEDOR || 'f626fed3-8c5d-4844-adfc-08d0de7acdca',
    idContaFinanceira: process.env.CA_ID_CONTA_FINANCEIRA || '4d685c0a-3387-4e90-85e9-44cbd9d5d93b',
    idServicoCegonha: process.env.CA_ID_SERVICO_CEGONHA || 'f40fd3a4-117c-4fa1-b658-3e20958dffbc',
    idServicoGuincho: process.env.CA_ID_SERVICO_GUINCHO || 'ceb34c3f-0edb-4769-8810-9b46bbfd510a',
    idCentroFretes: process.env.CA_ID_CENTRO_FRETES || 'dc2cc766-4243-11f1-955f-bf4ddfa3165b',
    idCentroGuincho: process.env.CA_ID_CENTRO_GUINCHO || '57445f58-5eab-11f1-9db9-070822ce83d5',
    idCategoriaReceita: process.env.CA_ID_CATEGORIA_RECEITA || '2b7ff6ea-dcd1-405b-9edc-44e012ffffd3',
    idCategoriaDespesa: process.env.CA_ID_CATEGORIA_DESPESA || 'b7ae7519-6340-4776-9880-c128e128d463',
    idNaturezaVenda: process.env.CA_ID_NATUREZA_VENDA || '529c30e4-423a-11f1-b45c-b7eaf5fe82d3',
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
