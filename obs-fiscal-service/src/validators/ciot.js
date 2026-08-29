/* Validador/derivação do CIOT — regras do §6 (docs/regras-negocio.md).
   O CIOT é SEMPRE derivado de um CT-e autorizado (criado do zero trava no OPHOS). */
'use strict';

const { BANCO_PAGAMENTO } = require('../domain/contadores');

const MARGEM_OBS_PADRAO = 100;   // valor da operação = valor do CT-e − R$ 100 (parametrizável)
const DIAS_VIAGEM = 10;

function rntrcSemZeros(rntrc) {
  const d = String(rntrc || '').replace(/\D/g, '');
  return d.replace(/^0+/, '');
}

function derivarCiot(cteAutorizado, { margem = MARGEM_OBS_PADRAO, dataEmissao = new Date() } = {}) {
  const erros = [];
  const avisos = [];
  const cte = cteAutorizado || {};

  const valorCte = Number(cte.valorConhecimento || cte.valorFrete);
  if (!(valorCte > 0)) erros.push('valor do CT-e ausente — impossível calcular o valor da operação');
  const valorOperacao = Math.round((valorCte - margem) * 100) / 100;
  if (valorCte > 0 && valorOperacao <= 0) {
    erros.push(`valor da operação ficou ≤ 0 (CT-e R$ ${valorCte.toFixed(2)} − margem R$ ${margem.toFixed(2)}) — confirmar com o operador`);
  }

  const prest = cte.prestador || {};
  if (!String(prest.cpfCnpj || '').trim()) erros.push('CPF/CNPJ do prestador (contratado) ausente');
  if (!String(prest.nome || '').trim()) erros.push('nome do prestador ausente');
  const rntrc = rntrcSemZeros(prest.rntrc);
  if (!rntrc) erros.push('RNTRC do prestador ausente');
  const mot = prest.motorista || {};
  if (!String(mot.cpf || '').trim() || !String(mot.nome || '').trim()) erros.push('motorista (CPF + nome) ausente');

  // Trecho: município de COLETA REAL → município de ENTREGA (nunca o endereço de faturamento)
  const colMun = String((cte.coleta && cte.coleta.municipio) || '').trim();
  const entMun = String((cte.entrega && cte.entrega.municipio) || '').trim();
  if (!colMun || !entMun) erros.push('trecho incompleto — município de coleta e de entrega são obrigatórios (usar a coleta REAL, não o faturamento)');

  const fim = new Date(dataEmissao.getTime());
  fim.setDate(fim.getDate() + DIAS_VIAGEM);

  // Carga fracionada: o tomador do CT-e entra SEMPRE como contratante adicional
  if (!cte.tomador || !String(cte.tomador.nome || '').trim()) {
    erros.push('tomador do CT-e ausente — obrigatório como contratante adicional na carga fracionada');
  }

  const ciot = {
    tipoOperacao: 'SOU_CONTRATANTE',
    autenticacao: 'DADOS_DO_CONTRATANTE',
    tipoViagem: 'CARGA_FRACIONADA',
    tipoCarga: 'CARGA_GERAL',
    valorOperacao,
    dataFim: fim.toISOString().slice(0, 10),
    ncm: '8703',                       // 4 dígitos — o campo é varchar(4)!
    pesoKg: 1000,
    contratado: { cpfCnpj: prest.cpfCnpj, nome: prest.nome, rntrc },
    trecho: { origem: { municipio: colMun, uf: cte.coleta && cte.coleta.uf }, destino: { municipio: entMun, uf: cte.entrega && cte.entrega.uf }, roteirizar: true },
    veiculos: { cavalo: { placa: prest.cavalo, eixos: 3 }, carreta: { placa: prest.carreta, eixos: 2 } },
    motorista: { cpf: mot.cpf, nome: mot.nome },
    pagamento: { ...BANCO_PAGAMENTO, proprietarioCpfCnpj: prest.cpfCnpj },   // proprietário = o contratado
    contratantesAdicionais: cte.tomador ? [cte.tomador] : [],
  };
  return { erros, avisos, corrigido: ciot };
}

module.exports = { derivarCiot, rntrcSemZeros, MARGEM_OBS_PADRAO };
