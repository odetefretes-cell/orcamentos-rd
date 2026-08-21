import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeParcelas, mapVenda, descricaoVenda } from '../src/domain/mapVenda.js';
import { mapDespesa, paresDespesa, normalizaPlaca, descricaoDespesa } from '../src/domain/mapDespesa.js';

test('PIX 50/50 gera duas parcelas que somam o total', () => {
  const p = computeParcelas('PIX_50_50', 1000, { hoje: '2026-08-18' });
  assert.equal(p.length, 2);
  assert.equal(p[0].data_vencimento, '2026-08-18');
  assert.equal(p[0].valor + p[1].valor, 1000);
  assert.equal(p[1].data_vencimento, '2026-09-02'); // +15 dias padrão
});

test('PIX 50/50 com centavo ímpar fecha ao centavo', () => {
  const p = computeParcelas('PIX_50_50', 1000.01, { hoje: '2026-08-18' });
  assert.equal(Math.round((p[0].valor + p[1].valor) * 100) / 100, 1000.01);
});

test('PIX 50/50 usa previsão de chegada quando informada', () => {
  const p = computeParcelas('PIX_50_50', 800, { hoje: '2026-08-18', previsaoChegada: '2026-09-10' });
  assert.equal(p[1].data_vencimento, '2026-09-10');
});

test('PIX 100 e cartão geram 1 parcela hoje', () => {
  assert.equal(computeParcelas('PIX_100', 500, { hoje: '2026-08-18' }).length, 1);
  assert.equal(computeParcelas('CARTAO', 500, { hoje: '2026-08-18' })[0].data_vencimento, '2026-08-18');
});

test('mapVenda monta o payload certo', () => {
  const input = {
    frete: 1523, modal: 'cegonha', valor: 1200, formaPagamento: 'PIX_100',
    data: '2026-08-16', cliente: { nome: 'Fulano' }, origem: 'SP', destino: 'BA', veiculo: 'Fox', placa: 'JWD8986',
  };
  const payload = mapVenda(input, { idCliente: 'cli-1', idServico: 'svc-1', idCategoria: 'cat-1', idCentroCusto: 'cc-1' });
  assert.equal(payload.numero, 1523);
  assert.equal(payload.situacao, 'APROVADO');
  assert.equal(payload.itens[0].id, 'svc-1');
  assert.equal(payload.itens[0].valor, 1200);
  assert.equal(payload.id_categoria, 'cat-1');
  assert.match(payload.observacoes, /#1523/);
});

test('descricaoVenda usa a descrição custom quando existe', () => {
  assert.equal(descricaoVenda({ frete: 1, descricao: 'X' }), 'X');
});

test('normalizaPlaca tira separadores e sobe caixa', () => {
  assert.equal(normalizaPlaca('jwd-8986'), 'JWD8986');
  assert.equal(normalizaPlaca('SNY 5E24'), 'SNY5E24');
});

test('paresDespesa filtra itens sem frete/placa', () => {
  const pares = paresDespesa({ itens: [{ frete: 1333, placa: 'EHY8E86' }, { frete: '', placa: 'X' }] });
  assert.equal(pares.length, 1);
  assert.deepEqual(pares[0], { frete: '1333', placa: 'EHY8E86' });
});

test('mapDespesa consolida vários fretes numa despesa', () => {
  const input = {
    prestador: { nome: 'Sonia' }, valor: 750, pixKey: '+5588996959745',
    itens: [{ frete: 1333, placa: 'EHY8E86' }, { frete: 1489, placa: 'SNY5E24' }],
  };
  const payload = mapDespesa(input, { idFornecedor: 'forn-1', idCategoria: 'cat-2', idCentroCusto: 'cc-1', idContaFinanceira: 'cf-1' });
  assert.equal(payload.total, 750);
  assert.equal(payload.id_pessoa, 'forn-1');
  assert.equal(payload.parcelas[0].valor, 750);
  assert.equal(payload.parcelas[0].id_conta_financeira, 'cf-1');
  assert.equal(payload.codigo_referencia, '1333,1489');
  assert.match(payload.observacoes, /PIX: \+5588996959745/);
  assert.match(payload.descricao, /Sonia/);
});
