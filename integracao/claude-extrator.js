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

const db = getFirestore();

const MODELO = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const LIMITE_VALOR_HUMANO = Number(process.env.LIMITE_VALOR_HUMANO || 500000);

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
  },
  required: [
    'nome','email','telefone','tipoCliente','veiculo','tipoVeiculo',
    'valorVeiculo','valorInformado','funciona','blindado','motoEletrica','leilao','carroMudanca',
    'origem','destino','observacao','decisao','motivo','precisaAjuste','motivoAjuste','orcarComo',
  ],
};

const SYSTEM = `Você é o assistente da OBS Transportes (transporte de veículos por cegonha).
Recebe o texto de um lead que chegou pelo WhatsApp (geralmente o formulário do
site "Solicitação de orçamento — OBS Transportes") e faz DUAS coisas:

1. EXTRAI os campos do lead a partir do texto.
2. DECIDE se o atendimento pode ser AUTOMÁTICO ou se deve ir para um HUMANO.

Normalização do valor do veículo:
- Interprete formatos variados: "80000", "R$ 50.000,00", "50 mil", "50.0000".
- Converta para número inteiro em reais (ex.: 50000).
- Se não houver valor, ou o valor for claramente impossível de interpretar,
  use 0 e valorInformado=false.

Envie para HUMANO (decisao="humano") SOMENTE quando QUALQUER uma for verdadeira:
- Valor do veículo ACIMA de R$ ${LIMITE_VALOR_HUMANO} (não informado NÃO conta aqui).
- Lead SEM valor do veículo informado.
- Qualquer coisa claramente fora do padrão / valor claramente errado.

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

A ideia dos casos com precisaAjuste=true: mandar a média pro cliente pra manter
o interesse; se ele topar, a equipe ajusta o orçamento com as especificações.
Nos demais casos automáticos, precisaAjuste=false, motivoAjuste="" e orcarComo="".

Sempre preencha "motivo" com uma frase curta explicando a decisão (ex.:
"Valor acima do limite", "Dentro do padrão", "Estimativa - leilão", "Moto elétrica").
Responda SOMENTE no formato estruturado pedido.`;

exports.processarLeadCompleto = onDocumentUpdated(
  {
    document: 'crm_leads_intake/{telefone}',
    region: 'southamerica-east1',
    secrets: ['ANTHROPIC_API_KEY'],
  },
  async (event) => {
    const depois = event.data && event.data.after && event.data.after.data();
    if (!depois) return;

    // Só age quando o lead ACABOU de ser marcado como completo e ainda não
    // passou pela IA. O guard `iaProcessado` evita re-disparo em loop (porque
    // esta função também grava no mesmo documento).
    if (depois.statusIntake !== 'completo') return;
    if (depois.iaProcessado) return;

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
