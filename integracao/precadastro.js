/* ============================================================================
   OBS Transportes — PRÉ-CADASTRO do lead do formulário no ChatGuru

   Problema: o diálogo "Opener" agora dispara em TODO chat novo (!new_chat), e o
   ChatGuru não enxerga o texto da 1ª mensagem — então o lead do FORMULÁRIO do
   site também recebe o bloco de intake por cima (não pode: ele já mandou tudo).

   Solução (spec OBS_Fix_Opener_LeadFormulario.md): no ENVIO do formulário, o
   site chama esta função ANTES de abrir o WhatsApp. Ela:
     1) chat_add            → cria o chat com o telefone do lead
     2) chat_update_context → liga Cotando=Sim (+ Origem/Destino/Veiculo/Valor de bônus)
   Quando a mensagem "Solicitação de orçamento…" chega, o chat JÁ existe (não é
   !new_chat) e Cotando JÁ é Sim → as duas travas do Opener barram. Zero mudança
   de diálogo no ChatGuru.

   Serve também pra integração do Meta Lead Ads (mesmo pré-cadastro).
   ============================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore'); // no VPS → pg-compat (Postgres)
const { criarChat, atualizarContexto, atualizarCamposPersonalizados } = require('./chatguru-api');

/* RASTREAMENTO DE ORIGEM (Google Ads) — o formulário manda gclid/gbraid/wbraid + UTMs,
   mas o lead era montado com uma lista fixa de campos e eles eram descartados aqui. Sem o
   gclid guardado no lead é impossível importar "frete fechado" como conversão offline no
   Ads: é ele que liga a venda ao anúncio que a gerou.

   Nomes em snake_case (fora do padrão camelCase do resto do lead) de propósito: são
   repasse do que chega no corpo do POST e do que o Google Ads espera no CSV de conversões
   offline. Traduzir de ida e volta só criaria chance de errar. */
const CAMPOS_ORIGEM = ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium',
  'utm_campaign', 'utm_term', 'utm_content', 'pagina', 'data_lead'];

/* Monta os campos de origem respeitando o `merge:true` do save.

   ⚠️ Um campo vazio NÃO pode sobrescrever um valor já guardado: o caso real é o cliente
   que chega pelo anúncio, some, e volta dias depois pelo orgânico de outro aparelho — o
   segundo envio não pode zerar a atribuição do primeiro. Fora essa proteção, grava ''
   normalmente, para o lead sempre ter as chaves. */
function origemDoLead(b, leadAtual) {
  const out = {};
  for (const k of CAMPOS_ORIGEM) {
    const veio = String((b && b[k]) || '').trim();
    if (veio) { out[k] = veio; continue; }
    const guardado = String((leadAtual && leadAtual[k]) || '').trim();
    if (!guardado) out[k] = '';    // nada a perder: lead novo ou campo que já era vazio
  }
  return out;
}

exports.preCadastrarLead = onRequest(
  {
    cors: true,   // libera o fetch do site (obs-fretes.web.app / github.io)
    region: 'southamerica-east1',
    secrets: ['CHATGURU_API_KEY', 'CHATGURU_ACCOUNT_ID', 'CHATGURU_PHONE_ID'],
  },
  async (req, res) => {
    try {
      if (req.method === 'GET') { res.json({ ok: true, servico: 'preCadastrarLead', dica: 'use POST { telefone, nome, origem, destino, veiculo, valor }' }); return; }
      if (req.method !== 'POST') { res.status(405).json({ ok: false, erro: 'use POST' }); return; }

      const b = req.body || {};
      const telefone = b.telefone || b.chat_number || b.celular || '';
      if (!telefone) { res.status(400).json({ ok: false, erro: 'telefone ausente' }); return; }

      // Chave do lead (mesma do resto do sistema: últimos 8 dígitos) — calculada aqui em
      // cima porque o passo 2 já precisa saber se este contato JÁ tem clique atribuído.
      const soDig = String(telefone).replace(/\D/g, '');
      const t8 = soDig.slice(-8);
      const idLead = t8 ? ('lead_wpp_' + t8) : ('lead_site_' + Date.now());

      // Lead que já existe (cliente que voltou). Best-effort: se a leitura falhar, seguimos
      // tratando como lead novo — o pior caso é não gravar o gclid no ChatGuru desta vez.
      let leadAtual = null;
      try {
        const snap = await getFirestore().collection('crm_leads').doc(idLead).get();
        if (snap && snap.exists) leadAtual = snap.data() || {};
      } catch (e) { console.warn('[preCadastrarLead] leitura do lead falhou (segue):', e.message || e); }

      // 1) cria o chat (deixa de ser !new_chat quando a mensagem chegar).
      // Esta conta exige "mensagem inicial" no chat_add — usamos uma saudação
      // segura (caso o ChatGuru a entregue ao cliente).
      // Texto exigido pelo chat_add (esta conta obriga uma "mensagem inicial"). NÃO é
      // template → não gera custo; em contato frio ela nem entrega (falha silenciosa),
      // e o que importa é o chat passar a EXISTIR (barra o Opener). Neutro de propósito.
      const saudacao = 'Recebemos sua solicitação de orçamento pelo site. 📋';
      let criouChat = false, erroChat = '';
      try { await criarChat({ chatNumber: telefone, nome: b.nome || '', text: saudacao }); criouChat = true; }
      catch (e) { erroChat = e.message || String(e); console.warn('[preCadastrarLead] chat_add falhou:', erroChat); }

      // 2) liga Cotando=Sim (+ dados do formulário como contexto — bônus p/ a IA/atendente)
      const variaveis = { Cotando: 'Sim' };
      if (b.origem)  variaveis.Origem  = String(b.origem);
      if (b.destino) variaveis.Destino = String(b.destino);
      if (b.veiculo) variaveis.Veiculo = String(b.veiculo);
      if (b.valor)   variaveis.Valor   = String(b.valor);

      // Marca do clique no anúncio. Só na PRIMEIRA atribuição: a API não lê o valor
      // atual antes de escrever, então o lead serve de memória — se ele já tem clique
      // guardado, o contato do ChatGuru também já foi marcado.
      const cliqueNovo = String(b.gclid || b.gbraid || b.wbraid || '').trim();
      const cliqueGuardado = String((leadAtual && (leadAtual.gclid || leadAtual.gbraid || leadAtual.wbraid)) || '').trim();
      const marcarClique = !!cliqueNovo && !cliqueGuardado;
      if (marcarClique) variaveis.gclid = cliqueNovo;   // no contexto, p/ os diálogos lerem

      // O chat_add cria o chat, mas ele não fica consultável na MESMA hora (às vezes
      // leva mais que 1-2s pra propagar) → chat_update_context dá "Chat não encontrado".
      // Repetimos com PACIÊNCIA: uma espera inicial + várias tentativas com espera
      // crescente. Isto roda no servidor de forma independente do navegador — o site
      // já seguiu pro WhatsApp (fetch com abort em 4s), então dar mais tempo aqui só
      // aumenta a chance de gravar Cotando=Sim, sem atrasar o cliente.
      let marcouContexto = false, erroContexto = '';
      const MAX_TENTATIVAS = 6;
      await new Promise(r => setTimeout(r, 1500));   // deixa o chat propagar antes da 1ª tentativa
      for (let tentativa = 1; tentativa <= MAX_TENTATIVAS && !marcouContexto; tentativa++) {
        try { await atualizarContexto({ chatNumber: telefone, variaveis }); marcouContexto = true; erroContexto = ''; }
        catch (e) {
          erroContexto = e.message || String(e);
          const propagando = /encontrad|not found/i.test(erroContexto);
          // espera crescente (2s, 2.5s, 3s, …) só enquanto o chat ainda está propagando
          if (tentativa < MAX_TENTATIVAS && propagando) { await new Promise(r => setTimeout(r, 1500 + tentativa * 500)); }
          else { console.warn('[preCadastrarLead] chat_update_context falhou:', erroContexto); break; }
        }
      }

      // 2b) O MESMO gclid no CAMPO PERSONALIZADO do contato — é este que aparece na
      // ficha do atendimento; a variável de contexto do passo 2 fica só no bot_context
      // e ninguém vê. Chamada acessória: se falhar, o lead entra do mesmo jeito.
      let marcouCampo = false, erroCampo = '';
      if (marcarClique) {
        try { await atualizarCamposPersonalizados({ chatNumber: telefone, campos: { gclid: cliqueNovo } }); marcouCampo = true; }
        catch (e) { erroCampo = e.message || String(e); console.warn('[preCadastrarLead] campo gclid falhou:', erroCampo); }
      }

      // 3) CRIA O LEAD NO CRM (Postgres) — é isto que se perdia: o form gravava no
      // Firebase e a navegação pro WhatsApp matava a escrita. Agora é o backend que
      // grava (o fetch do site usa keepalive → chega mesmo saindo pro WhatsApp).
      let leadCriado = false, erroLead = '';
      try {
        const id = idLead;
        const iso = new Date().toISOString();
        const lead = {
          id, nome: b.nome || '', empresa: '', telefone: String(telefone), email: b.email || '', cpfCnpj: '',
          veiculoDesc: b.veiculo || '', placa: '', origem: b.origem || '', destino: b.destino || '',
          valorEstimado: '', etapa: 'novo', prioridade: 'morno', vendedor: '',
          origemLead: 'site', valorVeiculo: b.valor || b.valorVeiculo || '',
          funciona: b.funciona || '', blindado: b.blindado || '', dataEnvio: iso,
          tipoCliente: b.tipoCliente || '', categoria: b.categoria || '',
          mensagem: b.mensagem || '', dataEntrada: iso.slice(0, 10), ultimaInteracao: iso,
          ...origemDoLead(b, leadAtual),   // gclid/UTMs/página — sem apagar atribuição anterior
          timeline: [{ data: iso, tipo: 'criacao', texto: 'Lead recebido pelo formulário do site' }],
          _origemSite: true,
        };
        // merge:true → se o lead já existir (cliente mandou msg → webhook), não apaga o que já tem
        await getFirestore().collection('crm_leads').doc(id).set(lead, { merge: true });
        leadCriado = true;
      } catch (e) { erroLead = e.message || String(e); console.warn('[preCadastrarLead] criar lead no CRM falhou:', erroLead); }

      // o gclid vai junto com o Cotando na MESMA chamada — se ela falhou, ele não foi.
      // Dizer "→ ChatGuru" sem isso já enganou uma vez na leitura do log.
      const _destinoGclid = !marcarClique ? ' — já atribuído antes'
        : ` → ficha ${marcouCampo ? 'OK' : 'FALHOU'}${erroCampo ? ' (' + erroCampo + ')' : ''}, contexto ${marcouContexto ? 'OK' : 'FALHOU'}`;
      const _ads = cliqueNovo
        ? ` | ADS ${cliqueNovo.slice(0, 12)}… (${b.utm_campaign || 's/ campanha'})${_destinoGclid}`
        : '';
      console.log(`[preCadastrarLead] ${telefone}: chat_add=${criouChat} cotando=${marcouContexto} leadCriado=${leadCriado}${_ads}${erroChat ? ' | erroChat: ' + erroChat : ''}${erroContexto ? ' | erroCtx: ' + erroContexto : ''}${erroLead ? ' | erroLead: ' + erroLead : ''}`);
      // sempre 200 (best-effort): o site segue pro WhatsApp de qualquer jeito
      res.json({ ok: true, criouChat, marcouContexto, leadCriado, erroChat: erroChat || undefined, erroContexto: erroContexto || undefined, erroLead: erroLead || undefined });
    } catch (e) {
      console.error('[preCadastrarLead] ERRO:', e);
      res.status(200).json({ ok: false, erro: e.message || String(e) });   // 200 pra não travar o site
    }
  }
);

/* ----------------------------------------------------------------------------
   openerDisparou — o Opener (contato espontâneo) chama isto por POST no disparo.

   Por que: o Opener dispara em `!new_chat` (evento de CRIAÇÃO do chat, sem
   mensagem). O "Contexto de Saída" do ChatGuru é ADIADO ("vale da próxima
   mensagem") e num gatilho de criação, sem mensagem pra ancorar, ele é
   DESCARTADO — por isso o Opener nunca gravava `Cotando=Sim` (casos edson/Chico).
   As ações IMEDIATAS (Responder, status→ABERTO) commitam; então uma ação de
   POST também commita. Aqui o backend grava `Cotando=Sim` via API (chat_update_
   context) — o MESMO caminho que já provou funcionar no pré-cadastro. Com o
   Cotando gravado, o encaminhador (`$Cotando=='Sim'`) passa a repassar a
   resposta do cliente → o backend cota.

   O ChatGuru manda o payload NATIVO (o número vem em `celular`).
   ---------------------------------------------------------------------------- */
exports.openerDisparou = onRequest(
  {
    cors: true,
    region: 'southamerica-east1',
    secrets: ['CHATGURU_API_KEY', 'CHATGURU_ACCOUNT_ID', 'CHATGURU_PHONE_ID'],
  },
  async (req, res) => {
    try {
      if (req.method === 'GET') { res.json({ ok: true, servico: 'openerDisparou', dica: 'POST (payload nativo do ChatGuru — número em celular) → liga Cotando=Sim' }); return; }
      if (req.method !== 'POST') { res.status(405).json({ ok: false, erro: 'use POST' }); return; }

      const b = req.body || {};
      const telefone = b.celular || b.phone || b.telefone || b.chat_number || b.numero || '';
      if (!telefone) { res.status(200).json({ ok: false, erro: 'telefone (celular) ausente' }); return; }

      // O chat já existe (o cliente mandou a saudação que criou o chat + disparou o
      // Opener), então o contexto costuma gravar de primeira. Retry REFORÇADO (até 6x,
      // espera crescente): é o Cotando=Sim daqui que faz o encaminhador [6] repassar a
      // resposta do cliente — se falhar, o bloco preenchido não chega ao backend.
      let ok = false, erro = '';
      for (let tentativa = 1; tentativa <= 6 && !ok; tentativa++) {
        try { await atualizarContexto({ chatNumber: telefone, variaveis: { Cotando: 'Sim' } }); ok = true; erro = ''; }
        catch (e) {
          erro = e.message || String(e);
          if (tentativa < 6) { await new Promise(r => setTimeout(r, 1000 + tentativa * 500)); }
          else { console.warn('[openerDisparou] chat_update_context falhou (6 tentativas):', erro); }
        }
      }
      console.log(`[openerDisparou] ${telefone}: cotando=${ok}${erro ? ' | ' + erro : ''}`);
      res.status(200).json({ ok, cotando: ok, telefone, erro: erro || undefined });
    } catch (e) {
      console.error('[openerDisparou] ERRO:', e);
      res.status(200).json({ ok: false, erro: e.message || String(e) });
    }
  }
);
