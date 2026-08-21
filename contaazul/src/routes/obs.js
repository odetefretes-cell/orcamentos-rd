// Rotas que o sistema OBS chama. Protegidas pelo segredo compartilhado.
//   POST /obs/venda    → registra a venda (receita) do frete
//   POST /obs/despesa  → lança a despesa do prestador (com trava de duplicidade)
//   GET  /obs/status   → o que já foi lançado para um frete (para a tela do OBS)
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { requireObsSecret } from '../middleware/sharedSecret.js';
import { garantirPessoa } from '../contaazul/pessoas.js';
import { criarVenda } from '../contaazul/vendas.js';
import { criarContaAPagar } from '../contaazul/financeiro.js';
import { ca } from '../contaazul/client.js';
import { mapVenda } from '../domain/mapVenda.js';
import { mapDespesa, paresDespesa } from '../domain/mapDespesa.js';
import { acharVenda, registrarVenda, conflitosDespesa, registrarDespesa, porFrete } from '../store/ledger.js';
import { log } from '../logger.js';

export const obsRouter = Router();
obsRouter.use(requireObsSecret);

const pessoaSchema = z.object({
  nome: z.string().min(1),
  documento: z.string().optional(),
  email: z.string().optional(),
  telefone: z.string().optional(),
});

const vendaSchema = z.object({
  frete: z.union([z.number(), z.string()]),
  modal: z.enum(['cegonha', 'guincho']).default('cegonha'),
  valor: z.number().positive(),
  formaPagamento: z.enum(['PIX_50_50', 'PIX_100', 'CARTAO', 'FATURAMENTO_PJ']),
  data: z.string().optional(),
  previsaoChegada: z.string().optional(),
  vencimento: z.string().optional(),
  cliente: pessoaSchema,
  origem: z.string().optional(),
  destino: z.string().optional(),
  veiculo: z.string().optional(),
  placa: z.string().optional(),
  descricao: z.string().optional(),
});

const despesaSchema = z.object({
  prestador: pessoaSchema,
  valor: z.number().positive(),
  modal: z.enum(['cegonha', 'guincho']).default('cegonha'),
  dataCompetencia: z.string().optional(),
  vencimento: z.string().optional(),
  pixKey: z.string().optional(),
  forcar: z.boolean().optional(), // ignora a trava de duplicidade (confirmação explícita)
  itens: z.array(z.object({
    frete: z.union([z.number(), z.string()]),
    placa: z.string().min(1),
  })).min(1),
});

// UUIDs REAIS por modal (config.contaAzul), sem resolver por nome.
const ehGuincho = (modal) => String(modal || '').toLowerCase() === 'guincho';
const idServicoPara = (modal) =>
  ehGuincho(modal) ? config.contaAzul.idServicoGuincho : config.contaAzul.idServicoCegonha;
const idCentroPara = (modal) =>
  ehGuincho(modal) ? config.contaAzul.idCentroGuincho : config.contaAzul.idCentroFretes;

// ---------- VENDA ----------
obsRouter.post('/venda', async (req, res, next) => {
  try {
    const input = vendaSchema.parse(req.body);

    const existente = acharVenda(input.frete);
    if (existente) {
      return res.status(200).json({
        ok: true, duplicado: true,
        mensagem: 'Frete já registrado no Conta Azul — não foi criado de novo.',
        ca: { id: existente.ca_id, numero: existente.ca_numero },
      });
    }

    const idCliente = await garantirPessoa({ ...input.cliente, perfis: ['CLIENTE'] });

    const payload = mapVenda(input, {
      idCliente,
      idServico: idServicoPara(input.modal),
      idCategoria: config.contaAzul.idCategoriaReceita,
      idCentroCusto: idCentroPara(input.modal),
      idVendedor: config.contaAzul.idVendedor,
      idNatureza: config.contaAzul.idNaturezaVenda,
    });

    const venda = await criarVenda(payload);
    registrarVenda({
      frete: input.frete, valor: input.valor,
      caId: venda.id, caNumero: venda.numero, status: 'criado', payload,
    });

    log.info('Venda registrada', { frete: input.frete, caId: venda.id });
    res.status(201).json({ ok: true, duplicado: false, ca: { id: venda.id, numero: venda.numero } });
  } catch (e) { next(mapZod(e)); }
});

// ---------- DESPESA ----------
obsRouter.post('/despesa', async (req, res, next) => {
  try {
    const input = despesaSchema.parse(req.body);
    const pares = paresDespesa(input);
    if (pares.length === 0) return res.status(400).json({ erro: 'Nenhum item (frete+placa) válido.' });

    // Trava de duplicidade ANTES de tocar no Conta Azul.
    if (!input.forcar) {
      const conflitos = conflitosDespesa(pares);
      if (conflitos.length) {
        return res.status(409).json({
          ok: false, duplicado: true,
          mensagem: 'Placa+frete já lançada antes. Pagar de novo pode duplicar. Reenvie com "forcar": true se for intencional.',
          conflitos,
        });
      }
    }

    const idFornecedor = await garantirPessoa({ ...input.prestador, perfis: ['FORNECEDOR'] });

    const payload = mapDespesa(input, {
      idFornecedor,
      idCategoria: config.contaAzul.idCategoriaDespesa,
      idCentroCusto: idCentroPara(input.modal),
      idContaFinanceira: config.contaAzul.idContaFinanceira,
    });

    // 202: assíncrono, sem id. Reconciliação preenche o ca_id depois.
    const { status } = await criarContaAPagar(payload);

    const reg = registrarDespesa({
      pares, valor: input.valor,
      status: 'pendente_reconciliacao', payload, caId: null,
    });
    if (reg.duplicado) {
      // corrida rara: alguém lançou o mesmo par entre a checagem e agora.
      log.warn('Despesa criada no CA mas ledger acusou duplicidade (corrida).', { pares });
    }

    log.info('Despesa lançada (aguardando reconciliação)', { fretes: pares.map((p) => p.frete), httpCA: status });
    res.status(202).json({
      ok: true, duplicado: false,
      status: 'pendente_reconciliacao',
      mensagem: 'Despesa criada no Conta Azul. O número é confirmado pela reconciliação em alguns minutos. Pague pelo CA de Bolso.',
    });
  } catch (e) { next(mapZod(e)); }
});

// ---------- STATUS ----------
obsRouter.get('/status', (req, res) => {
  const { frete } = req.query;
  if (!frete) return res.status(400).json({ erro: 'Informe ?frete=' });
  res.json({ frete, lancamentos: porFrete(String(frete)) });
});

// ---------- DIAGNÓSTICO (SÓ LEITURA — não cria nada) ----------
// Lê os UUIDs reais (vendedor, conta financeira, categorias, centros, serviços) e,
// se passar ?venda=NNN e/ou ?contaPagar=NNN, busca um lançamento REAL já existente
// (criado pelas rotinas Cowork) pra revelar os NOMES DE CAMPO exatos da API atual.
// Serve pra alinhar mapVenda/mapDespesa com o fluxo real, sem sandbox e sem escrever.
obsRouter.get('/diagnostico', async (req, res) => {
  const out = {};
  const nomeId = (d) => (Array.isArray(d) ? d : (d?.itens || d?.content || d?.data || []))
    .map((x) => ({ nome: x.nome || x.name || x.descricao || x.razao_social, id: x.id || x.uuid }));
  const tenta = async (nome, fn) => { try { out[nome] = await fn(); } catch (e) { out[nome] = { erro: e.message, status: e.status, data: e.data }; } };
  await tenta('vendedores',       async () => nomeId((await ca.get('/v1/venda/vendedores')).data));
  await tenta('conta_financeira', async () => nomeId((await ca.get('/v1/conta-financeira')).data));
  await tenta('categorias',       async () => nomeId((await ca.get('/v1/categorias')).data));
  await tenta('centros_custo',    async () => nomeId((await ca.get('/v1/centro-de-custo')).data));
  await tenta('servicos',         async () => nomeId((await ca.get('/v1/servicos')).data));
  // VENDA completa (estrutura real de criação): pega o id da 1ª venda da lista e busca o detalhe
  await tenta('venda_detalhe', async () => {
    const lista = (await ca.get('/v1/venda/busca', {})).data;
    const arr = Array.isArray(lista) ? lista : (lista?.itens || lista?.content || []);
    const id = req.query.vendaId || (arr[0] && (arr[0].id || arr[0].uuid));
    if (!id) return { erro: 'nenhuma venda encontrada na lista' };
    return (await ca.get('/v1/venda/' + id)).data;
  });
  // PESSOA real (pra ver o formato do campo "perfis" no cadastro atual).
  // Busca uma pessoa ESPECÍFICA pelo id (cliente real conhecido) — a lista sem filtro
  // vem vazia. Passe ?pessoaId=UUID pra usar outra.
  await tenta('pessoa_amostra', async () => {
    const pid = req.query.pessoaId || 'a0ff4bf6-0d18-4643-8aba-86913416a3da';
    let lista_raw = null;
    try { lista_raw = (await ca.get('/v1/pessoas', { tamanho_pagina: 10, termo_busca: 'a' })).data; } catch (e) { lista_raw = { erro: e.message }; }
    let detalhe = null;
    try { detalhe = (await ca.get('/v1/pessoas/' + pid)).data; } catch (e) { detalhe = { erro: e.message, data: e.data }; }
    return { detalhe, lista_raw_chaves: lista_raw && !Array.isArray(lista_raw) ? Object.keys(lista_raw) : (Array.isArray(lista_raw) ? ('array len ' + lista_raw.length) : lista_raw) };
  });
  // CONTA A PAGAR real (a busca exige intervalo de vencimento)
  await tenta('conta_pagar_amostra', async () => {
    const de = req.query.de || '2026-06-01';
    const ate = req.query.ate || '2026-12-31';
    const d = (await ca.get('/v1/financeiro/eventos-financeiros/contas-a-pagar/buscar', { data_vencimento_de: de, data_vencimento_ate: ate })).data;
    const arr = Array.isArray(d) ? d : (d?.itens || d?.content || []);
    return arr.slice(0, 2); // 2 amostras bastam pra ver a estrutura
  });
  res.json(out);
});

function mapZod(e) {
  if (e?.name === 'ZodError') {
    const err = new Error('Payload inválido: ' + e.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '));
    err.status = 400;
    return err;
  }
  return e;
}
