// Monta o JSON do CT-e (formato Focus NFe) a partir de um FRETE do CRM.
// ⚠️ RASCUNHO DE FASE 0/1: os campos fiscais (CFOP, CST/alíquota de ICMS) vêm do
// .env e DEVEM ser definidos pelo CONTADOR antes de qualquer emissão em produção.
// O endpoint /obs/cte/preview existe exatamente pra validar este JSON com ele.
import { config } from '../config.js';

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const num = (v) => {
  if (v === '' || v == null) return 0;
  let s = String(v).replace(/[R$\s]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s.replace(/[^\d.-]/g, ''));
  return isNaN(n) ? 0 : n;
};

/** "São Paulo SP" | "São Paulo/SP" → { municipio, uf } */
export function municipioUf(texto) {
  const t = String(texto || '').trim();
  const m = t.match(/^(.*?)[\s\/\-,]+([A-Za-z]{2})$/);
  if (m) return { municipio: m[1].trim(), uf: m[2].toUpperCase() };
  return { municipio: t, uf: '' };
}

/**
 * Monta o payload do CT-e normal (tomador = cliente) de um frete do CRM.
 * @param {object} f  frete (doc da coleção fretes)
 * @returns {{payload:object, avisos:string[]}}
 */
export function mapCte(f) {
  const avisos = [];
  const orig = municipioUf(f.origem);
  const dest = municipioUf(f.destino);
  const doc = soDigitos(f.cpfCnpj);
  const valorFrete = num(f.valorFrete);
  const valorCarga = num(f.veiculos && f.veiculos[0] && f.veiculos[0].valor) || num(f.valorVeiculo) || 0;
  const interestadual = orig.uf && dest.uf && orig.uf !== dest.uf;
  const cfop = interestadual ? config.fiscal.cfopInter : config.fiscal.cfopIntra;

  if (!doc) avisos.push('cliente sem CPF/CNPJ na ficha (obrigatório no CT-e)');
  if (!orig.uf || !dest.uf) avisos.push('origem/destino sem UF reconhecível');
  if (!valorFrete) avisos.push('valor do frete vazio');
  if (!valorCarga) avisos.push('valor do veículo (carga) vazio');
  if (!cfop) avisos.push('CFOP não parametrizado (.env FISCAL_CFOP_* — definir com o contador)');
  if (!config.fiscal.icmsCst) avisos.push('ICMS não parametrizado (.env FISCAL_ICMS_* — definir com o contador)');
  if (!config.emitente.cnpj) avisos.push('emitente não configurado (.env EMIT_*)');

  const e = config.emitente;
  const payload = {
    // ---- identificação ----
    cfop,
    natureza_operacao: 'PRESTACAO DE SERVICO DE TRANSPORTE',
    data_emissao: new Date().toISOString(),
    tipo_documento: 0,               // 0 = CT-e normal
    modal: '01',                     // rodoviário
    tipo_servico: 0,                 // 0 = normal (subcontratação é o CT-e do PRESTADOR, não o nosso)
    codigo_municipio_envio: undefined,   // Focus resolve por nome/UF abaixo
    municipio_envio: orig.municipio, uf_envio: orig.uf,
    municipio_inicio: orig.municipio, uf_inicio: orig.uf,
    municipio_fim: dest.municipio, uf_fim: dest.uf,

    // ---- emitente (OBS) ----
    cnpj_emitente: e.cnpj,
    inscricao_estadual_emitente: e.ie,
    nome_emitente: e.razao,
    nome_fantasia_emitente: e.fantasia,
    logradouro_emitente: e.logradouro,
    numero_emitente: e.numero,
    bairro_emitente: e.bairro,
    municipio_emitente: e.municipio,
    uf_emitente: e.uf,
    cep_emitente: e.cep,
    crt_emitente: e.crt,

    // ---- tomador = cliente do frete ----
    tomador: {
      [doc.length === 14 ? 'cnpj' : 'cpf']: doc,
      nome: f.clienteEmpresa || '',
      telefone: soDigitos(f.telefone).slice(-11),
      logradouro: f.endereco || '',
      numero: (String(f.endereco || '').match(/(\d+)\s*$/) || [])[1] || 'S/N',
      bairro: f.bairro || '',
      municipio: f.cidade || '',
      uf: f.uf || '',
      cep: soDigitos(f.cep),
    },

    // ---- carga (o veículo transportado) ----
    valor_total_carga: valorCarga,
    produto_predominante: `VEICULO ${String((f.veiculos && f.veiculos[0] && f.veiculos[0].modelo) || f.veiculo || '').toUpperCase()}`.trim(),

    // ---- valores da prestação ----
    valor_total: valorFrete,
    valor_receber: valorFrete,

    // ---- ICMS (PARAMETRIZAR COM O CONTADOR) ----
    icms_situacao_tributaria: config.fiscal.icmsCst || undefined,
    ...(config.fiscal.icmsAliq ? { icms_aliquota: Number(config.fiscal.icmsAliq) } : {}),

    // observações que ajudam a rastrear
    observacoes: `Frete OBS #${f.numero || ''} — ${orig.municipio}/${orig.uf} x ${dest.municipio}/${dest.uf}`,
  };

  return { payload, avisos };
}
