'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { validarCte, validarChassi, normalizarModelo, normalizarEndereco } = require('../src/validators/cte');
const { derivarCiot, rntrcSemZeros } = require('../src/validators/ciot');
const { validarMdfe, percursoDaRota } = require('../src/validators/mdfe');

// Usa o dump real do frete 1702 se já existir; senão, o exemplo do documento.
const FIX_DIR = path.join(__dirname, 'fixtures');
const fixPath = fs.existsSync(path.join(FIX_DIR, 'frete-1702.json'))
  ? path.join(FIX_DIR, 'frete-1702.json')
  : path.join(FIX_DIR, 'frete-1702.exemplo.json');
const frete1702 = () => JSON.parse(fs.readFileSync(fixPath, 'utf8'));

/* ---------- chassi ---------- */
test('chassi com 17 chars válidos passa', () => {
  assert.equal(validarChassi('9BD15822586123456').valor, '9BD15822586123456');
});
test('chassi curto é completado com zeros à esquerda (com aviso)', () => {
  const r = validarChassi('BD158225861234');
  assert.equal(r.valor, '000BD158225861234');
  assert.match(r.aviso, /zeros/);
});
test('spec de bateria no campo chassi bloqueia (pergunta ao operador)', () => {
  const r = validarChassi('60V45AH6A');
  assert.match(r.erro, /bateria/);
});
test('chassi com mais de 17 chars bloqueia', () => {
  assert.match(validarChassi('9BD158225861234567').erro, /18/);
});

/* ---------- modelo ---------- */
test('modelo com espaço no final é corrigido (rejeição cvc-pattern-valid)', () => {
  const r = normalizarModelo('FIAT UNO MILLE ');
  assert.equal(r.valor, 'FIAT UNO MILLE');
  assert.match(r.aviso, /espaço/);
});

/* ---------- endereço ---------- */
test('endereço sem número vira SN', () => {
  const r = normalizarEndereco({ logradouro: 'RUA A', bairro: 'B', municipio: 'RECIFE', uf: 'PE', cep: '50000000' });
  assert.equal(r.valor.numero, 'SN');
});
test('base-a-base sem CEP vira 00000000 com logradouro/bairro BASE', () => {
  const r = normalizarEndereco({ municipio: 'SAO PAULO', uf: 'SP' }, { baseABase: true });
  assert.equal(r.valor.cep, '00000000');
  assert.equal(r.valor.logradouro, 'BASE');
  assert.equal(r.valor.bairro, 'BASE');
  assert.equal(r.erros.length, 0);
});
test('CEP ausente em frete comum é erro', () => {
  const r = normalizarEndereco({ logradouro: 'RUA A', numero: '1', bairro: 'B', municipio: 'RECIFE', uf: 'PE' });
  assert.ok(r.erros.some((e) => /CEP/.test(e)));
});

/* ---------- CT-e (fixture 1702) ---------- */
test('CT-e do frete 1702 valida sem erros e aplica as normalizações do §6', () => {
  const { erros, corrigido } = validarCte(frete1702());
  assert.deepEqual(erros, [], `erros inesperados: ${erros.join(' | ')}`);
  assert.equal(corrigido.serie, '001');
  assert.equal(corrigido.cfop, '6932');
  assert.equal(corrigido.tomador.nome, corrigido.remetente.nome);       // tomador = remetente
  assert.equal(corrigido.carga.produtoPredominante, 'VEICULO');
  assert.equal(corrigido.carga.ncmPredominante, '');
  assert.equal(corrigido.veiculo.modelo, 'FIAT UNO MILLE');             // trim do espaço final
  assert.equal(corrigido.entrega.cep, '00000000');                      // base-a-base
  assert.equal(corrigido.coleta.numero, 'SN');
  assert.equal(corrigido.documentoRemetente.numero, '1702');            // doc remetente = nº do frete
  assert.equal(corrigido.documentoRemetente.valor, 25000);              // valor = valor da carga
  assert.deepEqual(corrigido.rodoviario, {});                           // aba rodoviário vazia
  assert.equal(corrigido.impostos.ordem[1], 'SITUACAO_TRIBUTARIA_SIMPLES_NACIONAL'); // ST por último
});

/* ---------- CIOT ---------- */
test('RNTRC perde o zero à esquerda', () => {
  assert.equal(rntrcSemZeros('054501855'), '54501855');
});
test('CIOT derivado do CT-e 1702: valor = CT-e − 100, NCM 8703, tomador como contratante adicional', () => {
  const { corrigido: cte } = validarCte(frete1702());
  const { erros, corrigido: ciot } = derivarCiot(cte, { dataEmissao: new Date('2026-08-29T12:00:00Z') });
  assert.deepEqual(erros, [], `erros inesperados: ${erros.join(' | ')}`);
  assert.equal(ciot.valorOperacao, 400);
  assert.equal(ciot.ncm, '8703');
  assert.equal(ciot.ncm.length <= 4, true);        // varchar(4)!
  assert.equal(ciot.dataFim, '2026-09-08');        // emissão + 10 dias
  assert.equal(ciot.contratado.rntrc, '54501855');
  assert.equal(ciot.tipoViagem, 'CARGA_FRACIONADA');
  assert.equal(ciot.contratantesAdicionais.length, 1);
  assert.equal(ciot.trecho.origem.municipio, 'JABOATAO DOS GUARARAPES'); // coleta REAL, não faturamento
});
test('CIOT com margem maior que o frete bloqueia', () => {
  const f = frete1702(); f.valorConhecimento = 80;
  const { corrigido: cte } = validarCte(f);
  const { erros } = derivarCiot(cte);
  assert.ok(erros.some((e) => /≤ 0/.test(e)));
});

/* ---------- MDF-e ---------- */
test('percurso = UFs intermediárias da rota, em ordem', () => {
  const r = percursoDaRota('PE X AL X SE X BA X MG X SP');
  assert.deepEqual(r.valor, ['AL', 'SE', 'BA', 'MG']);
  assert.equal(r.origem, 'PE');
  assert.equal(r.destino, 'SP');
});
test('rota com UF inválida é erro', () => {
  assert.match(percursoDaRota('PE X XX X SP').erro, /XX/);
});
test('MDF-e da viagem 1702+1703: série 002, ETC, NCM 87032310, contrato = soma dos CIOTs', () => {
  const f = frete1702();
  const { corrigido: cte } = validarCte(f);
  const { corrigido: ciot } = derivarCiot(cte);
  const viagem = {
    rota: f.rota,
    prestador: f.prestador,
    ctes: [{ ...cte, chave: '1'.repeat(44) }, { ...cte, chave: '2'.repeat(44) }],
    ciots: [{ ...ciot, numero: '520026376913' }, { ...ciot, numero: '520026376914' }],
    averbacoes: [756, 757],
  };
  const { erros, avisos, corrigido: mdfe } = validarMdfe(viagem);
  assert.deepEqual(erros, [], `erros inesperados: ${erros.join(' | ')}`);
  assert.equal(mdfe.serie, '002');
  assert.equal(mdfe.tipoTransportador, 'ETC');
  assert.equal(mdfe.documentos[0].ncm, '87032310');   // NCM completo (≠ CIOT)
  assert.equal(mdfe.pagamento.valorContrato, 800);    // soma dos 2 CIOTs de R$ 400
  assert.equal(mdfe.pagamento.indicadorAltoDesempenho, 'NAO');
  assert.equal(mdfe.veiculo.proprietario.tipo, 'TAC_INDEPENDENTE');
  assert.equal(mdfe.documentos[0].averbacao, 756);    // uma averbação POR carga
  assert.ok(avisos.some((a) => /SÓ UM CIOT/.test(a)));
});
test('MDF-e sem averbação suficiente bloqueia', () => {
  const f = frete1702();
  const { corrigido: cte } = validarCte(f);
  const { erros } = validarMdfe({ rota: f.rota, prestador: f.prestador, ctes: [{ ...cte, chave: '1'.repeat(44) }], ciots: [], averbacoes: [] });
  assert.ok(erros.some((e) => /averba/i.test(e)));
});
