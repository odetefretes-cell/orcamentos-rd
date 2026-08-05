/* ============================================================================
   OBS Transportes — Entrada de leads (ETAPA 1 + 2 da automação)

   O ChatGuru dispara um WEBHOOK (um POST) toda vez que um lead chega com a
   conversa em aberto, mandando o TEXTO da mensagem do cliente. Esta função:

     1. RECEBE esse POST.
     2. GUARDA a mensagem no Firestore, associada ao contato (telefone).
     3. LOGA de forma clara tudo que chegou, pra você conferir no console do
        Firebase enquanto testa com um lead real.

   AINDA NÃO faz: chamar o Claude, calcular orçamento ou responder. Isso vem
   nas próximas etapas. Aqui a gente só valida a ENTRADA.

   ----------------------------------------------------------------------------
   Onde os dados ficam salvos no Firestore:

     crm_leads_intake/{telefone}
        └─ documento por CONTATO (id = só os dígitos do telefone).
           Acumula as mensagens daquele contato num array `mensagens`.
           (É daqui que a Etapa 3 vai ler pra "fechar" o lead após 60s.)

     chatguru_webhook_log/{auto}
        └─ um documento por POST recebido, com o corpo CRU (raw) que o
           ChatGuru mandou. Serve de "caixa-preta" pra você ver exatamente
           o formato real dos campos e ajustar depois, se precisar.

   Repare: usamos coleções NOVAS (crm_leads_intake / chatguru_webhook_log), sem
   tocar na coleção `crm_leads` que o app já mostra no CRM. Assim dá pra testar
   a entrada sem bagunçar o Kanban da equipe.
   ============================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// firebase-admin já é inicializado em webhook.js (initializeApp()); aqui só
// pegamos o Firestore. Se um dia esta função rodar sozinha, o getFirestore()
// continua funcionando porque o app default já foi inicializado.
const db = getFirestore();

/* Janela de acumulação de mensagens (ETAPA 3 — ainda não implementada aqui).
   Deixo o valor pronto e fácil de ajustar via variável de ambiente. */
const JANELA_SEGUNDOS = Number(process.env.LEAD_JANELA_SEGUNDOS || 60);

/* Segredo simples opcional: se você definir CG_WEBHOOK_SECRET, o ChatGuru
   precisa mandar o mesmo valor no cabeçalho X-CG-Secret. Sem isso definido,
   a função aceita qualquer POST (mais fácil pra começar a testar). */
const CG_WEBHOOK_SECRET = process.env.CG_WEBHOOK_SECRET || '';

/* --- Ajudantes -------------------------------------------------------------- */

function soDigitos(v){ return String(v == null ? '' : v).replace(/\D/g, ''); }

/* Procura um valor em vários nomes de campo possíveis (o ChatGuru pode nomear
   diferente do que a gente espera). Aceita também objetos aninhados simples. */
function pegar(obj, ...chaves){
  for(const k of chaves){
    if(obj && obj[k] != null && String(obj[k]).trim() !== '') return obj[k];
  }
  return '';
}

/* A partir do corpo do webhook, extrai os campos que a gente consegue
   reconhecer. Tudo é "melhor esforço": se não achar, fica vazio — e o corpo
   CRU fica salvo no log de qualquer jeito, então nada se perde. */
function extrairContato(b){
  // alguns webhooks aninham os dados dentro de "chat", "contato" ou "data"
  const chat    = (b.chat && typeof b.chat === 'object') ? b.chat : {};
  const contato = (b.contato && typeof b.contato === 'object') ? b.contato : {};
  const data    = (b.data && typeof b.data === 'object') ? b.data : {};

  const telefoneBruto = pegar(b, 'celular', 'telefone', 'phone', 'tel', 'numero',
                                  'chat_number', 'whatsapp', 'number')
                     || pegar(chat, 'celular', 'phone', 'number')
                     || pegar(contato, 'celular', 'telefone', 'phone')
                     || pegar(data, 'celular', 'telefone', 'phone');

  const nome = pegar(b, 'nome', 'name', 'contact_name', 'nome_contato')
            || pegar(chat, 'nome', 'name')
            || pegar(contato, 'nome', 'name');

  const email = pegar(b, 'email', 'e-mail')
             || pegar(contato, 'email')
             || pegar(data, 'email');

  const texto = pegar(b, 'texto_mensagem', 'mensagem', 'texto', 'message',
                         'msg', 'body', 'text', 'ultima_mensagem', 'content')
             || pegar(chat, 'mensagem', 'texto', 'message')
             || pegar(data, 'mensagem', 'texto', 'message');

  const status = pegar(b, 'status', 'situacao', 'stage') || pegar(chat, 'status');

  return {
    telefone: soDigitos(telefoneBruto),
    telefoneOriginal: String(telefoneBruto || ''),
    nome:  String(nome  || '').trim(),
    email: String(email || '').trim(),
    texto: String(texto || '').trim(),
    status: String(status || '').trim(),
  };
}

/* --- A função HTTPS --------------------------------------------------------- */

exports.chatguruWebhook = onRequest(
  { cors: true, region: 'southamerica-east1' },
  async (req, res) => {
    try {
      // Teste no navegador (GET): confirma que a função está no ar.
      if(req.method === 'GET'){
        res.json({
          ok: true,
          servico: 'chatguruWebhook',
          dica: 'Configure o webhook do ChatGuru para fazer POST nesta URL.',
          janelaSegundos: JANELA_SEGUNDOS,
        });
        return;
      }

      if(req.method !== 'POST'){
        res.status(405).json({ ok:false, erro:'use POST' });
        return;
      }

      // Segredo opcional (só valida se você tiver configurado um).
      if(CG_WEBHOOK_SECRET && req.get('X-CG-Secret') !== CG_WEBHOOK_SECRET){
        console.warn('[chatguruWebhook] POST rejeitado: X-CG-Secret invalido.');
        res.status(401).json({ ok:false, erro:'nao autorizado' });
        return;
      }

      const corpo = req.body || {};
      const info  = extrairContato(corpo);

      // ---- LOG CLARO do que chegou (aparece em Firebase Console > Functions > Logs)
      console.log('===== [chatguruWebhook] LEAD RECEBIDO =====');
      console.log('Telefone :', info.telefone || '(nao identificado)');
      console.log('Nome     :', info.nome     || '(vazio)');
      console.log('E-mail   :', info.email    || '(vazio)');
      console.log('Status   :', info.status   || '(vazio)');
      console.log('Mensagem :', info.texto    || '(vazia)');
      console.log('Corpo cru:', JSON.stringify(corpo));
      console.log('===========================================');

      // ---- 1) Guarda o POST cru no log (caixa-preta pra debug) ----
      const agora = FieldValue.serverTimestamp();
      await db.collection('chatguru_webhook_log').add({
        recebidoEm: agora,
        telefone: info.telefone,
        raw: corpo,
      });

      // Sem telefone não dá pra associar ao contato: registramos no log
      // (feito acima) e avisamos, mas não quebramos o webhook.
      if(!info.telefone){
        console.warn('[chatguruWebhook] Sem telefone no corpo — salvo só no log.');
        res.json({ ok:true, salvo:'somente_log', motivo:'telefone_ausente' });
        return;
      }

      // ---- 2) Acumula a mensagem no documento do CONTATO ----
      // id = dígitos do telefone → todas as mensagens do mesmo cliente caem no
      // mesmo documento. Usamos uma TRANSAÇÃO pra, na mesma operação:
      //   - CRIAR o documento se for o primeiro contato (grava primeiraMensagemEm);
      //   - ou só ACRESCENTAR a mensagem e atualizar os contadores/nome/email.
      // Isso evita sobrescrever a "primeira mensagem" e evita campos undefined.
      const mensagem = {
        texto: info.texto,
        recebidoEm: new Date().toISOString(), // dentro de array não dá pra usar serverTimestamp
        status: info.status,
      };

      const ref = db.collection('crm_leads_intake').doc(info.telefone);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);

        if(!snap.exists){
          tx.set(ref, {
            telefone: info.telefone,
            telefoneOriginal: info.telefoneOriginal,
            nome:  info.nome,
            email: info.email,
            origemLead: 'chatguru',
            statusIntake: 'recebendo',   // Etapa 3 muda pra 'completo' após a janela
            janelaSegundos: JANELA_SEGUNDOS,
            primeiraMensagemEm: agora,
            ultimaMensagemEm: agora,
            totalMensagens: 1,
            mensagens: [mensagem],
          });
          return;
        }

        const antigo = snap.data() || {};
        const patch = {
          ultimaMensagemEm: agora,
          statusIntake: 'recebendo',
          totalMensagens: (antigo.totalMensagens || 0) + 1,
          mensagens: [...(antigo.mensagens || []), mensagem],
        };
        // Só preenche nome/email se vieram agora e ainda não tínhamos.
        if(info.nome  && !antigo.nome)  patch.nome  = info.nome;
        if(info.email && !antigo.email) patch.email = info.email;
        tx.update(ref, patch);
      });

      res.json({
        ok: true,
        salvo: 'intake',
        telefone: info.telefone,
        temTexto: !!info.texto,
      });
    } catch (e) {
      console.error('[chatguruWebhook] ERRO:', e);
      res.status(500).json({ ok:false, erro: e.message || String(e) });
    }
  }
);
