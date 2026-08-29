/* Validador do MDF-e — regras do §6 (docs/regras-negocio.md).
   UM MDF-e por viagem/placa, agregando TODOS os CT-es da viagem. */
'use strict';

const { BANCO_PAGAMENTO, APOLICE_ALLIANZ } = require('../domain/contadores');

const UFS = new Set(['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']);

/* Rota "PE X AL X SE X BA X MG X SP" → percurso = UFs INTERMEDIÁRIAS, em ordem
   (origem e destino não entram): ['AL','SE','BA','MG'] */
function percursoDaRota(rota) {
  // separador é " X " com espaços — sem eles o X de uma sigla inválida seria engolido
  const partes = String(rota || '').toUpperCase().split(/\s+X\s+/).map((s) => s.trim()).filter(Boolean);
  const invalidas = partes.filter((p) => !UFS.has(p));
  if (invalidas.length) return { erro: `rota contém UF inválida: ${invalidas.join(', ')} (esperado formato "PE X AL X ... X SP")` };
  if (partes.length < 2) return { erro: 'rota precisa de pelo menos origem e destino (ex.: "PE X SP")' };
  return { valor: partes.slice(1, -1), origem: partes[0], destino: partes[partes.length - 1] };
}

function validarMdfe(viagem) {
  const erros = [];
  const avisos = [];
  const v = viagem || {};
  const ctes = Array.isArray(v.ctes) ? v.ctes : [];
  if (!ctes.length) erros.push('viagem sem CT-e — o MDF-e agrega os CT-es autorizados da viagem');

  const rota = percursoDaRota(v.rota);
  if (rota.erro) erros.push(rota.erro);

  const ciots = Array.isArray(v.ciots) ? v.ciots : [];
  if (ciots.length !== ctes.length) {
    avisos.push(`viagem com ${ctes.length} CT-e(s) e ${ciots.length} CIOT(s) — o esperado é 1 CIOT por CT-e`);
  }
  const somaCiots = Math.round(ciots.reduce((s, c) => s + Number(c.valorOperacao || 0), 0) * 100) / 100;
  if (ciots.length && !(somaCiots > 0)) erros.push('soma dos CIOTs da viagem é zero — valor do contrato do MDF-e sai daí');
  if (ciots.length > 1) {
    avisos.push('OPHOS aceita SÓ UM CIOT no MDF-e (tela) — vincular o primeiro; os demais seguem válidos na ANTT. Via Integrador (TXT linha 023), verificar se aceita N.');
  }

  // Averbação: um nº POR CARGA (CT-e), ANTES de transmitir (depois não entra mais)
  const averbacoes = Array.isArray(v.averbacoes) ? v.averbacoes : [];
  if (averbacoes.length !== ctes.length) {
    erros.push(`averbações insuficientes: ${averbacoes.length} para ${ctes.length} CT-e(s) — é um nº de averbação POR CARGA, incluído ANTES da transmissão`);
  }

  // UFs de início diferentes: conversão conjunta falha → montar de 1 CT-e e incluir os demais pela chave
  const ufsInicio = [...new Set(ctes.map((c) => String((c.coleta && c.coleta.uf) || '').toUpperCase()).filter(Boolean))];
  if (ufsInicio.length > 1) {
    avisos.push(`CT-es com UFs de início diferentes (${ufsInicio.join(', ')}) — montar o MDF-e a partir de um CT-e e incluir os demais pela chave de acesso no descarregamento`);
  }

  const prest = v.prestador || {};
  if (!prest.cavalo) erros.push('placa do cavalo ausente');
  const mot = prest.motorista || {};
  if (!String(mot.cpf || '').trim() || !String(mot.nome || '').trim()) erros.push('motorista (CPF + nome) ausente — o OPHOS não autopreenche');

  const mdfe = {
    serie: '002',
    tipoEmitente: 'PRESTADOR_SERVICO_TRANSPORTE',
    tipoTransportador: 'ETC',   // ⚠️ o OPHOS reseta p/ TAC a cada recarga — garantir no payload
    percurso: rota.valor || [],
    ufInicio: rota.origem,
    ufFim: rota.destino,
    documentos: ctes.map((c, i) => ({ chaveCte: c.chave, ncm: '87032310', pesoBrutoKg: 1000, averbacao: averbacoes[i] })),
    veiculo: {
      cavalo: { placa: prest.cavalo, tipoRodado: 'CAVALO_MECANICO', tipoCarroceria: 'NAO_APLICAVEL', posse: 'TERCEIRO' },
      reboque: prest.carreta ? { placa: prest.carreta, tipoCarroceria: 'ABERTA', posse: 'TERCEIRO', taraKg: 1000, capKg: 1000, capM3: 100 } : null,
      proprietario: { cpfCnpj: prest.cpfCnpj, nome: prest.nome, rntrc: prest.rntrc, ie: 'ISENTO', tipo: 'TAC_INDEPENDENTE' },  // padrão vem "TAC Agregado" — trocar
    },
    motorista: { cpf: mot.cpf, nome: mot.nome },
    pagamento: {
      valorContrato: somaCiots,
      componentes: [{ nome: 'FRETE', valor: somaCiots }],
      forma: 'A_VISTA',
      indicadorAltoDesempenho: 'NAO',   // obrigatório
      ...BANCO_PAGAMENTO,
    },
    seguro: { apolice: APOLICE_ALLIANZ },
    ciotVinculado: ciots.length ? ciots[0].numero || null : null,
  };
  avisos.push('conferir o proprietário do cavalo/carreta contra o CRLV — cadastros do OPHOS têm dados errados (ex.: FQP2A33)');
  return { erros, avisos, corrigido: mdfe };
}

module.exports = { validarMdfe, percursoDaRota };
