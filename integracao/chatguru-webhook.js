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
const { onSchedule } = require('firebase-functions/v2/scheduler');
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

/* Palavras-chave que indicam um campo útil pro cálculo (origem, destino,
   veículo, valor…). Serve pra reconhecer os CAMPOS PERSONALIZADOS do ChatGuru
   pelo NOME, sem depender de nomes exatos. */
const CAMPO_RELEVANTE = /(origem|destino|coleta|entrega|ve[ií]culo|carro|moto|caminh|modelo|marca|\bano\b|valor|pre[çc]o|cidade|munic|\buf\b|estado|\bcep\b|placa|mercadoria|transporte|rota|trecho|leil)/i;

/* Devolve pares [rótulo, valor] de um contêiner de campos personalizados.
   O ChatGuru pode mandar isso como OBJETO ({ "Local de destino": "..." }) ou
   como LISTA de objetos ([{ name/label/campo, value/valor }]). */
function _paresDeCampos(container){
  const pares = [];
  if(Array.isArray(container)){
    for(const item of container){
      if(!item || typeof item !== 'object') continue;
      const rotulo = item.nome || item.name || item.label || item.campo
                  || item.key || item.chave || item.field || '';
      const valor  = item.valor != null ? item.valor
                  : (item.value != null ? item.value
                  : (item.conteudo != null ? item.conteudo : item.text));
      if(rotulo && valor != null && String(valor).trim() !== '')
        pares.push([String(rotulo), String(valor)]);
    }
  } else if(container && typeof container === 'object'){
    for(const [k, v] of Object.entries(container)){
      if(v == null || typeof v === 'object') continue; // só primitivos, sem descer
      if(String(v).trim() === '') continue;
      pares.push([k, String(v)]);
    }
  }
  return pares;
}

/* Junta os CAMPOS PERSONALIZADOS / variáveis de contexto do ChatGuru num
   textinho ("Rótulo: valor"), pra IA extrair origem/destino/veículo/valor
   MESMO quando o cliente não digitou tudo numa mensagem (contatos diretos que
   o atendente aciona pelo "Gerar Orçamento (Backend OBS)"). */
function coletarCamposExtras(b){
  const nomesContainer = ['campos','campos_personalizados','custom_fields','customFields',
                          'variaveis','variables','contexto','context','bot_context',
                          'dados_personalizados','fields','data','chat','contato'];
  const containers = [b];
  for(const n of nomesContainer){
    if(b[n] && typeof b[n] === 'object') containers.push(b[n]);
  }
  const linhas = [];
  const vistos = new Set();
  for(const c of containers){
    for(const [rotulo, valor] of _paresDeCampos(c)){
      if(!CAMPO_RELEVANTE.test(rotulo)) continue;
      if(MARCADOR_VALOR.test(String(valor).trim())) continue; // é o marcador (ex.: "fechar"), não é dado de rota
      const chave = (rotulo + '=' + valor).toLowerCase();
      if(vistos.has(chave)) continue;
      vistos.add(chave);
      linhas.push(`${rotulo}: ${valor}`);
    }
  }
  return linhas.join('\n');
}

/* O atendente aciona o "Gerar Orçamento (Backend OBS)" quando JÁ coletou tudo.
   Nesse caso não faz sentido esperar os 60s de silêncio: se o POST trouxer um
   MARCADOR combinado, fechamos o lead na hora → a IA processa e responde em
   segundos. Se não vier nada, o fluxo normal (janela de 60s) continua valendo.

   Como a ação "POST PARA URL" do ChatGuru só tem campos FIXOS (ID/Nome de
   campanha, ORIGEM, tokens), o atendente põe um valor combinado (ex.: "fechar")
   no campo ORIGEM. Reconhecemos esse VALOR em qualquer campo do corpo. Também
   aceitamos, por robustez, um campo com NOME de marcador (ex.: fechar=sim). */
const MARCADOR_VALOR = /^(fechar|fechar[ _-]?agora|acionar|processar[ _-]?agora|completo|gerar[ _-]?or[çc]amento|backend[ _-]?obs)$/i;
const MARCADORES_CHAVE = ['fechar','fechar_agora','fecharAgora','acionar','acionar_agora',
                          'processar_agora','processarAgora','completar','gerar_orcamento','gerarOrcamento'];

/* Junta os VALORES de texto do corpo (topo + contêineres conhecidos, 1 nível). */
function _valoresDoCorpo(b){
  const vals = [];
  const push = (v)=>{ if(v!=null && typeof v!=='object'){ const s=String(v).trim(); if(s) vals.push(s); } };
  const nomes = ['campos','campos_personalizados','custom_fields','customFields',
                 'variaveis','variables','contexto','context','bot_context',
                 'dados_personalizados','fields','data','chat','contato'];
  const containers = [b];
  for(const n of nomes){ if(b && b[n] && typeof b[n] === 'object') containers.push(b[n]); }
  for(const c of containers){
    if(Array.isArray(c)){
      for(const it of c){
        if(it && typeof it === 'object'){ push(it.valor); push(it.value); push(it.conteudo); push(it.text); }
        else push(it);
      }
    } else if(c && typeof c === 'object'){
      for(const v of Object.values(c)) push(v);
    }
  }
  return vals;
}

function querFecharAgora(b){
  if(!b || typeof b !== 'object') return false;
  // (1) VALOR combinado (ex.: ORIGEM="fechar") em qualquer campo do corpo.
  for(const v of _valoresDoCorpo(b)){
    if(MARCADOR_VALOR.test(v)) return true;
  }
  // (2) campo com NOME de marcador e valor afirmativo (ex.: fechar=sim).
  for(const k of MARCADORES_CHAVE){
    if(b[k] == null) continue;
    const s = String(b[k]).trim().toLowerCase();
    if(s === '' || /(n[aã]o|false|^0$|^no$)/.test(s)) continue; // vazio/negativo → ignora
    return true;
  }
  return false;
}

/* É o INÍCIO de uma nova cotação? (formulário do site ou botão do atendente).
   Serve pra REINICIAR o ciclo de um número que JÁ foi cotado antes — senão o
   cliente que volta (ou o mesmo número em novo teste) fica travado no guard
   iaProcessado e não recebe nada. Uma resposta solta do cliente (continuação)
   NÃO conta como início — ela só acumula no ciclo em andamento. */
function ehInicioDeCotacao(corpo, texto){
  if(querFecharAgora(corpo)) return true;                                  // botão "Gerar Orçamento (Backend OBS)"
  if(/solicita[çc][aã]o de or[çc]amento/i.test(String(texto || ''))) return true; // formulário
  return false;
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

  const emailBruto = pegar(b, 'email', 'e-mail')
             || pegar(contato, 'email')
             || pegar(data, 'email');
  // ATENÇÃO: o ChatGuru às vezes coloca o TELEFONE no campo "email" (quando o
  // contato não tem e-mail salvo). Só aceitamos se parecer e-mail de verdade
  // (tiver "@"). O e-mail real, quando existe, vem DENTRO do texto do formulário
  // — a Etapa 4 (Claude) extrai de lá.
  const email = /@/.test(String(emailBruto)) ? emailBruto : '';

  const textoMsg = pegar(b, 'texto_mensagem', 'mensagem', 'texto', 'message',
                         'msg', 'body', 'text', 'ultima_mensagem', 'content')
             || pegar(chat, 'mensagem', 'texto', 'message')
             || pegar(data, 'mensagem', 'texto', 'message');

  // CAMPOS PERSONALIZADOS: só colhemos no ACIONAMENTO MANUAL do botão "Gerar
  // Orçamento" (origem=fechar), onde o atendente conta com esses campos. Nas
  // mensagens soltas (encaminhador) e no formulário, os dados estão no TEXTO da
  // conversa — colher os campos aqui só traria valores de ORÇAMENTOS ANTERIORES
  // (campos velhos), e como cada mensagem reencaminhada recolava os campos, eles
  // se REPETIAM no acúmulo e afogavam o que o cliente escreveu (caso Jorge:
  // "Fiat Argo/Araguaiana" velho vencendo "Macan/São Paulo" da conversa).
  // Quando colhidos (botão), entram como fonte SECUNDÁRIA (a conversa tem prioridade).
  const camposExtras = querFecharAgora(b) ? coletarCamposExtras(b) : '';
  const partes = [];
  if(String(textoMsg || '').trim()) partes.push(String(textoMsg).trim());
  if(String(camposExtras || '').trim()){
    partes.push(
      '--- Campos do ChatGuru (fonte SECUNDÁRIA — podem ser de um orçamento ' +
      'ANTERIOR; se conflitarem com a conversa acima, USE A CONVERSA) ---\n' + camposExtras
    );
  }
  const texto = partes.join('\n\n');

  const status = pegar(b, 'status', 'situacao', 'stage') || pegar(chat, 'status');

  // Id da conversa no ChatGuru — guardamos pra Etapa 5 (responder pelo ChatGuru).
  const chatId = pegar(b, 'chat_id', 'chatId') || pegar(chat, 'id', 'chat_id');

  // Responsável (vendedor) da conversa no ChatGuru — pra manter igual ao do CRM.
  const responsavel = pegar(b, 'responsavel_nome', 'responsavelNome', 'responsible_name')
                   || pegar(chat, 'responsavel_nome', 'responsible_name');
  const responsavelEmail = pegar(b, 'responsavel_email', 'responsavelEmail', 'responsible_email')
                        || pegar(chat, 'responsavel_email', 'responsible_email');

  return {
    telefone: soDigitos(telefoneBruto),
    telefoneOriginal: String(telefoneBruto || ''),
    nome:  String(nome  || '').trim(),
    email: String(email || '').trim(),
    texto: String(texto || '').trim(),
    status: String(status || '').trim(),
    chatId: String(chatId || '').trim(),
    responsavel: String(responsavel || '').trim(),
    responsavelEmail: String(responsavelEmail || '').trim(),
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

      const inicioCotacao = ehInicioDeCotacao(corpo, info.texto);

      const ref = db.collection('crm_leads_intake').doc(info.telefone);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const antigo = snap.exists ? (snap.data() || {}) : {};

        // NOVO CICLO: primeira vez do contato, OU uma NOVA solicitação
        // (formulário/botão) de um número que JÁ foi processado/cotado antes.
        // Reiniciar zera o guard iaProcessado/leadCriado pra IA reprocessar e o
        // lead reenviar — assim o cliente que volta recebe orçamento de novo.
        const jaFinalizado = !!(antigo.iaProcessado || antigo.leadCriado);
        if(!snap.exists || (inicioCotacao && jaFinalizado)){
          tx.set(ref, {
            telefone: info.telefone,
            telefoneOriginal: info.telefoneOriginal,
            nome:  info.nome  || antigo.nome  || '',
            email: info.email || antigo.email || '',
            chatId: info.chatId || antigo.chatId || '',          // id da conversa no ChatGuru (p/ Etapa 5)
            responsavelChatguru: info.responsavel || antigo.responsavelChatguru || '',
            responsavelEmailChatguru: info.responsavelEmail || antigo.responsavelEmailChatguru || '',
            origemLead: 'chatguru',
            statusIntake: 'recebendo',   // Etapa 3 muda pra 'completo' após a janela
            janelaSegundos: JANELA_SEGUNDOS,
            primeiraMensagemEm: agora,
            ultimaMensagemEm: agora,
            totalMensagens: 1,
            mensagens: [mensagem],
            // zera o ciclo anterior (deixa a IA reprocessar e o lead reenviar):
            iaProcessado: false,
            leadCriado: false,
            extraido: null,
            mensagemCompleta: '',
            perguntasFeitas: 0,
            faltamCampos: [],
            cicloReiniciadoEm: agora,
          });
          return;
        }

        const patch = {
          ultimaMensagemEm: agora,
          statusIntake: 'recebendo',
          totalMensagens: (antigo.totalMensagens || 0) + 1,
          mensagens: [...(antigo.mensagens || []), mensagem],
        };
        // Só preenche nome/email/chatId se vieram agora e ainda não tínhamos.
        if(info.nome   && !antigo.nome)   patch.nome   = info.nome;
        if(info.email  && !antigo.email)  patch.email  = info.email;
        if(info.chatId && !antigo.chatId) patch.chatId = info.chatId;
        // Responsável: sempre atualiza pro mais recente (pode mudar na conversa).
        if(info.responsavel)      patch.responsavelChatguru = info.responsavel;
        if(info.responsavelEmail) patch.responsavelEmailChatguru = info.responsavelEmail;
        tx.update(ref, patch);
      });

      // ---- 2b) CONTATO DIRETO: fechar NA HORA se o atendente acionou ----
      // Quando o POST traz um marcador (ex.: fechar=sim, vindo do diálogo
      // "Gerar Orçamento (Backend OBS)"), não esperamos os 60s: marcamos o lead
      // como 'completo' já, e a IA (processarLeadCompleto) dispara em segundos.
      // Só faz isso se o lead ainda não passou pela IA (a Fase C — resposta do
      // cliente a uma pergunta — continua usando o fluxo normal de 60s).
      let fechadoNaHora = false;
      if(querFecharAgora(corpo)){
        try {
          const atual = (await ref.get()).data() || {};
          if(!atual.iaProcessado && atual.statusIntake !== 'completo'){
            await ref.update({
              statusIntake: 'completo',
              completadoEm: FieldValue.serverTimestamp(),
              mensagemCompleta: montarMensagemCompleta(atual.mensagens),
              fechadoManual: true,
            });
            fechadoNaHora = true;
            console.log(`[chatguruWebhook] Lead ${info.telefone} FECHADO NA HORA (acionamento do atendente) — IA vai processar já.`);
          }
        } catch(err){
          // Se falhar, não quebra o webhook: a varredura de 60s fecha depois.
          console.error('[chatguruWebhook] erro ao fechar na hora:', err);
        }
      }

      res.json({
        ok: true,
        salvo: 'intake',
        telefone: info.telefone,
        temTexto: !!info.texto,
        fechadoNaHora,
      });
    } catch (e) {
      console.error('[chatguruWebhook] ERRO:', e);
      res.status(500).json({ ok:false, erro: e.message || String(e) });
    }
  }
);

/* ============================================================================
   ETAPA 3 — Fechar o lead após a janela de silêncio (acumulação)

   A acumulação já acontece no webhook acima (cada POST empilha a mensagem no
   documento do contato). O que falta é decidir QUANDO o cliente terminou de
   escrever. Como uma função serverless não pode "segurar" um cronômetro na
   memória, usamos o padrão robusto: uma função AGENDADA que roda de minuto em
   minuto e varre os leads ainda "recebendo". Se um lead ficou parado por mais
   de LEAD_JANELA_SEGUNDOS (60s por padrão), marcamos como 'completo'.

   Um lead 'completo' é o gatilho da ETAPA 4 (chamar o Claude p/ extrair os
   campos e decidir humano x automático) — que ainda NÃO fazemos aqui.

   Observação sobre o tempo: a janela lógica é LEAD_JANELA_SEGUNDOS (fácil de
   ajustar). A varredura roda a cada 1 min (menor intervalo do Cloud Scheduler),
   então um lead fecha entre ~60s e ~120s após a última mensagem. Se precisar de
   reação mais rápida no futuro, dá pra trocar por Cloud Tasks — mas pro volume
   da OBS, 1 min é de sobra e bem mais simples.
   ---------------------------------------------------------------------------- */

/* Converte um Timestamp do Firestore (ou ISO/Date) em milissegundos. */
function paraMillis(v){
  if(!v) return 0;
  if(typeof v.toMillis === 'function') return v.toMillis(); // Firestore Timestamp
  if(typeof v.toDate  === 'function') return v.toDate().getTime();
  const d = new Date(v);
  return isNaN(d) ? 0 : d.getTime();
}

/* Junta os textos das mensagens acumuladas num só bloco (útil p/ a Etapa 4). */
function montarMensagemCompleta(mensagens){
  return (mensagens || [])
    .map(m => (m && m.texto ? String(m.texto).trim() : ''))
    .filter(Boolean)
    .join('\n');
}

exports.fecharLeadsCompletos = onSchedule(
  { schedule: 'every 1 minutes', region: 'southamerica-east1', timeZone: 'America/Sao_Paulo' },
  async () => {
    const agoraMs = Date.now();
    const limiteMs = JANELA_SEGUNDOS * 1000;

    // Buscamos só os que ainda estão recebendo. O corte por tempo é feito em
    // código (evita precisar criar índice composto no Firestore).
    const snap = await db.collection('crm_leads_intake')
      .where('statusIntake', '==', 'recebendo')
      .get();

    if(snap.empty){
      console.log('[fecharLeadsCompletos] Nenhum lead em recebimento.');
      return;
    }

    let fechados = 0;
    for(const doc of snap.docs){
      const d = doc.data() || {};
      const janela = Number(d.janelaSegundos || JANELA_SEGUNDOS) * 1000;
      const ultimaMs = paraMillis(d.ultimaMensagemEm);
      if(!ultimaMs) continue; // sem timestamp confiável, deixa pra próxima volta

      const silencioMs = agoraMs - ultimaMs;
      if(silencioMs < (janela || limiteMs)) continue; // ainda pode vir mais mensagem

      await doc.ref.update({
        statusIntake: 'completo',
        completadoEm: FieldValue.serverTimestamp(),
        mensagemCompleta: montarMensagemCompleta(d.mensagens),
      });
      fechados++;
      console.log(
        `[fecharLeadsCompletos] Lead ${doc.id} COMPLETO ` +
        `(${d.totalMensagens || 0} msg, silencio ${Math.round(silencioMs/1000)}s).`
      );
    }

    console.log(`[fecharLeadsCompletos] Fechados nesta rodada: ${fechados}/${snap.size}.`);
  }
);
