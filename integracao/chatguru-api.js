/* ============================================================================
   OBS Transportes — cliente da API do ChatGuru (envio de mensagem)

   Doc: POST form-urlencoded para https://{servidor}.chatguru.app/api/v1
   Autenticação em TODA requisição: key, account_id, phone_id.

   Credenciais vêm de variáveis de ambiente/segredos (nunca no código):
     CHATGURU_API_URL     (padrão https://s22.chatguru.app/api/v1)
     CHATGURU_API_KEY
     CHATGURU_ACCOUNT_ID
     CHATGURU_PHONE_ID
   ============================================================================ */

const CHATGURU_URL = process.env.CHATGURU_API_URL || 'https://s22.chatguru.app/api/v1';

/* Normaliza um telefone brasileiro para o formato que o ChatGuru espera:
   código do país (55) + DDD + número. Sem o 55, a mensagem NÃO é entregue.
   - 12/13 dígitos começando com 55  -> já está certo, mantém.
   - 10/11 dígitos (DDD + número)     -> acrescenta o 55.
   - outros                           -> devolve como veio (não adivinha). */
function normalizarNumeroBR(num){
  const d = String(num == null ? '' : num).replace(/\D/g, '');
  if(!d) return d;
  if(d.length >= 12 && d.startsWith('55')) return d;
  if(d.length === 10 || d.length === 11) return '55' + d;
  return d;
}

/* Envia uma mensagem de texto para um chat já existente (action=message_send). */
async function enviarMensagem({ chatNumber, texto }){
  const key       = process.env.CHATGURU_API_KEY || '';
  const accountId = process.env.CHATGURU_ACCOUNT_ID || '';
  const phoneId   = process.env.CHATGURU_PHONE_ID || '';
  if(!key || !accountId || !phoneId){
    throw new Error('Credenciais do ChatGuru não configuradas (CHATGURU_API_KEY/ACCOUNT_ID/PHONE_ID).');
  }
  if(!chatNumber) throw new Error('chat_number (telefone) ausente.');
  if(!texto)      throw new Error('texto da mensagem ausente.');

  const numero = normalizarNumeroBR(chatNumber);   // garante o 55 (senão o ChatGuru não entrega)
  console.log(`[chatguru-api] enviando para ${numero} (original: ${chatNumber}).`);

  const body = new URLSearchParams({
    action: 'message_send',
    text: texto,
    chat_number: numero,
    key,
    account_id: accountId,
    phone_id: phoneId,
  });

  const resp = await fetch(CHATGURU_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await resp.json().catch(() => ({}));

  // Sucesso do ChatGuru: result === 'success' (code 200/201).
  if(!resp.ok || (json.result && json.result !== 'success')){
    throw new Error((json && json.description) || ('ChatGuru HTTP ' + resp.status));
  }
  return json; // { code, result, message_id, message_status }
}

/* Grava/atualiza uma VARIÁVEL DE CONTEXTO do chat (action=chat_update_context).
   Usado pra marcar `MediaEnviada=Sim` após o envio automático da média, para que os
   diálogos de interesse (3.3/3.4) disparem também nos leads do formulário — sem mexer
   em nenhum diálogo. `variaveis` = { MediaEnviada:'Sim' } vira var__MediaEnviada=Sim. */
async function atualizarContexto({ chatNumber, variaveis }){
  const key       = process.env.CHATGURU_API_KEY || '';
  const accountId = process.env.CHATGURU_ACCOUNT_ID || '';
  const phoneId   = process.env.CHATGURU_PHONE_ID || '';
  if(!key || !accountId || !phoneId){
    throw new Error('Credenciais do ChatGuru não configuradas (CHATGURU_API_KEY/ACCOUNT_ID/PHONE_ID).');
  }
  if(!chatNumber) throw new Error('chat_number (telefone) ausente.');

  const numero = normalizarNumeroBR(chatNumber);
  const body = new URLSearchParams({
    action: 'chat_update_context',
    chat_number: numero,
    key,
    account_id: accountId,
    phone_id: phoneId,
  });
  for(const [nome, valor] of Object.entries(variaveis || {})){
    body.append('var__' + nome, String(valor));
  }

  const resp = await fetch(CHATGURU_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await resp.json().catch(() => ({}));
  if(!resp.ok || (json.result && json.result !== 'success')){
    throw new Error((json && json.description) || ('ChatGuru HTTP ' + resp.status));
  }
  return json;
}

/* Cria/registra um chat no ChatGuru (action=chat_add). Exige o módulo
   "Adicionar Chats" habilitado na conta. Usado no PRÉ-CADASTRO do lead do
   formulário: cria o chat ANTES da mensagem do WhatsApp chegar, pra o chat
   deixar de ser `!new_chat` e o Opener não disparar o intake por cima. */
async function criarChat({ chatNumber, nome, text }){
  const key       = process.env.CHATGURU_API_KEY || '';
  const accountId = process.env.CHATGURU_ACCOUNT_ID || '';
  const phoneId   = process.env.CHATGURU_PHONE_ID || '';
  if(!key || !accountId || !phoneId){
    throw new Error('Credenciais do ChatGuru não configuradas (CHATGURU_API_KEY/ACCOUNT_ID/PHONE_ID).');
  }
  if(!chatNumber) throw new Error('chat_number (telefone) ausente.');

  const numero = normalizarNumeroBR(chatNumber);
  const body = new URLSearchParams({
    action: 'chat_add',
    chat_number: numero,
    key,
    account_id: accountId,
    phone_id: phoneId,
    // esta conta EXIGE uma "mensagem inicial" (senão: "Mensagem inicial inválida").
    text: (text && String(text).trim()) || 'Novo orçamento recebido pelo site.',
  });
  if(nome) body.append('name', String(nome));

  const resp = await fetch(CHATGURU_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await resp.json().catch(() => ({}));
  // chat_add pode devolver "já existe" — tratamos como sucesso (o objetivo é o chat existir).
  const jaExiste = json && /exist|já|cadastrad/i.test(String(json.description || ''));
  if(!resp.ok || (json.result && json.result !== 'success' && !jaExiste)){
    throw new Error((json && json.description) || ('ChatGuru HTTP ' + resp.status));
  }
  return json;
}

/* Variante do número com/sem o 9º dígito (chats antigos do WhatsApp ficaram sem o
   9). Usada como 2ª tentativa quando o ChatGuru diz "Chat não encontrado". */
function variante9(tel){
  const d = String(tel || '').replace(/\D/g, '').replace(/^55/, '');
  if(d.length === 11 && d[2] === '9') return '55' + d.slice(0,2) + d.slice(3);   // tira o 9
  if(d.length === 10) return '55' + d.slice(0,2) + '9' + d.slice(2);             // põe o 9
  return null;
}

/* Adiciona uma ANOTAÇÃO interna no chat (action=note_add). Não é mensagem ao
   cliente — só fica registrada na conversa para o atendente ler. */
async function adicionarAnotacao({ chatNumber, texto }){
  const key       = process.env.CHATGURU_API_KEY || '';
  const accountId = process.env.CHATGURU_ACCOUNT_ID || '';
  const phoneId   = process.env.CHATGURU_PHONE_ID || '';
  if(!key || !accountId || !phoneId) throw new Error('Credenciais do ChatGuru não configuradas.');
  if(!chatNumber) throw new Error('chat_number (telefone) ausente.');
  if(!texto)      throw new Error('texto da anotação ausente.');
  const numeros = [normalizarNumeroBR(chatNumber)];
  const alt = variante9(chatNumber);
  if(alt && alt !== numeros[0]) numeros.push(alt);
  let ultimoErro = null;
  for(const numero of numeros){
    const body = new URLSearchParams({
      action: 'note_add', note_text: texto, text: texto,
      chat_number: numero, key, account_id: accountId, phone_id: phoneId,
    });
    const resp = await fetch(CHATGURU_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
    });
    const json = await resp.json().catch(() => ({}));
    if(resp.ok && (!json.result || json.result === 'success')){
      console.log(`[chatguru-api] anotação adicionada em ${numero}.`);
      return { ...json, _numero: numero };
    }
    ultimoErro = new Error((json && json.description) || ('ChatGuru HTTP ' + resp.status));
    if(!/encontrad|not found/i.test(ultimoErro.message)) throw ultimoErro;   // erro real: não insiste
    if(numeros.length > 1) console.log(`[chatguru-api] chat não encontrado em ${numero} — tentando variante.`);
  }
  throw ultimoErro;
}

/* Executa um DIÁLOGO do chatbot no chat (é o diálogo que muda status p/ AGUARDANDO
   e marca não lido — a API não faz isso direto). O nome exato da action não está
   na doc pública: tentamos as variantes conhecidas e logamos a que funcionar. */
async function executarDialogo({ chatNumber, dialogId }){
  const key       = process.env.CHATGURU_API_KEY || '';
  const accountId = process.env.CHATGURU_ACCOUNT_ID || '';
  const phoneId   = process.env.CHATGURU_PHONE_ID || '';
  if(!key || !accountId || !phoneId) throw new Error('Credenciais do ChatGuru não configuradas.');
  if(!chatNumber || !dialogId) throw new Error('chat_number e dialog_id são obrigatórios.');
  const numeros = [normalizarNumeroBR(chatNumber)];
  const alt = variante9(chatNumber);
  if(alt && alt !== numeros[0]) numeros.push(alt);
  const variantes = ['dialog_execute','execute_dialog','chat_dialog_execute','dialog_send'];
  const erros = {};
  for(const numero of numeros)
  for(const action of variantes){
    try{
      const body = new URLSearchParams({
        action, dialog_id: dialogId, chat_number: numero,
        key, account_id: accountId, phone_id: phoneId,
      });
      const resp = await fetch(CHATGURU_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
      });
      const json = await resp.json().catch(() => ({}));
      if(resp.ok && (!json.result || json.result === 'success')){
        console.log(`[chatguru-api] diálogo ${dialogId} executado em ${numero} (action=${action}).`);
        return { ...json, _action: action };
      }
      erros[action + '@' + numero] = (json && json.description) || ('HTTP ' + resp.status);
    }catch(e){ erros[action + '@' + numero] = e.message; }
  }
  throw new Error('Nenhuma variante de execução de diálogo funcionou: ' + JSON.stringify(erros));
}

module.exports = { enviarMensagem, atualizarContexto, criarChat, adicionarAnotacao, executarDialogo, normalizarNumeroBR, variante9 };
