/* ============================================================================
   OBS Transportes — ETAPA 5 (Fase A): calcular a média (reaproveitando o
   sistema) e PREPARAR a resposta — ainda SEM enviar pro cliente.

   Fluxo:
     1. Quando um lead do intake vira 'automatico' (Etapa 4), criamos o lead na
        coleção `crm_leads` (a que o app já usa). Como o app calcula sozinho os
        leads de origemLead 'whatsapp' (crmAutoCalcSite), a MÉDIA sai pela MESMA
        tabela que a equipe confia — sem reimplementar nada no backend.
     2. Quando a média (valorEstimado) aparecer nesse lead, PREPARAMOS a mensagem
        de resposta e guardamos em `respostaPreparada` (RASCUNHO). NÃO enviamos.

   O envio de verdade (pelo ChatGuru) fica pra depois — só depois de você validar
   os rascunhos. Assim a gente não corre o risco de mandar preço errado.

   ⚠️ Fase A depende do app aberto no navegador do admin pra calcular (é assim que
   o app funciona hoje). A Fase B vai portar o cálculo pro backend, pra rodar 24h.
   ============================================================================ */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { enviarMensagem, atualizarContexto } = require('./chatguru-api');
const { calcularFrete } = require('./calc-fretes');   // Fase B: cálculo da média no backend (24h)
const { pgDb, proximoVendedorPG, listar, claim } = require('./pg-api');

const db = getFirestore();

// CHAVE DA VIRADA: com OBS_USAR_PG ligada, os LEADS e o rodízio vão pro PostgreSQL
// (servidor próprio) e o envio passa pelo verificador `enviarPendentesPG`. Desligada
// (padrão), tudo funciona exatamente como hoje (Firestore + gatilho prepararResposta).
const USAR_PG = process.env.OBS_USAR_PG === 'true' || process.env.OBS_USAR_PG === '1';
// Onde os LEADS moram (o intake continua sempre no Firestore).
const dbLead = USAR_PG ? pgDb : db;
// Carimbo de data/hora: sentinela do Firestore OU string ISO (PostgreSQL).
const tsLead = () => USAR_PG ? new Date().toISOString() : FieldValue.serverTimestamp();

/* Normaliza o nome do vendedor pros 3 nomes canônicos do CRM (igual crmNomeCanon
   no index.html), pra o responsável bater no ChatGuru e no CRM. */
function canonVendedor(nome){
  const n = (nome || '').trim();
  const nn = n.toLowerCase();
  if(/yasm/.test(nn)) return 'Yasmim Freitas';
  if(/thiago|tiago/.test(nn)) return 'Thiago Lucca';
  if(/flavia|flávia|otatti|ottati/.test(nn)) return 'Flavia Ottati';
  return n;
}

/* Vendedores no rodízio (ajustável via env VENDEDORES, separados por vírgula). */
const VENDEDORES = (process.env.VENDEDORES || 'Yasmim Freitas,Thiago Lucca,Flavia Ottati')
  .split(',').map(s => s.trim()).filter(Boolean);

/* Próximo vendedor do rodízio — contador guardado em crm_config/rodizio.
   Como todos os leads entram sem responsável no ChatGuru, é o backend que
   distribui de forma justa e alternada entre os vendedores. */
async function proximoVendedor(){
  if(!VENDEDORES.length) return '';
  // PostgreSQL: rodízio ATÔMICO no servidor (endpoint /api/rodizio/next).
  if(USAR_PG) return await proximoVendedorPG(VENDEDORES);
  const ref = db.collection('crm_config').doc('rodizio');
  let escolhido = VENDEDORES[0];
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const n = (snap.exists && Number(snap.data().contador)) || 0;
    escolhido = VENDEDORES[n % VENDEDORES.length];
    tx.set(ref, {
      contador: n + 1,
      ultimo: escolhido,
      atualizadoEm: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return escolhido;
}

/* Decide a categoria que o app entende (crmCategoriaSugerida), respeitando o
   "Tipo de veículo" do formulário e a regra da moto elétrica (orcarComo).
   Retorna '' quando não dá pra decidir (aí o app adivinha pela descrição). */
function categoriaDeVeiculo(tipoVeiculo, orcarComo){
  // 1) Regra especial da Etapa 4 (moto elétrica → 300cc) tem prioridade.
  const o = (orcarComo || '').toLowerCase();
  if(/moto/.test(o) && /300/.test(o)) return 'Moto até 300cc';
  if(/moto/.test(o) && /700/.test(o)) return 'Moto até 700cc';

  // 2) Senão, usa o "Tipo de veículo" informado no formulário.
  const t = (tipoVeiculo || '').toLowerCase();
  if(/moto/.test(t)){
    if(/700/.test(t) && /(acima|maior)/.test(t)) return 'Moto acima de 700cc';
    if(/700/.test(t)) return 'Moto até 700cc';
    return 'Moto até 300cc';
  }
  if(/(grande|suv|caminhon|pickup|picape|utilit|\bvan\b)/.test(t)) return 'Carro grande';
  if(/(carro|passeio|sedan|hatch|autom|pequen)/.test(t)) return 'Carro passeio';
  return '';
}

const TELEFONE_OBS = process.env.TELEFONE_OBS || '(11) 4352-4103';
const LIMITE_VALOR_HUMANO = Number(process.env.LIMITE_VALOR_HUMANO || 500000);   // acima disso: mensagem personalizada

function formatarBRL(v){
  const n = Number(v);
  if(!isFinite(n) || n <= 0) return null;
  try { return n.toLocaleString('pt-BR', { style:'currency', currency:'BRL' }); }
  catch(_) { return 'R$ ' + n.toFixed(2); }
}

/* Horário de atendimento (fuso America/Sao_Paulo), igual aos gatilhos 3.3/3.4
   do ChatGuru: Seg–Sex 09:00–18:00 · Sáb 08:00–12:00 · Dom fechado. */
function dentroDoExpedienteBR(){
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const val = (t) => (partes.find(p => p.type === t) || {}).value;
  const dia = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 }[val('weekday')];
  let hh = Number(val('hour')); if(hh === 24) hh = 0;   // meia-noite às vezes vem '24'
  const mins = hh * 60 + Number(val('minute'));
  if(dia >= 1 && dia <= 5) return mins >= 540 && mins < 1080; // 09:00–18:00
  if(dia === 6)            return mins >= 480 && mins < 720;  // 08:00–12:00
  return false; // domingo
}

const AVISO_FORA_EXPEDIENTE =
  '🕐 Estamos fora do horário de atendimento no momento (seg a sex das 9h às 18h, ' +
  'e sáb das 8h às 12h). Sua solicitação já está registrada — assim que retornarmos, ' +
  'damos sequência por aqui. 😉';

/* Devolve o aviso (já com as quebras de linha) quando FORA do expediente; senão ''. */
function sufixoForaExpediente(){
  return dentroDoExpedienteBR() ? '' : ('\n\n' + AVISO_FORA_EXPEDIENTE);
}

/* Monta o texto da resposta (modelo oficial da OBS). */
function montarMensagem(lead){
  const e = lead.extraidoIA || {};
  const nome = (e.nome || lead.nome || '').trim();
  const veic = e.veiculo || lead.veiculoDesc || '';
  const origem = e.origem || lead.origem || '';
  const destino = e.destino || lead.destino || '';
  const media = formatarBRL(lead.valorEstimado);
  const prazo = lead.prazoSW || lead.prazo || '';

  const linhas = [];
  linhas.push('🚚 OBS TRANSPORTES');
  linhas.push('');
  linhas.push(`Olá${nome ? ' ' + nome : ''}! 😊`);
  linhas.push('');
  linhas.push('Segue uma estimativa média para o seu transporte:');
  linhas.push('');
  if(veic)             linhas.push(`📦 Veículo: ${veic}`);
  if(origem && destino) linhas.push(`📍 ${origem} → ${destino}`);
  linhas.push(`💰 Valor médio: ${media}`);
  if(prazo)            linhas.push(`📅 Prazo estimado: ${prazo} dias após o embarque`);
  linhas.push('');
  linhas.push('Valor pode sofrer alterações (descontos ou acréscimos).');
  linhas.push('');
  linhas.push('Esse é um valor médio de referência. Se tiver interesse, responda SIM que preparamos o orçamento oficial com todos os detalhes; se não, responda NÃO.');
  linhas.push('');
  linhas.push('🛰️ Transporte monitorado por link de rastreio, com atualização diária.');
  linhas.push('🏆 OBS Transportes — 20 anos de história no transporte de veículos.');
  linhas.push(`📞 ${TELEFONE_OBS}`);
  return linhas.join('\n');
}

/* Mensagem para quando NÃO há rota automática: avisa que um atendente humano
   vai preparar o orçamento (assim o cliente não fica sem resposta). */
function montarMensagemHumano(lead){
  const e = lead.extraidoIA || {};
  const nome = (e.nome || lead.nome || '').trim();
  const veic = e.veiculo || lead.veiculoDesc || '';
  const origem = e.origem || lead.origem || '';
  const destino = e.destino || lead.destino || '';
  const linhas = [];
  linhas.push('🚚 OBS TRANSPORTES');
  linhas.push('');
  linhas.push(`Olá${nome ? ' ' + nome : ''}! 😊`);
  linhas.push('');
  linhas.push('Recebemos a sua solicitação de transporte' + (veic ? ` do seu ${veic}` : '') + (origem && destino ? ` (${origem} → ${destino})` : '') + '.');
  linhas.push('');
  linhas.push('Um de nossos atendentes vai preparar o seu orçamento e retornar por aqui em instantes. 📋');
  linhas.push('');
  linhas.push('🏆 OBS Transportes — 20 anos no transporte de veículos.');
  linhas.push(`📞 ${TELEFONE_OBS}`);
  return linhas.join('\n');
}

/* Mensagem PERSONALIZADA para veículo de ALTO VALOR (acima do limite): reforça o
   cuidado especial e o seguro adequado, e que um especialista prepara o orçamento. */
function montarMensagemValorAlto(lead){
  const e = lead.extraidoIA || {};
  const nome = (e.nome || lead.nome || '').trim();
  const veic = e.veiculo || lead.veiculoDesc || '';
  const linhas = [];
  linhas.push('🚚 OBS TRANSPORTES');
  linhas.push('');
  linhas.push(`Olá${nome ? ' ' + nome : ''}! 😊`);
  linhas.push('');
  linhas.push(`Recebemos a sua solicitação para o transporte${veic ? ' do seu ' + veic : ''}.`);
  linhas.push('');
  linhas.push('Por se tratar de um veículo de alto valor, um de nossos especialistas vai preparar um orçamento personalizado, com a cobertura de seguro adequada e todo o cuidado que ele merece. 🛡️');
  linhas.push('');
  linhas.push('Retornamos por aqui em instantes com todos os detalhes.');
  linhas.push('');
  linhas.push('🏆 OBS Transportes — 20 anos no transporte de veículos.');
  linhas.push(`📞 ${TELEFONE_OBS}`);
  return linhas.join('\n');
}

/* ---- ETAPA 5A.1: intake 'automatico' → cria o lead no CRM (app calcula) ---- */
exports.criarLeadNoCrm = onDocumentUpdated(
  { document: 'crm_leads_intake/{telefone}', region: 'southamerica-east1', secrets: ['OBS_API_TOKEN'] },
  async (event) => {
    const d = event.data && event.data.after && event.data.after.data();
    if(!d) return;
    // Trata os dois desfechos da IA: 'automatico' (responde) e 'aguardando_humano'
    // (aparece no CRM p/ a equipe assumir, SEM responder o cliente).
    if(d.statusIntake !== 'automatico' && d.statusIntake !== 'aguardando_humano') return;
    if(d.leadCriado) return;                     // já criado (evita repetir)

    // ⚠️ TRAVA ATÔMICA ANTI-DUPLICAÇÃO (reivindica o ciclo ANTES do trabalho lento).
    // Dois updates rápidos do intake — ou duas execuções concorrentes da IA que setam
    // 'aguardando_humano'/'automatico' quase juntas — disparavam esta função em
    // PARALELO. Cada invocação recriava o lead e ZERAVA avisoHumanoEnviado/
    // respostaEnviada, então prepararResposta enviava a MESMA mensagem várias vezes ao
    // cliente (bug real: FIESTA/BIZ receberam 4x no mesmo minuto). O guard `leadCriado`
    // acima só era gravado no FIM (depois do cálculo), tarde demais. Aqui marcamos
    // `leadCriado` numa transação logo no início: só a PRIMEIRA invocação prossegue;
    // as concorrentes param aqui. (Cliente que volta a cotar reabre o ciclo pelo
    // webhook — branch A/B zera `leadCriado` — então isto não trava recotação legítima.)
    const intakeRef = event.data.after.ref;
    const donoDoCiclo = await db.runTransaction(async (tx) => {
      const s = await tx.get(intakeRef);
      const cur = s.exists ? (s.data() || {}) : {};
      if(cur.leadCriado) return false;
      if(cur.statusIntake !== 'automatico' && cur.statusIntake !== 'aguardando_humano') return false;
      tx.update(intakeRef, { leadCriado: true, leadCriadoEm: FieldValue.serverTimestamp() });
      return true;
    });
    if(!donoDoCiclo){
      console.log(`[criarLeadNoCrm] ${event.params.telefone}: ciclo já assumido por outra invocação — ignora (anti-duplicação).`);
      return;
    }

    const paraHumano = d.statusIntake === 'aguardando_humano';
    const telefone = event.params.telefone;
    const e = d.extraido || {};

    const categoria = categoriaDeVeiculo(e.tipoVeiculo, e.orcarComo);

    // CHAVE do lead = últimos 8 dígitos do telefone — A MESMA usada pelo formulário
    // do site (obs-cotacao.js). Assim o lead do site e a atualização do ChatGuru caem
    // no MESMO documento (sem DUPLICAR) e ainda ignora +55/DDD/9º dígito/formatação.
    const chave = String(telefone).replace(/\D/g,'').slice(-8) || String(telefone);
    const leadId = 'lead_wpp_' + chave;
    const ref = dbLead.collection('crm_leads').doc(leadId);   // PostgreSQL ou Firestore (o intake segue no Firestore)

    // ⚠️ TRAVA (não criar/recotar/mensagear por cima de quem já está sendo atendido).
    // O encaminhador (relaxado p/ pegar contato espontâneo) repassa QUALQUER conversa
    // ativa do cliente — inclusive de quem JÁ está EM ATENDIMENTO. Dois sinais barram:
    //  (a) HUMANO atendendo no ChatGuru: o chat tem RESPONSÁVEL assinalado (ex.: Yasmim
    //      de Sá). Este é o sinal FORTE — pega mesmo quando o lead antigo tem OUTRO id
    //      (chave antiga/duplicado) e a busca por id não encontra (caso Ruy-1549).
    //  (b) lead já existe e saiu da coluna "novo" (a equipe assumiu) — caso INGRID-1523.
    // Lead novo de verdade entra "Ninguém Delegado" (sem responsável) e na coluna novo →
    // segue o fluxo automático normal.
    const humanoNoChat = !!canonVendedor(d.responsavelChatguru);
    let emAndamento = false, etapaAtual = '';
    const jaSnap = await ref.get();
    if(jaSnap.exists){
      etapaAtual = String(jaSnap.data().etapa || '').trim();
      emAndamento = !!(etapaAtual && etapaAtual !== 'novo');
    }
    if(humanoNoChat || emAndamento){
      const motivo = humanoNoChat ? `humano atendendo no ChatGuru: ${d.responsavelChatguru}` : `lead em andamento (etapa=${etapaAtual})`;
      console.log(`[criarLeadNoCrm] ${leadId} — NÃO cria/recota/envia (${motivo}).`);
      await event.data.after.ref.update({ leadId, emAtendimentoIgnorado: true, emAtendimentoEm: FieldValue.serverTimestamp() });
      return;
    }

    // Responsável: se o ChatGuru já tiver um, respeita; senão (o normal, pois
    // todos entram "sem responsável"), o backend distribui por rodízio.
    let vendedor = canonVendedor(d.responsavelChatguru);
    if(!vendedor) vendedor = await proximoVendedor();

    await dbLead.runTransaction(async (tx) => {
      const snap = await tx.get(ref);

      // Campos de dados — nunca sobrescrevem trajetos/etapa/vendedor já existentes.
      const dados = {
        id: leadId,
        nome: e.nome || d.nome || '',
        telefone: d.telefoneOriginal || telefone,
        email: e.email || d.email || '',
        veiculoDesc: e.veiculo || '',
        origem: e.origem || '',
        destino: e.destino || '',
        valorVeiculo: e.valorVeiculo != null ? String(e.valorVeiculo) : '',
        funciona: e.funciona ? 'SIM' : 'NÃO',
        blindado: e.blindado ? 'SIM' : 'NÃO',
        origemLead: 'whatsapp',       // faz o app (crmAutoCalcSite) calcular sozinho
        // metadados da automação (o app ignora campos que não conhece):
        extraidoIA: e,
        responsavelEmailChatguru: d.responsavelEmailChatguru || '',
        precisaAjuste: !!e.precisaAjuste,
        motivoAjuste: e.motivoAjuste || '',
        chatId: d.chatId || '',
        _intakeTelefone: telefone,
        ultimaInteracao: new Date().toISOString(),
      };
      if(categoria) dados.categoria = categoria; // honra "moto elétrica = 300cc"
      if(vendedor)  dados.vendedor  = vendedor;  // mesmo responsável no CRM e (depois) no ChatGuru

      // Caso de atenção humana: marca o lead e IMPEDE a auto-resposta.
      if(paraHumano){
        dados.atencaoHumano = true;
        dados.motivoHumano = (e.motivo || 'Requer atendimento humano');
        dados._semAutoResposta = true;   // prepararResposta pula este lead
        // Reinício de ciclo: reabre o AVISO para o mesmo número que volta a cotar.
        dados.avisoHumanoEnviado = false;
        dados.erroEnvio = '';
      }

      const textoTimeline = paraHumano
        ? `🔴 ATENDIMENTO HUMANO (ChatGuru → IA): ${e.motivo || 'requer atenção'}.`
        : 'Lead automático (ChatGuru → IA). Aguardando cálculo da média.';

      if(!snap.exists){
        // lead novo: entra na coluna Novo Lead, sem trajetos (pro app calcular)
        tx.set(ref, {
          ...dados,
          etapa: 'novo',
          prioridade: 'quente',
          dataEntrada: new Date().toISOString().slice(0,10),
          timeline: [{ data: new Date().toISOString(), tipo: 'criacao', texto: textoTimeline }],
        });
      } else {
        // já existe: só atualiza os dados, sem mexer em etapa/vendedor/trajetos
        tx.update(ref, dados);
      }
    });

    // ---- Fase B: calcula a MÉDIA no BACKEND (24h, sem depender do navegador) ----
    // Só para automáticos. Lê a MESMA tabela do Firestore que o admin importa da planilha.
    // Se a média sair, grava no lead → dispara `prepararResposta` (que envia, se ligado).
    // Se NÃO houver rota automática, o lead vai para atenção humana (orçamento manual).
    if(!paraHumano){
      try {
        const calc = await calcularFrete({
          origem: e.origem || '',
          destino: e.destino || '',
          categoria: categoria || '',
          veiculoDesc: e.veiculo || '',
          valorVeiculo: e.valorVeiculo,
        });
        if(calc.ok){
          await ref.update({
            valorCotacaoSW: calc.valorCotacaoSW,
            valorEstimado: calc.valorEstimado,
            prazoSW: calc.prazoSW || '',
            trajetos: calc.trajetos || [],
            composicao: calc.composicao || [],
            _calcAuto: true,          // impede o app de recalcular por cima
            _mediaBackend: true,
            mediaCalculadaEm: tsLead(),
            // Reinício de ciclo: reabre o envio JUNTO com a média NOVA (mesma
            // atualização), pra prepararResposta enviar o valor certo — nunca o
            // antigo. Sem isso, o mesmo número recotando não reenviava.
            respostaEnviada: false,
            avisoHumanoEnviado: false,
            erroEnvio: '',
            _semAutoResposta: false,
            atencaoHumano: false,
            mediaEnviadaMarcada: false,
          });
          console.log(`[criarLeadNoCrm] média backend ${leadId}: R$ ${calc.valorEstimado} (prazo ${calc.prazoSW || '?'}d).`);
        } else {
          // Sem rota automática (ex.: categoria/rota sem preço) → atendente humano confecciona.
          await ref.update({
            atencaoHumano: true,
            motivoHumano: 'Sem rota automática — orçamento manual pelo atendente',
            _semAutoResposta: true,
            _semRota: true,
            // Reinício de ciclo: reabre o AVISO para o mesmo número que volta.
            avisoHumanoEnviado: false,
            erroEnvio: '',
          });
          console.log(`[criarLeadNoCrm] ${leadId} SEM rota automática (${calc.motivo}) → atenção humana.`);
        }
      } catch(err){
        console.error(`[criarLeadNoCrm] erro no cálculo backend de ${leadId}:`, err);
      }
    }

    // leadCriado já foi reivindicado no início (trava anti-duplicação). Aqui só
    // gravamos o leadId e o vendedor do rodízio (pra Etapa 5 setar o mesmo no ChatGuru).
    await event.data.after.ref.update({
      leadId,
      vendedorAtribuido: vendedor || '',   // pra Etapa 5 setar o mesmo no ChatGuru
    });
    console.log(`[criarLeadNoCrm] Lead ${telefone} -> ${leadId} | ${paraHumano ? 'HUMANO (' + (e.motivo || '') + ')' : 'automático'} | vendedor: ${vendedor || '(nenhum)'} | categoria: ${categoria || 'auto'}.`);
  }
);

/* Chave liga/desliga do envio real, guardada no Firestore (crm_config/config,
   campo envioAtivo). Começa DESLIGADA (doc ausente = false). Assim você ativa o
   envio SEM re-deploy: basta pôr envioAtivo=true nesse documento. */
async function envioEstaAtivo(){
  try {
    const snap = await db.collection('crm_config').doc('config').get();
    const v = snap.exists ? snap.data().envioAtivo : undefined;
    // Aceita booleano true, texto "true" ou número 1 — evita "não envia" só porque
    // o campo foi salvo como texto no console do Firestore (engano comum).
    const ativo = v === true || v === 'true' || v === 1 || v === '1';
    if(!ativo) console.log(`[envioEstaAtivo] DESLIGADO (envioAtivo=${JSON.stringify(v)}, doc ${snap.exists?'existe':'AUSENTE'}).`);
    return ativo;
  } catch(e){ console.error('[envioEstaAtivo] erro lendo crm_config/config:', e); return false; }
}

/* ---- ETAPA 5A.2: média calculada → prepara a resposta e (se ativo) ENVIA ----
   - Sempre prepara o rascunho (respostaPreparada).
   - Só envia pelo ChatGuru se envioAtivo=true no crm_config/config.
   - Guards evitam reenvio e loop de gatilho. */
exports.prepararResposta = onDocumentUpdated(
  {
    document: 'crm_leads/{leadId}',
    region: 'southamerica-east1',
    secrets: ['CHATGURU_API_KEY', 'CHATGURU_ACCOUNT_ID', 'CHATGURU_PHONE_ID'],
  },
  async (event) => {
    // Modo PostgreSQL: os leads não moram mais no Firestore, então este gatilho
    // não dispara — quem envia é o verificador `enviarPendentesPG` (abaixo).
    if(USAR_PG) return;
    const d = event.data && event.data.after && event.data.after.data();
    if(!d) return;
    if(!d._intakeTelefone) return;             // só leads da automação

    // ATENÇÃO HUMANA (sem rota, sem valor, valor alto, frota…): manda UMA mensagem
    // ao cliente pra ele não ficar sem resposta. Acima do limite → texto personalizado.
    // Depois, silêncio (a equipe assume a conversa).
    if(d.atencaoHumano){
      if(d.avisoHumanoEnviado || d.erroEnvio) return;
      if(await envioEstaAtivo()){
        const ref = event.data.after.ref;
        const e = d.extraidoIA || {};
        const valorAlto = !!e.valorInformado && Number(e.valorVeiculo) > LIMITE_VALOR_HUMANO;
        // trava ATÔMICA p/ não enviar o aviso 2x (mesma corrida de dois updates rápidos)
        const claimed = await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref); const cur = snap.exists ? (snap.data() || {}) : {};
          if(cur.avisoHumanoEnviado || cur.erroEnvio || !cur.atencaoHumano) return false;
          tx.update(ref, { avisoHumanoEnviado: true, avisoHumanoTipo: valorAlto ? 'valor_alto' : 'padrao', avisoHumanoEm: FieldValue.serverTimestamp() });
          return true;
        });
        if(!claimed) return;   // outra invocação já pegou → não duplica
        const texto = (valorAlto ? montarMensagemValorAlto(d) : montarMensagemHumano(d)) + sufixoForaExpediente();
        try {
          const r = await enviarMensagem({ chatNumber: d._intakeTelefone, texto });
          await ref.update({ avisoHumanoMessageId: (r && r.message_id) || '' });
          console.log(`[prepararResposta] AVISO HUMANO (${valorAlto ? 'valor alto' : 'padrão'}) enviado ${event.params.leadId}.`);
        } catch(e2){
          await ref.update({ avisoHumanoEnviado: false, erroEnvio: String((e2 && e2.message) || e2) });
          console.error(`[prepararResposta] ERRO ao enviar aviso humano ${event.params.leadId}:`, e2);
        }
      } else {
        console.log(`[prepararResposta] aviso humano pronto para ${event.params.leadId} (envio DESLIGADO).`);
      }
      return;
    }

    if(d._semAutoResposta) return;             // segurança: outros casos humanos não respondem
    if(!formatarBRL(d.valorEstimado)) return;  // ainda sem média válida
    if(d.respostaEnviada) return;              // já enviado
    if(d.erroEnvio) return;                    // falhou antes; não fica retentando em loop

    const ref = event.data.after.ref;
    const ativo = await envioEstaAtivo();

    // ENVIO LIGADO: trava ATÔMICA para NÃO enviar 2x. Dois updates rápidos do lead
    // (ex.: o botão "Enviar automático" + sync) disparavam a função quase juntos; sem
    // trava, as duas liam respostaEnviada=false e enviavam. A transação marca
    // respostaEnviada ANTES do envio — só UMA invocação passa.
    if(ativo){
      const claimed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref); const cur = snap.exists ? (snap.data() || {}) : {};
        if(cur.respostaEnviada || cur.erroEnvio || cur._semAutoResposta) return false;
        if(!formatarBRL(cur.valorEstimado)) return false;
        tx.update(ref, { respostaEnviada: true, respostaEnviadaEm: FieldValue.serverTimestamp() });
        return true;
      });
      if(!claimed) return;   // outra invocação já pegou o envio → não duplica
      const textoBase = d.respostaPreparada || montarMensagem(d);
      const texto = textoBase + sufixoForaExpediente();   // aviso só se estiver fora do horário
      try {
        const r = await enviarMensagem({ chatNumber: d._intakeTelefone, texto });
        const patch = { respostaPreparada: textoBase, chatguruMessageId: (r && r.message_id) || '' };
        // Marca MediaEnviada=Sim no ChatGuru (habilita os diálogos de interesse 3.3/3.4).
        try {
          await atualizarContexto({ chatNumber: d._intakeTelefone, variaveis: { MediaEnviada: 'Sim' } });
          patch.mediaEnviadaMarcada = true;
          patch.mediaEnviadaErro = '';   // limpa erro anterior, se houver
          console.log(`[prepararResposta] MediaEnviada=Sim marcada no ChatGuru para ${event.params.leadId} (${d._intakeTelefone}).`);
        } catch(e2){
          // Não interrompe (a média já foi enviada). Guarda o erro NO LEAD pra
          // aparecer no CRM/Firestore, e loga bem visível pra diagnosticar.
          patch.mediaEnviadaMarcada = false;
          patch.mediaEnviadaErro = String((e2 && e2.message) || e2);
          console.error(`[prepararResposta] média enviada, mas FALHOU marcar MediaEnviada em ${event.params.leadId} (${d._intakeTelefone}): ${patch.mediaEnviadaErro}`);
        }
        await ref.update(patch);
        console.log(`[prepararResposta] ENVIADO ${event.params.leadId} (msg ${patch.chatguruMessageId}).`);
      } catch(e){
        // falhou: LIBERA a trava e registra o erro (não fica preso como enviado)
        await ref.update({ respostaEnviada: false, erroEnvio: String((e && e.message) || e) });
        console.error(`[prepararResposta] ERRO ao enviar ${event.params.leadId}:`, e);
      }
      return;
    }

    // ENVIO DESLIGADO: só prepara o rascunho (não envia).
    if(!d.respostaPreparada){
      await ref.update({ respostaPreparada: montarMensagem(d), respostaEnviada: false, respostaPreparadaEm: FieldValue.serverTimestamp() });
    }
    console.log(`[prepararResposta] Rascunho pronto para ${event.params.leadId} (envio DESLIGADO).`);
  }
);

/* ---- VERIFICADOR DE ENVIOS (modo PostgreSQL) --------------------------------
   Substitui o gatilho `crm_leads → prepararResposta` quando os leads moram no
   PostgreSQL. Roda de 1 em 1 min: procura leads da automação com média pronta
   (ou aviso humano pendente) e ainda NÃO enviados, e envia pelo ChatGuru. A trava
   ATÔMICA (/claim) garante que a mensagem nunca sai 2x. Serve tanto pro fluxo
   automático quanto pro botão "Enviar automático" do app (os dois marcam no lead).
   Fica INERTE enquanto OBS_USAR_PG estiver desligado. */
exports.enviarPendentesPG = onSchedule(
  {
    schedule: 'every 1 minutes',
    region: 'southamerica-east1',
    secrets: ['CHATGURU_API_KEY', 'CHATGURU_ACCOUNT_ID', 'CHATGURU_PHONE_ID', 'OBS_API_TOKEN'],
  },
  async () => {
    if(!USAR_PG) return;                       // só no modo servidor novo
    const ativo = await envioEstaAtivo();
    let leads;
    try { leads = await listar('crm_leads'); }
    catch(e){ console.error('[enviarPendentesPG] erro lendo leads:', (e && e.message) || e); return; }

    for(const d of leads){
      if(!d || !d._intakeTelefone) continue;   // só leads da automação
      const leadId = d.id;
      try {
        // ---- ATENÇÃO HUMANA: manda 1 aviso e silencia ----
        if(d.atencaoHumano){
          if(d.avisoHumanoEnviado || d.erroEnvio) continue;
          if(!ativo){ continue; }
          const e = d.extraidoIA || {};
          const valorAlto = !!e.valorInformado && Number(e.valorVeiculo) > LIMITE_VALOR_HUMANO;
          const ganhou = await claim('crm_leads', leadId, 'avisoHumanoEnviado',
            { avisoHumanoTipo: valorAlto ? 'valor_alto' : 'padrao', avisoHumanoEm: new Date().toISOString() });
          if(!ganhou) continue;                // outra execução já pegou
          const texto = (valorAlto ? montarMensagemValorAlto(d) : montarMensagemHumano(d)) + sufixoForaExpediente();
          try {
            const r = await enviarMensagem({ chatNumber: d._intakeTelefone, texto });
            await pgDb.collection('crm_leads').doc(leadId).update({ avisoHumanoMessageId: (r && r.message_id) || '' });
            console.log(`[enviarPendentesPG] AVISO HUMANO (${valorAlto ? 'valor alto' : 'padrão'}) enviado ${leadId}.`);
          } catch(e2){
            await pgDb.collection('crm_leads').doc(leadId).update({ avisoHumanoEnviado: false, erroEnvio: String((e2 && e2.message) || e2) });
            console.error(`[enviarPendentesPG] ERRO aviso humano ${leadId}:`, (e2 && e2.message) || e2);
          }
          continue;
        }

        // ---- AUTOMÁTICO: manda a média ----
        if(d._semAutoResposta) continue;
        if(!formatarBRL(d.valorEstimado)) continue;   // ainda sem média válida
        if(d.respostaEnviada) continue;               // já enviado
        if(d.erroEnvio) continue;                      // falhou antes; não retenta em loop
        if(!ativo){ continue; }                        // envio desligado
        const ganhou = await claim('crm_leads', leadId, 'respostaEnviada', { respostaEnviadaEm: new Date().toISOString() });
        if(!ganhou) continue;                          // outra execução já pegou o envio
        const textoBase = d.respostaPreparada || montarMensagem(d);
        const texto = textoBase + sufixoForaExpediente();
        try {
          const r = await enviarMensagem({ chatNumber: d._intakeTelefone, texto });
          const patch = { respostaPreparada: textoBase, chatguruMessageId: (r && r.message_id) || '' };
          try {
            await atualizarContexto({ chatNumber: d._intakeTelefone, variaveis: { MediaEnviada: 'Sim' } });
            patch.mediaEnviadaMarcada = true; patch.mediaEnviadaErro = '';
          } catch(e2){
            patch.mediaEnviadaMarcada = false; patch.mediaEnviadaErro = String((e2 && e2.message) || e2);
            console.error(`[enviarPendentesPG] média enviada, mas FALHOU marcar MediaEnviada ${leadId}:`, patch.mediaEnviadaErro);
          }
          await pgDb.collection('crm_leads').doc(leadId).update(patch);
          console.log(`[enviarPendentesPG] ENVIADO ${leadId} (msg ${patch.chatguruMessageId}).`);
        } catch(e){
          await pgDb.collection('crm_leads').doc(leadId).update({ respostaEnviada: false, erroEnvio: String((e && e.message) || e) });
          console.error(`[enviarPendentesPG] ERRO ao enviar ${leadId}:`, (e && e.message) || e);
        }
      } catch(eLead){
        console.error(`[enviarPendentesPG] erro no lead ${leadId}:`, (eLead && eLead.message) || eLead);
      }
    }
  }
);
