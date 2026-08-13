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
const { criarChat, atualizarContexto } = require('./chatguru-api');

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

      // 1) cria o chat (deixa de ser !new_chat quando a mensagem chegar).
      // Esta conta exige "mensagem inicial" no chat_add — usamos uma saudação
      // segura (caso o ChatGuru a entregue ao cliente).
      const saudacao = 'Olá! Aqui é a OBS Transportes 🚚 — recebemos sua solicitação e já vamos te enviar a estimativa por aqui. 😊';
      let criouChat = false, erroChat = '';
      try { await criarChat({ chatNumber: telefone, nome: b.nome || '', text: saudacao }); criouChat = true; }
      catch (e) { erroChat = e.message || String(e); console.warn('[preCadastrarLead] chat_add falhou:', erroChat); }

      // 2) liga Cotando=Sim (+ dados do formulário como contexto — bônus p/ a IA/atendente)
      const variaveis = { Cotando: 'Sim' };
      if (b.origem)  variaveis.Origem  = String(b.origem);
      if (b.destino) variaveis.Destino = String(b.destino);
      if (b.veiculo) variaveis.Veiculo = String(b.veiculo);
      if (b.valor)   variaveis.Valor   = String(b.valor);

      let marcouContexto = false, erroContexto = '';
      try { await atualizarContexto({ chatNumber: telefone, variaveis }); marcouContexto = true; }
      catch (e) { erroContexto = e.message || String(e); console.warn('[preCadastrarLead] chat_update_context falhou:', erroContexto); }

      console.log(`[preCadastrarLead] ${telefone}: chat_add=${criouChat} cotando=${marcouContexto}${erroChat ? ' | erroChat: ' + erroChat : ''}${erroContexto ? ' | erroCtx: ' + erroContexto : ''}`);
      // sempre 200 (best-effort): o site segue pro WhatsApp de qualquer jeito
      res.json({ ok: true, criouChat, marcouContexto, erroChat: erroChat || undefined, erroContexto: erroContexto || undefined });
    } catch (e) {
      console.error('[preCadastrarLead] ERRO:', e);
      res.status(200).json({ ok: false, erro: e.message || String(e) });   // 200 pra não travar o site
    }
  }
);
