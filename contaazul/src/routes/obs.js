// Rotas que o sistema OBS chama. Protegidas pelo segredo compartilhado.
//   POST /obs/venda    → registra a venda (receita) do frete
//   POST /obs/despesa  → lança a despesa do prestador (com trava de duplicidade)
//   GET  /obs/status   → o que já foi lançado para um frete (para a tela do OBS)
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { requireObsSecret } from '../middleware/sharedSecret.js';
import { garantirPessoa } from '../contaazul/pessoas.js';
import { criarVenda, buscarVendaPorNumero } from '../contaazul/vendas.js';
import { ca } from '../contaazul/client.js';
import { mapVenda } from '../domain/mapVenda.js';
import { mapDespesa, paresDespesa } from '../domain/mapDespesa.js';
import { criarContaAPagar, cancelarContaAPagarPorFrete, listarParcelas } from '../contaazul/financeiro.js';
import { gerarCobranca, esperarUrlCobranca } from '../contaazul/cobranca.js';
import { acharVenda, registrarVenda, conflitosDespesa, registrarDespesa, porFrete, removerDespesaPorFrete } from '../store/ledger.js';
import { log } from '../logger.js';

export const obsRouter = Router();
obsRouter.use(requireObsSecret);

const pessoaSchema = z.object({
  nome: z.string().min(1),
  documento: z.string().optional(),
  email: z.string().optional(),
  telefone: z.string().optional(),
  // endereço completo (necessário p/ cobrança Pix/boleto no cliente da venda)
  endereco: z.object({
    cep: z.string().optional(),
    logradouro: z.string().optional(),
    numero: z.string().optional(),
    complemento: z.string().optional(),
    bairro: z.string().optional(),
    cidade: z.string().optional(),
    estado: z.string().optional(),
  }).optional(),
});

const vendaSchema = z.object({
  frete: z.union([z.number(), z.string()]),
  modal: z.enum(['cegonha', 'guincho']).default('cegonha'),
  valor: z.number().positive(),
  formaPagamento: z.enum(['PIX_50_50', 'PIX_100', 'CARTAO', 'FATURAMENTO_PJ', 'CARTAO_PIX']),
  pixParte: z.number().positive().optional(),      // CARTAO_PIX: valor pago no PIX
  vencimentoPix: z.string().optional(),            // CARTAO_PIX: vencimento da parte PIX
  vencimento2: z.string().optional(),              // CARTAO_PIX: vencimento do restante (cartão)
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

    // Cliente recém-criado leva ~1-2s pra ficar consultável no CA → a venda pode
    // voltar "Cliente da venda não encontrado". Repetimos com espera (até ~12s).
    // Nº de venda JÁ USADO (equipe registrou manual no CA) → ADOTA a venda
    // existente em vez de falhar: registra no ledger e segue (cobrança funciona).
    let venda;
    for (let tent = 1; ; tent++) {
      try { venda = await criarVenda(payload); break; }
      catch (e) {
        const corpoErro = JSON.stringify(e.data || {});
        const clienteNaoAchado = e.status === 400 && /n[aã]o encontrado/i.test(corpoErro);
        if (clienteNaoAchado && tent < 6) { await new Promise((r) => setTimeout(r, 2000)); continue; }
        const numeroJaUsado = e.status === 400 && /(j[aá]\s|duplicad|utilizad|existe)/i.test(corpoErro) && /n[uú]mero|venda/i.test(corpoErro);
        if (numeroJaUsado) {
          const existente = await buscarVendaPorNumero(input.frete);
          if (existente?.id) {
            registrarVenda({ frete: input.frete, valor: input.valor, caId: existente.id, caNumero: existente.numero, status: 'adotada_manual', payload: { adotada: true } });
            log.info('Venda já existia no CA — adotada', { frete: input.frete, caId: existente.id });
            return res.status(200).json({ ok: true, duplicado: true, adotada: true, mensagem: 'A venda já estava registrada no Conta Azul (feita manual) — usei a existente.', ca: { id: existente.id, numero: existente.numero } });
          }
        }
        throw e;
      }
    }
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

// ---------- COBRANÇA (boleto / Pix / link) a partir da VENDA do frete ----------
//  body { frete, tipo: 'BOLETO'|'PIX'|'LINK', vencimento?, descricao? }
//  Emite 1 cobrança POR PARCELA em aberto da venda (PIX 50/50 → 2 cobranças).
obsRouter.post('/cobranca', async (req, res, next) => {
  try {
    const { frete, tipo, vencimento, descricao, apenas } = req.body || {};
    const TIPOS = { BOLETO: 'BOLETO', PIX: 'PIX_COBRANCA', LINK: 'LINK_PAGAMENTO' };
    const t = TIPOS[String(tipo || '').toUpperCase()];
    if (!frete || !t) return res.status(400).json({ ok: false, erro: 'Informe "frete" e "tipo" (BOLETO|PIX|LINK).' });

    const v = acharVenda(frete);
    if (!v || !v.ca_id) return res.status(404).json({ ok: false, erro: `Venda do frete ${frete} não está registrada no Conta Azul — registre primeiro (botão ☁).` });

    // parcelas da venda — o id da venda pode não ser o do evento financeiro; descobre com fallback
    const tentativas = {};
    let parcelas = [];
    try { parcelas = await listarParcelas(v.ca_id); tentativas['parcelas via id da venda'] = parcelas.length; }
    catch (e) { tentativas['parcelas via id da venda'] = (e.status || '?') + ' ' + e.message; }
    if (!parcelas.length) {
      try {
        const vd = (await ca.get('/v1/venda/' + v.ca_id)).data;
        const fid = vd?.evento_financeiro?.id || vd?.id_evento_financeiro || vd?.financeiro?.id;
        tentativas['venda detalhe → evento'] = fid || 'campo não achado (chaves: ' + Object.keys(vd || {}).slice(0, 15).join(',') + ')';
        if (fid) { parcelas = await listarParcelas(fid); tentativas['parcelas via evento'] = parcelas.length; }
      } catch (e) { tentativas['venda detalhe'] = (e.status || '?') + ' ' + e.message; }
    }
    if (!parcelas.length) return res.status(502).json({ ok: false, erro: 'Não achei as parcelas da venda no Conta Azul.', tentativas });

    const hoje = new Date().toISOString().slice(0, 10);

    // ---- DIAGNÓSTICO 2 (diag2:true): testa cada CONTA FINANCEIRA como id_conta ----
    if (req.body?.diag2) {
      const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const pid = parcelas[0].id || parcelas[0].uuid;
      const PATH = '/v1/financeiro/eventos-financeiros/contas-a-receber/gerar-cobranca';
      const d = (await ca.get('/v1/conta-financeira', { tamanho_pagina: 100 })).data;
      const contas = Array.isArray(d) ? d : (d?.items || d?.itens || d?.content || []);
      const out = { parcela: pid, contas: contas.map((c) => ({ id: c.id || c.uuid, nome: c.nome, tipo: c.tipo })) };
      for (const c of contas) {
        const cid = c.id || c.uuid; if (!cid) continue;
        try { const r = await ca.post(PATH, { id_conta: cid, id_parcela: pid, tipo: 'LINK_PAGAMENTO', data_vencimento: amanha, descricao_fatura: 'Teste OBS' }); out['✓ ' + c.nome] = { status: r.status, data: r.data }; break; }
        catch (e) { out['✗ ' + c.nome] = { erro: e.status || '?', msg: e.data?.message || e.message }; }
      }
      try { const r = await ca.post(PATH, { id_parcela: pid, tipo: 'LINK_PAGAMENTO', data_vencimento: amanha, descricao_fatura: 'Teste OBS' }); out['✓ SEM id_conta'] = { status: r.status, data: r.data }; }
      catch (e) { out['✗ SEM id_conta'] = { erro: e.status || '?', msg: e.data?.message || e.message, detalhe: e.data }; }
      return res.json(out);
    }

    // ---- DIAGNÓSTICO (diag:true): testa VARIAÇÕES do corpo na 1ª parcela ----
    if (req.body?.diag) {
      const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const pid = parcelas[0].id || parcelas[0].uuid;
      const variantes = [
        ['PIX venc amanhã',            { idParcela: pid, tipo: 'PIX_COBRANCA',  vencimento: amanha, descricao: 'Teste' }],
        ['PIX venc amanhã s/ desc',    { idParcela: pid, tipo: 'PIX_COBRANCA',  vencimento: amanha }],
        ['LINK venc amanhã',           { idParcela: pid, tipo: 'LINK_PAGAMENTO', vencimento: amanha, descricao: 'Teste' }],
        ['LINK + atributos',           { idParcela: pid, tipo: 'LINK_PAGAMENTO', vencimento: amanha, descricao: 'Teste', atributos: { maximo_parcelas: 1 } }],
        ['BOLETO venc amanhã',         { idParcela: pid, tipo: 'BOLETO',        vencimento: amanha, descricao: 'Teste' }],
      ];
      const out = {};
      for (const [nome, args] of variantes) {
        try { const r = await gerarCobranca(args); out[nome] = { status: r.status, data: r.data }; break; }   // 1º sucesso já basta
        catch (e) { out[nome] = { erro: (e.status || '?'), msg: e.data?.message || e.message, detalhe: e.data }; }
      }
      return res.json({ diag: true, parcela: pid, variantes: out });
    }

    // apenas:'ultima' → cobra SÓ a última parcela em aberto (2ª parte do PIX 50/50,
    // cobrada pelo OPERACIONAL na entrega — a 1ª já foi cobrada pelo financeiro).
    let alvo = parcelas;
    const modoApenas = String(apenas || '').toLowerCase();
    if (modoApenas === 'ultima' || modoApenas === 'primeira') {
      const abertas = parcelas.filter((p) => !(/pag[oa]|liquid|recebid/i.test(String(p.status || '')) && !/nao|não|pend/i.test(String(p.status || ''))));
      abertas.sort((a, b) => String(a.data_vencimento || '').localeCompare(String(b.data_vencimento || '')));
      alvo = modoApenas === 'primeira' ? abertas.slice(0, 1) : abertas.slice(-1);
      if (!alvo.length) return res.status(200).json({ ok: false, erro: 'Nenhuma parcela em aberto — tudo já pago.', tentativas });
    }
    const resultados = [];
    for (const p of alvo) {
      const pid = p.id || p.uuid;
      if (!pid) continue;
      const jaPaga = /pag[oa]|liquid|recebid/i.test(String(p.status || '')) && !/nao|não|pend/i.test(String(p.status || ''));
      if (jaPaga) { resultados.push({ parcela: pid, pulada: 'já paga' }); continue; }
      const venc = String(p.data_vencimento || vencimento || hoje).slice(0, 10);
      try {
        const r = await gerarCobranca({ idParcela: pid, tipo: t, vencimento: venc, descricao: descricao || `Frete #${frete} — OBS Transportes` });
        resultados.push({ parcela: pid, status: r.status, data: r.data });
      } catch (e) { resultados.push({ parcela: pid, erro: (e.status || '?') + ' ' + e.message, data: e.data }); }
    }
    // a emissão é ASSÍNCRONA (url vem null) → espera confirmar e busca o link
    for (const r of resultados) {
      const cid = r?.data?.id;
      if (!cid || r?.data?.url) continue;
      const confirmada = await esperarUrlCobranca(cid);
      if (confirmada) { r.data = { ...r.data, ...confirmada }; }
    }
    const okEmissao = resultados.some((r) => r.status >= 200 && r.status < 300);
    const links = resultados.map((r) => r?.data?.url).filter(Boolean);
    const statusFinais = [...new Set(resultados.map((r) => r?.data?.status).filter(Boolean))];
    // SÓ é sucesso com LINK confirmado — a emissão é assíncrona e pode ser
    // recusada depois (ex.: cliente sem CPF/endereço → status INVALIDO).
    const ok = okEmissao && links.length > 0;
    log.info('Cobrança CA', { frete, tipo: t, emitidas: resultados.filter((r) => r.status).length, links: links.length, statusFinais });
    res.status(ok ? 200 : 502).json({
      ok, frete, tipo: t, links, statusCobranca: statusFinais,
      ...(ok ? {} : { erro: okEmissao
        ? 'A cobrança não confirmou (status: ' + (statusFinais.join(', ') || 'sem retorno') + '). Normalmente é cadastro do cliente incompleto no Conta Azul (CPF/endereço/telefone).'
        : 'Falha ao emitir a cobrança no Conta Azul.' }),
      resultados, tentativas,
    });
  } catch (e) { next(mapZod(e)); }
});

// ---------- CANCELAR DESPESA (excluir a conta a pagar no Conta Azul) ----------
//  body { frete, aplicar? }  — aplicar:false só mostra o que achou; true exclui.
obsRouter.post('/despesa/cancelar', async (req, res, next) => {
  try {
    const frete = req.body?.frete;
    if (frete === undefined || frete === null || String(frete).trim() === '') {
      return res.status(400).json({ ok: false, erro: 'Informe o "frete".' });
    }
    const aplicar = req.body?.aplicar === true || req.body?.aplicar === 'true';
    const diag = req.body?.diag === true || req.body?.diag === 'true';
    const r = await cancelarContaAPagarPorFrete(frete, aplicar, diag);
    if (diag) return res.json(r);

    if (aplicar) {
      const excluidos = (r.resultados || []).filter((x) => x.ok).length;
      if (excluidos > 0) removerDespesaPorFrete(frete);   // libera novo lançamento
      log.info('Despesa cancelada', { frete, encontrados: r.encontrados, excluidos });
      return res.json({ ok: excluidos > 0, ...r, excluidos });
    }
    return res.json({ ok: true, ...r });
  } catch (e) { next(mapZod(e)); }
});

// ---------- ESQUECER DESPESA (só limpa o registro LOCAL — não mexe no Conta Azul) ----------
//  Usado no "cancelar" do app: a exclusão no CA é manual (a API do CA não deixa excluir);
//  aqui a gente só apaga o registro local pra o frete poder ser relançado sem trava.
obsRouter.post('/despesa/esquecer', (req, res) => {
  const frete = req.body?.frete;
  if (frete === undefined || frete === null || String(frete).trim() === '') {
    return res.status(400).json({ ok: false, erro: 'Informe o "frete".' });
  }
  const removidos = removerDespesaPorFrete(frete);
  log.info('Despesa esquecida (registro local)', { frete, removidos });
  res.json({ ok: true, removidos });
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
  // CONTA A PAGAR real (a busca exige intervalo de vencimento) + DETALHE (rateio/condicao).
  // Tenta VÁRIOS caminhos de GET do detalhe até um responder 200, pra revelar a
  // estrutura exata de condicao_pagamento/parcelas/rateio (o site 404 em alguns).
  await tenta('conta_pagar_amostra', async () => {
    const de = req.query.de || '2026-01-01';
    const ate = req.query.ate || '2026-12-31';
    const d = (await ca.get('/v1/financeiro/eventos-financeiros/contas-a-pagar/buscar', { data_vencimento_de: de, data_vencimento_ate: ate })).data;
    const arr = Array.isArray(d) ? d : (d?.items || d?.itens || d?.content || []);
    const item0 = arr[0] || null;
    const id = req.query.contaPagarId || (item0 && (item0.id || item0.uuid || item0.id_evento || item0.evento_id));
    const caminhos = [
      '/v1/financeiro/eventos-financeiros/' + id + '/parcelas',
      '/v1/financeiro/eventos-financeiros/contas-a-pagar/' + id,
      '/v1/financeiro/eventos-financeiros/' + id,
    ];
    const tentativas = {};
    let detalhe = null;
    if (id) {
      for (const path of caminhos) {
        try { const r = (await ca.get(path)).data; tentativas[path] = 'OK'; if (!detalhe) detalhe = r; }
        catch (e) { tentativas[path] = (e.status || '?') + ' ' + (e.message || ''); }
      }
    }
    return { resumo_item0: item0, resumo_chaves: item0 ? Object.keys(item0) : null, tentativas_detalhe: tentativas, detalhe };
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
