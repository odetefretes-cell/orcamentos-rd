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

  const body = new URLSearchParams({
    action: 'message_send',
    text: texto,
    chat_number: chatNumber,
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

module.exports = { enviarMensagem };
