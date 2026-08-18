/* ============================================================================
   OBS Transportes — ETAPA 4: o Claude lê o lead e DECIDE

   Quando um lead fica COMPLETO (statusIntake === 'completo', gravado pela
   função agendada da Etapa 3), esta função dispara automaticamente:

     1. pega o texto acumulado (mensagemCompleta) — o formulário do cliente;
     2. chama a API do Claude pra EXTRAIR os campos (nome, veículo, valor,
        origem, destino, funciona, blindado…) e normalizar o valor;
     3. DECIDE se é caso de atendimento AUTOMÁTICO ou HUMANO, pelas suas regras;
     4. grava o resultado de volta no próprio documento do lead.

   AINDA NÃO faz: calcular orçamento nem responder pelo ChatGuru (Etapas 5/6).
   Aqui a gente só extrai e decide, gravando no crm_leads_intake (sem tocar no
   CRM `crm_leads` que a equipe usa). Assim dá pra validar a decisão do Claude
   com calma antes de deixar ele responder cliente de verdade.

   ----------------------------------------------------------------------------
   Segredos/variáveis:
     ANTHROPIC_API_KEY   → chave da API da Anthropic (segredo do Firebase)
     ANTHROPIC_MODEL     → modelo a usar (padrão: claude-opus-5).
                           Pra economizar, pode setar claude-haiku-4-5.
     LIMITE_VALOR_HUMANO → acima disso, vai pra humano (padrão: 500000)
   ============================================================================ */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const Anthropic = require('@anthropic-ai/sdk');
const { enviarMensagem, atualizarContexto } = require('./chatguru-api');   // Fase C: perguntar dados que faltam + reativar encaminhador

const db = getFirestore();

const MODELO = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const LIMITE_VALOR_HUMANO = Number(process.env.LIMITE_VALOR_HUMANO || 500000);
const MAX_PERGUNTAS = Number(process.env.MAX_PERGUNTAS || 2);   // quantas vezes pergunta antes de mandar p/ humano

/* Chave liga/desliga do envio real (crm_config/config.envioAtivo). Mesma regra da
   orcamento-resposta: aceita true, "true", 1. Sem isso ligado, não perguntamos nada. */
async function envioEstaAtivo(){
  try {
    const USAR_PG = process.env.OBS_USAR_PG === 'true' || process.env.OBS_USAR_PG === '1';
    const bd = USAR_PG ? require('./pg-api').pgDb : db;
    const snap = await bd.collection('crm_config').doc('config').get();
    const v = snap.exists ? snap.data().envioAtivo : undefined;
    return v === true || v === 'true' || v === 1 || v === '1';
  } catch(_){ return false; }
}

/* Formato exato do que o Claude deve devolver (structured output).
   Todos os campos são obrigatórios; use "" ou 0 quando não houver informação. */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    nome:          { type: 'string',  description: 'Nome do cliente' },
    email:         { type: 'string',  description: 'E-mail, se houver' },
    telefone:      { type: 'string',  description: 'Telefone informado no texto' },
    tipoCliente:   { type: 'string',  description: 'Pessoa Física, Empresa, etc.' },
    veiculo:       { type: 'string',  description: 'Modelo do veículo' },
    tipoVeiculo:   { type: 'string',  description: 'Carro passeio, moto, etc.' },
    valorVeiculo:  { type: 'number',  description: 'Valor do veículo em reais, normalizado para número inteiro (ex.: "R$ 50.000,00" -> 50000; "50 mil" -> 50000; "50.0000" -> 50000). 0 se não informado ou impossível interpretar.' },
    valorInformado:{ type: 'boolean', description: 'true se o cliente informou um valor interpretável; false se faltou ou está claramente errado' },
    funciona:      { type: 'boolean', description: 'true se o veículo funciona/liga' },
    blindado:      { type: 'boolean', description: 'true se blindado' },
    motoEletrica:  { type: 'boolean', description: 'true se for moto elétrica' },
    leilao:        { type: 'boolean', description: 'true se for veículo de leilão (leiloeira/pátio de leilão no e-mail ou observação)' },
    carroMudanca:  { type: 'boolean', description: 'true se for carro + mudança (bagagem / itens junto com o veículo)' },
    origem:        { type: 'string',  description: 'Origem (cidade UF)' },
    destino:       { type: 'string',  description: 'Destino (cidade UF)' },
    observacao:    { type: 'string',  description: 'Observações extras do cliente' },
    decisao:       { type: 'string',  enum: ['automatico', 'humano'], description: 'Encaminhamento' },
    motivo:        { type: 'string',  description: 'Motivo curto da decisão (obrigatório quando humano)' },
    precisaAjuste: { type: 'boolean', description: 'true quando a média é só uma estimativa que precisará ser ajustada depois (veículo não funciona ou leilão)' },
    motivoAjuste:  { type: 'string',  description: 'Motivo curto do ajuste, quando precisaAjuste=true (ex.: "veículo não funciona", "leilão"). Vazio caso contrário.' },
    orcarComo:     { type: 'string',  description: 'Categoria a usar no cálculo quando diferente do padrão. Para MOTO ELÉTRICA, use "moto 300cc". Caso contrário, vazio (usa o próprio veículo/tipo).' },
    faltaInfo:     { type: 'boolean', description: 'true se faltam dados ESSENCIAIS para cotar: ORIGEM, DESTINO, VEÍCULO ou VALOR do veículo. Para leads do formulário do site (vêm completos), normalmente false.' },
    faltamCampos:  { type: 'array',   items: { type: 'string' }, description: 'Lista dos campos essenciais que faltam (ex.: ["origem","destino","veículo","valor do veículo"]). Vazio se não faltar nada.' },
    perguntaCliente:{ type: 'string', description: 'Quando faltaInfo=true, uma pergunta curta e cordial (pt-BR) pedindo ao cliente EXATAMENTE os dados que faltam para o orçamento. Vazio caso contrário.' },
    pediuAtendente: { type: 'boolean', description: 'true SOMENTE quando o cliente pede explicitamente para falar com um ATENDENTE/PESSOA/HUMANO (ex.: "falar com atendente", "quero falar com alguém", "me liga"). Nesse caso, decisao="humano" e faltaInfo=false (não perguntar nada). false caso contrário.' },
  },
  required: [
    'nome','email','telefone','tipoCliente','veiculo','tipoVeiculo',
    'valorVeiculo','valorInformado','funciona','blindado','motoEletrica','leilao','carroMudanca',
    'origem','destino','observacao','decisao','motivo','precisaAjuste','motivoAjuste','orcarComo',
    'faltaInfo','faltamCampos','perguntaCliente','pediuAtendente',
  ],
};

const SYSTEM = `Você é o assistente da OBS Transportes (transporte de veículos por cegonha).
Recebe o texto de um lead que chegou pelo WhatsApp (geralmente o formulário do
site "Solicitação de orçamento — OBS Transportes") e faz DUAS coisas:

1. EXTRAI os campos do lead a partir do texto.
2. DECIDE se o atendimento pode ser AUTOMÁTICO ou se deve ir para um HUMANO.

Normalização do valor do veículo:
- Interprete formatos variados: "80000", "R$ 50.000,00", "50 mil", "50.0000".
- Sufixos: "k" e "mil" = milhares → "419k" = 419000, "50k" = 50000, "419 mil" = 419000.
- FIPE: "Fipe 419k", "Fipe R$ 419.000", "vale 419 mil na fipe" → use o valor FIPE
  como valor do veículo (ex.: 419000). FIPE é o preço de referência do veículo.
- Converta para número inteiro em reais (ex.: 50000).
- Se não houver valor, ou o valor for claramente impossível de interpretar,
  use 0 e valorInformado=false.

PRIORIDADE conversa × campos: se os dados vierem de CAMPOS PERSONALIZADOS do
ChatGuru (linhas "Rótulo: valor") e eles CONFLITAREM com o que o cliente escreveu
na CONVERSA (ex.: modelo/origem/destino diferentes), PREFIRA sempre a CONVERSA —
os campos personalizados podem estar DESATUALIZADOS de um orçamento anterior.

Envie para HUMANO (decisao="humano") SOMENTE quando QUALQUER uma for verdadeira:
- Valor do veículo ACIMA de R$ ${LIMITE_VALOR_HUMANO} (não informado NÃO conta aqui).
- Qualquer coisa claramente fora do padrão / valor claramente errado.
- CLIENTE PEDIU ATENDENTE/HUMANO: o cliente pede explicitamente para falar com uma
  PESSOA (ex.: "falar com atendente", "quero falar com alguém", "atendimento humano",
  "chama um vendedor", "me liga", "quero falar com um humano"). Neste caso, ALÉM de
  decisao="humano", defina TAMBÉM faltaInfo=false e pediuAtendente=true — NÃO faça
  nenhuma pergunta (ele quer uma pessoa, não o robô). motivo="cliente pediu atendente".

Em todos os outros casos, decisao="automatico".

Casos especiais que continuam AUTOMÁTICOS (mandam a média), com marcação:
- MOTO ELÉTRICA → decisao="automatico", orcarComo="moto 300cc" (orça como uma
  moto 300cc). precisaAjuste=false, motivoAjuste="".
- LEILÃO → decisao="automatico", precisaAjuste=true, motivoAjuste="leilão".
- Veículo que NÃO funciona / não liga → decisao="automatico", precisaAjuste=true,
  motivoAjuste="veículo não funciona".
- CARRO + MUDANÇA → decisao="automatico", precisaAjuste=true,
  motivoAjuste="carro + mudança" (manda a média do VEÍCULO; a mudança/bagagem é
  ajustada à parte pela equipe).
- VEÍCULO BLINDADO → decisao="automatico", precisaAjuste=true,
  motivoAjuste="veículo blindado" (manda a média normal; o acréscimo do blindado,
  se houver, a equipe ajusta depois). NÃO vai pra humano só por ser blindado.
- SEM VALOR do veículo informado, MAS com ORIGEM + DESTINO + VEÍCULO presentes →
  decisao="automatico", precisaAjuste=true, motivoAjuste="valor do veículo a
  confirmar" (valorVeiculo=0, valorInformado=false). MANDA a média do frete assim
  mesmo; o seguro (pequeno) é ajustado quando o cliente confirmar o valor. NÃO
  pergunte o valor — mande a média (o cliente já tem um número pra decidir).

A ideia dos casos com precisaAjuste=true: mandar a média pro cliente pra manter
o interesse; se ele topar, a equipe ajusta o orçamento com as especificações.
Nos demais casos automáticos, precisaAjuste=false, motivoAjuste="" e orcarComo="".

CONTATOS DIRETOS (sem formulário) — coletar o que falta:
Às vezes o texto NÃO é o formulário completo, e sim uma conversa de WhatsApp em que
o cliente chamou direto e deu informações PARCIAIS. Nesses casos:
- ESSENCIAL para cotar = ORIGEM, DESTINO e VEÍCULO. O VALOR do veículo NÃO é
  essencial (mandamos a média sem ele — ver o caso "SEM VALOR" acima).
- Se faltar ORIGEM, DESTINO ou VEÍCULO — defina faltaInfo=true, liste em
  faltamCampos o que falta, e escreva em perguntaCliente uma pergunta curta e
  cordial pedindo EXATAMENTE esses dados. Ex.:
  "Oi! Para preparar seu orçamento, me confirma por favor: 📍 a cidade de origem e
  destino e 🚗 o modelo do veículo? 😊"
- Peça só o que falta (não repita o que o cliente já informou). NÃO peça o valor.
- Quando ORIGEM, DESTINO e VEÍCULO estiverem presentes, faltaInfo=false (mesmo sem
  o valor — cota como estimativa).
- Para leads do formulário do site (todos os campos preenchidos), faltaInfo=false.
Importante: quando faltaInfo=true, ainda preencha "decisao" normalmente (será usada
só se não der pra perguntar). A extração dos campos que EXISTEM deve ser feita mesmo
com faltaInfo=true (aproveita o que o cliente já disse).

Sempre preencha "motivo" com uma frase curta explicando a decisão (ex.:
"Valor acima do limite", "Dentro do padrão", "Estimativa - leilão", "Moto elétrica").
Responda SOMENTE no formato estruturado pedido.`;

// Chat com HUMANO atendendo no ChatGuru? (responsável assinalado e não é "Ninguém
// Delegado"). Se sim, o robô NÃO deve perguntar dado nem cotar — o atendente cuida.
function temAtendenteHumano(nome){
  const n = String(nome || '').trim().toLowerCase();
  if(!n) return false;
  if(/ningu[eé]m|delegado|sem\s+respons/.test(n)) return false;   // "Ninguém Delegado" etc.
  return true;
}

exports.processarLeadCompleto = onDocumentUpdated(
  {
    document: 'crm_leads_intake/{telefone}',
    region: 'southamerica-east1',
    secrets: ['ANTHROPIC_API_KEY', 'CHATGURU_API_KEY', 'CHATGURU_ACCOUNT_ID', 'CHATGURU_PHONE_ID', 'OBS_API_TOKEN'],
  },
  async (event) => {
    const depois = event.data && event.data.after && event.data.after.data();
    if (!depois) return;

    // Só age quando o lead ACABOU de ser marcado como completo e ainda não
    // passou pela IA. O guard `iaProcessado` evita re-disparo em loop (porque
    // esta função também grava no mesmo documento).
    if (depois.statusIntake !== 'completo') return;
    if (depois.iaProcessado) return;

    // ⚠️ Chat JÁ EM ATENDIMENTO (humano assinalado como responsável no ChatGuru): NÃO
    // pergunta dado que falta (Fase C) NEM cota. O encaminhador (relaxado p/ pegar
    // contato espontâneo) repassa até conversa em atendimento; sem isto, o robô
    // perguntava "me confirma origem/destino/veículo" por cima do atendente (Brendon,
    // Ruy, Rodrigo...). Contato novo entra "Ninguém Delegado" → responsável vazio → segue.
    if (temAtendenteHumano(depois.responsavelChatguru)) {
      await event.data.after.ref.update({
        iaProcessado: true,
        statusIntake: 'em_atendimento_humano',
        iaProcessadoEm: FieldValue.serverTimestamp(),
        motivoPulo: 'chat em atendimento humano (' + String(depois.responsavelChatguru).trim() + ')',
      });
      console.log(`[processarLeadCompleto] ${event.params.telefone}: chat EM ATENDIMENTO (responsável ${depois.responsavelChatguru}) — pula (não pergunta nem cota).`);
      return;
    }

    const telefone = event.params.telefone;
    const texto = (depois.mensagemCompleta || '').trim()
      || (depois.mensagens || []).map(m => (m && m.texto) || '').join('\n').trim();

    const ref = event.data.after.ref;

    if (!texto) {
      console.warn(`[processarLeadCompleto] Lead ${telefone} sem texto — vai pra humano.`);
      await ref.update({
        iaProcessado: true,
        statusIntake: 'aguardando_humano',
        iaErro: 'sem_texto',
        iaProcessadoEm: FieldValue.serverTimestamp(),
      });
      return;
    }

    try {
      const client = new Anthropic(); // usa ANTHROPIC_API_KEY do ambiente/segredo

      const params = {
        model: MODELO,
        max_tokens: 4000,
        system: SYSTEM,
        messages: [{ role: 'user', content: texto }],
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      };
      // "effort" reduz o custo, mas não existe no Haiku (dá erro 400 lá).
      if (!/haiku/.test(MODELO)) params.output_config.effort = 'low';

      const resp = await client.messages.create(params);

      // O Claude pode recusar por segurança — nesse caso mandamos pra humano.
      if (resp.stop_reason === 'refusal') {
        console.warn(`[processarLeadCompleto] Lead ${telefone}: recusa da IA.`);
        await ref.update({
          iaProcessado: true,
          statusIntake: 'aguardando_humano',
          iaErro: 'recusa_ia',
          iaProcessadoEm: FieldValue.serverTimestamp(),
        });
        return;
      }

      const bloco = (resp.content || []).find(b => b.type === 'text');
      const dados = JSON.parse(bloco.text);

      // ---- Fase C: faltam dados essenciais? Pergunta ao cliente (até MAX_PERGUNTAS) ----
      const perguntasFeitas = Number(depois.perguntasFeitas || 0);
      if (dados.faltaInfo && (dados.perguntaCliente || '').trim() && perguntasFeitas < MAX_PERGUNTAS) {
        if (await envioEstaAtivo()) {
          try {
            await enviarMensagem({ chatNumber: telefone, texto: dados.perguntaCliente });
            // REATIVA O ENCAMINHADOR: garante que a resposta do cliente chegue ao
            // backend. O botão "Gerar Orçamento" grava MediaEnviada=Sim (que BLOQUEIA
            // o encaminhador); como aqui a média NÃO saiu (estamos perguntando), a
            // gente liga Cotando=Sim e limpa MediaEnviada pra captar a resposta.
            try {
              await atualizarContexto({ chatNumber: telefone, variaveis: { Cotando: 'Sim', MediaEnviada: 'Nao' } });
            } catch (errCtx) {
              console.warn(`[processarLeadCompleto] Lead ${telefone}: falhou reativar encaminhador (Cotando/MediaEnviada):`, (errCtx && errCtx.message) || errCtx);
            }
            await ref.update({
              extraido: dados,
              statusIntake: 'faltando_dados',
              faltamCampos: dados.faltamCampos || [],
              perguntaCliente: dados.perguntaCliente,
              perguntasFeitas: perguntasFeitas + 1,
              ultimaPerguntaEm: FieldValue.serverTimestamp(),
              // NÃO seta iaProcessado: a próxima resposta do cliente reabre e reprocessa.
            });
            console.log(`[processarLeadCompleto] Lead ${telefone}: faltam [${(dados.faltamCampos||[]).join(', ')}] — perguntei ao cliente (${perguntasFeitas + 1}/${MAX_PERGUNTAS}).`);
            return;
          } catch (err) {
            console.error(`[processarLeadCompleto] Lead ${telefone}: erro ao perguntar dados:`, err);
            // cai para a decisão normal abaixo (não perde o lead)
          }
        } else {
          // envio desligado: não dá pra perguntar → manda pra humano pra não perder.
          await ref.update({
            iaProcessado: true, extraido: dados, statusIntake: 'aguardando_humano',
            iaErro: 'faltam_dados_envio_desligado', iaProcessadoEm: FieldValue.serverTimestamp(),
          });
          console.log(`[processarLeadCompleto] Lead ${telefone}: faltam dados, mas envio DESLIGADO → humano.`);
          return;
        }
      }

      const novoStatus = dados.decisao === 'humano' ? 'aguardando_humano' : 'automatico';

      await ref.update({
        iaProcessado: true,
        iaModelo: MODELO,
        iaProcessadoEm: FieldValue.serverTimestamp(),
        extraido: dados,
        statusIntake: novoStatus,
      });

      console.log(
        `[processarLeadCompleto] Lead ${telefone} -> ${novoStatus.toUpperCase()} ` +
        `(${dados.decisao}${dados.motivo ? ': ' + dados.motivo : ''}). ` +
        `Veículo: ${dados.veiculo || '?'} | Valor: ${dados.valorVeiculo}.`
      );
    } catch (e) {
      // Qualquer falha na IA: por segurança, manda pra humano (não perde o lead).
      console.error(`[processarLeadCompleto] Lead ${telefone} ERRO:`, e);
      await ref.update({
        iaProcessado: true,
        statusIntake: 'aguardando_humano',
        iaErro: String((e && e.message) || e),
        iaProcessadoEm: FieldValue.serverTimestamp(),
      });
    }
  }
);
