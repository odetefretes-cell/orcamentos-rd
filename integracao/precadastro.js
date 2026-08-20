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
        try { await atualizarContexto({ chatNumber: telefone, variaveis }); marcouContexto = true; }
        catch (e) {
          erroContexto = e.message || String(e);
          const propagando = /encontrad|not found/i.test(erroContexto);
          // espera crescente (2s, 2.5s, 3s, …) só enquanto o chat ainda está propagando
          if (tentativa < MAX_TENTATIVAS && propagando) { await new Promise(r => setTimeout(r, 1500 + tentativa * 500)); }
          else { console.warn('[preCadastrarLead] chat_update_context falhou:', erroContexto); break; }
        }
      }

      console.log(`[preCadastrarLead] ${telefone}: chat_add=${criouChat} cotando=${marcouContexto}${erroChat ? ' | erroChat: ' + erroChat : ''}${erroContexto ? ' | erroCtx: ' + erroContexto : ''}`);
      // sempre 200 (best-effort): o site segue pro WhatsApp de qualquer jeito
      res.json({ ok: true, criouChat, marcouContexto, erroChat: erroChat || undefined, erroContexto: erroContexto || undefined });
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
      // Opener), então o contexto deve gravar de primeira; retry leve por segurança.
      let ok = false, erro = '';
      for (let tentativa = 1; tentativa <= 3 && !ok; tentativa++) {
        try { await atualizarContexto({ chatNumber: telefone, variaveis: { Cotando: 'Sim' } }); ok = true; }
        catch (e) {
          erro = e.message || String(e);
          if (tentativa < 3 && /encontrad|not found/i.test(erro)) { await new Promise(r => setTimeout(r, 1500)); }
          else { console.warn('[openerDisparou] chat_update_context falhou:', erro); break; }
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
