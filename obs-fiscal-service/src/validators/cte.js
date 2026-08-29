/* Validador do CT-e — regras do §6 (docs/regras-negocio.md) como funções puras.
   Contrato comum dos validadores:
     validar*(payload) → { erros: [..], avisos: [..], corrigido: payloadNormalizado }
   - `erros`  bloqueiam a emissão (precisam de operador/correção);
   - `avisos` não bloqueiam, mas aparecem na prévia de aprovação;
   - `corrigido` traz o payload com as normalizações automáticas autorizadas
     (SN, BASE, CEP 00000000, zeros no chassi, trim do modelo). */
'use strict';

const RE_CHASSI = /^[A-HJ-NPR-Z0-9]{17}$/i;          // 17 chars, sem I/O/Q (padrão VIN)
// Spec de bateria de moto elétrica que às vezes vem no campo chassi (ex.: 60V45AH6A):
// tensão+capacidade — NÃO é chassi; precisa de decisão do operador.
const RE_SPEC_BATERIA = /\d+\s*V\s*\d+\s*AH/i;

function validarChassi(chassi) {
  const v = String(chassi || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!v) return { erro: 'chassi ausente' };
  if (RE_SPEC_BATERIA.test(v)) {
    return { erro: `chassi "${v}" parece spec de bateria (ex.: 60V45AH6A) — confirmar com o operador antes de emitir` };
  }
  if (v.length > 17) return { erro: `chassi "${v}" tem ${v.length} caracteres (máximo 17)` };
  if (v.length < 17) {
    const completado = v.padStart(17, '0');   // padrão autorizado: zeros à esquerda
    return { valor: completado, aviso: `chassi "${v}" tinha ${v.length} chars — completado com zeros à esquerda: ${completado}` };
  }
  if (!RE_CHASSI.test(v)) return { erro: `chassi "${v}" tem caracteres inválidos para VIN (I, O, Q ou símbolos)` };
  return { valor: v };
}

function normalizarModelo(modelo) {
  const original = String(modelo || '');
  const v = original.replace(/\s+$/, '');     // espaço no FINAL = rejeição cvc-pattern-valid
  if (!v) return { erro: 'modelo do veículo ausente' };
  if (v !== original) return { valor: v, aviso: 'modelo tinha espaço no final (rejeição cvc-pattern-valid) — removido' };
  return { valor: v };
}

/* Endereço da FICHA prevalece sobre o resolvido por CEP.
   baseABase=true → logradouro/bairro 'BASE' e CEP ausente vira '00000000'. */
function normalizarEndereco(end, { baseABase = false } = {}) {
  const e = { ...(end || {}) };
  const avisos = [];
  const erros = [];
  if (!String(e.numero || '').trim()) { e.numero = 'SN'; avisos.push('endereço sem número — usado SN'); }
  if (baseABase) {
    if (!String(e.logradouro || '').trim()) e.logradouro = 'BASE';
    if (!String(e.bairro || '').trim()) e.bairro = 'BASE';
    if (!String(e.cep || '').replace(/\D/g, '')) { e.cep = '00000000'; avisos.push('base-a-base sem CEP — usado 00000000 (decisão 29/08/2026)'); }
  } else {
    if (!String(e.cep || '').replace(/\D/g, '')) erros.push('CEP ausente (frete não é base-a-base — buscar o CEP real)');
  }
  if (!String(e.municipio || '').trim()) erros.push('município ausente');
  if (!String(e.uf || '').trim()) erros.push('UF ausente');
  return { valor: e, avisos, erros };
}

function validarCte(p) {
  const erros = [];
  const avisos = [];
  const c = JSON.parse(JSON.stringify(p || {}));

  // Cabeçalho fixo da operação OBS
  c.serie = '001';
  c.cfop = '6932';
  avisos.push('CFOP 6932; para tomador não-contribuinte o OPHOS regrava como 6357 (comportamento esperado)');
  c.formaPagamento = 'A_PAGAR';
  c.tipoServico = 'NORMAL';

  // Tomador = Remetente
  if (!c.remetente || !String(c.remetente.nome || '').trim()) erros.push('remetente ausente');
  c.tomador = c.remetente;
  const docTomador = String((c.remetente && c.remetente.cpfCnpj) || '').replace(/\D/g, '');
  if (docTomador.length === 11) {
    c.segmentoTomador = 'NAO_CONTRIBUINTE';
    c.tipoIcmsTomador = 'NAO_CONTRIBUINTE';
  }

  // Endereços (ficha prevalece)
  for (const lado of ['coleta', 'entrega']) {
    const r = normalizarEndereco(c[lado], { baseABase: !!(c[lado] && c[lado].baseABase) });
    c[lado] = r.valor;
    avisos.push(...r.avisos.map((a) => `${lado}: ${a}`));
    erros.push(...r.erros.map((a) => `${lado}: ${a}`));
  }

  // Carga
  const valorVeiculo = Number(c.veiculo && c.veiculo.valor);
  if (!(valorVeiculo > 0)) erros.push('valor do veículo transportado ausente (é o valor da carga)');
  c.carga = {
    valor: valorVeiculo || 0,
    produtoPredominante: 'VEICULO',
    ncmPredominante: '',            // vazio no CT-e (regra §6)
    quantidade: { valor: 1, unidade: 'UN', descricao: 'UNIDADE' },
  };

  // Bloco Veículo Novo
  if (!c.veiculo) { erros.push('dados do veículo transportado ausentes'); c.veiculo = {}; }
  const ch = validarChassi(c.veiculo.chassi);
  if (ch.erro) erros.push(ch.erro); else { c.veiculo.chassi = ch.valor; if (ch.aviso) avisos.push(ch.aviso); }
  const mo = normalizarModelo(c.veiculo.modelo || c.veiculo.marcaModelo);
  if (mo.erro) erros.push(mo.erro); else { c.veiculo.modelo = mo.valor; if (mo.aviso) avisos.push(mo.aviso); }
  c.veiculo.nrCor = '01';
  if (!String(c.veiculo.cor || '').trim()) erros.push('cor do veículo ausente');
  const valorFrete = Number(c.valorConhecimento || c.valorFrete);
  if (!(valorFrete > 0)) erros.push('valor do conhecimento (frete) ausente');

  // Documento do remetente (obrigatório — vazio bloqueia o salvamento)
  if (!c.numeroFrete) erros.push('número do frete ausente (vira o nº do documento do remetente)');
  c.documentoRemetente = { tipo: 'OUTROS_DECLARACAO', numero: String(c.numeroFrete || ''), valor: valorVeiculo || 0 };

  // Impostos: ordem de aplicação (o builder/driver PRECISA respeitar)
  c.impostos = {
    componentes: [{ nome: 'FRETE', valor: valorFrete || 0, compoeBc: true }],
    ordem: ['CALCULAR_IMPOSTO', 'SITUACAO_TRIBUTARIA_SIMPLES_NACIONAL'],  // ST por ÚLTIMO (senão o cálculo reverte)
  };

  // Aba Rodoviário do CT-e: VAZIA (cavalo/carreta/motorista só no MDF-e)
  if (c.rodoviario && Object.keys(c.rodoviario).length) {
    avisos.push('aba Rodoviário do CT-e deve ficar vazia — dados removidos (entram só no MDF-e)');
  }
  c.rodoviario = {};

  return { erros, avisos, corrigido: c };
}

module.exports = { validarCte, validarChassi, normalizarModelo, normalizarEndereco };
