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
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { enviarMensagem, atualizarContexto } = require('./chatguru-api');
const { calcularFrete } = require('./calc-fretes');   // Fase B: cálculo da média no backend (24h)

const db = getFirestore();

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
  { document: 'crm_leads_intake/{telefone}', region: 'southamerica-east1' },
  async (event) => {
    const d = event.data && event.data.after && event.data.after.data();
    if(!d) return;
    // Trata os dois desfechos da IA: 'automatico' (responde) e 'aguardando_humano'
    // (aparece no CRM p/ a equipe assumir, SEM responder o cliente).
    if(d.statusIntake !== 'automatico' && d.statusIntake !== 'aguardando_humano') return;
    if(d.leadCriado) return;                     // já criado (evita repetir)

    const paraHumano = d.statusIntake === 'aguardando_humano';
    const telefone = event.params.telefone;
    const e = d.extraido || {};

    const categoria = categoriaDeVeiculo(e.tipoVeiculo, e.orcarComo);

    // Responsável: se o ChatGuru já tiver um, respeita; senão (o normal, pois
    // todos entram "sem responsável"), o backend distribui por rodízio.
    let vendedor = canonVendedor(d.responsavelChatguru);
    if(!vendedor) vendedor = await proximoVendedor();

    // CHAVE do lead = últimos 8 dígitos do telefone — A MESMA usada pelo formulário
    // do site (obs-cotacao.js). Assim o lead do site e a atualização do ChatGuru caem
    // no MESMO documento (sem DUPLICAR) e ainda ignora +55/DDD/9º dígito/formatação.
    const chave = String(telefone).replace(/\D/g,'').slice(-8) || String(telefone);
    const leadId = 'lead_wpp_' + chave;
    const ref = db.collection('crm_leads').doc(leadId);

    await db.runTransaction(async (tx) => {
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
            mediaCalculadaEm: FieldValue.serverTimestamp(),
          });
          console.log(`[criarLeadNoCrm] média backend ${leadId}: R$ ${calc.valorEstimado} (prazo ${calc.prazoSW || '?'}d).`);
        } else {
          // Sem rota automática (ex.: categoria/rota sem preço) → atendente humano confecciona.
          await ref.update({
            atencaoHumano: true,
            motivoHumano: 'Sem rota automática — orçamento manual pelo atendente',
            _semAutoResposta: true,
            _semRota: true,
          });
          console.log(`[criarLeadNoCrm] ${leadId} SEM rota automática (${calc.motivo}) → atenção humana.`);
        }
      } catch(err){
        console.error(`[criarLeadNoCrm] erro no cálculo backend de ${leadId}:`, err);
      }
    }

    await event.data.after.ref.update({
      leadCriado: true, leadId,
      vendedorAtribuido: vendedor || '',   // pra Etapa 5 setar o mesmo no ChatGuru
      leadCriadoEm: FieldValue.serverTimestamp(),
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
    const d = event.data && event.data.after && event.data.after.data();
    if(!d) return;
    if(!d._intakeTelefone) return;             // só leads da automação

    // ATENÇÃO HUMANA (sem rota, sem valor, valor alto, frota…): manda UMA mensagem
    // ao cliente pra ele não ficar sem resposta. Acima do limite → texto personalizado.
    // Depois, silêncio (a equipe assume a conversa).
    if(d.atencaoHumano){
      if(d.avisoHumanoEnviado || d.erroEnvio) return;
      if(await envioEstaAtivo()){
        const e = d.extraidoIA || {};
        const valorAlto = !!e.valorInformado && Number(e.valorVeiculo) > LIMITE_VALOR_HUMANO;
        const texto = valorAlto ? montarMensagemValorAlto(d) : montarMensagemHumano(d);
        try {
          const r = await enviarMensagem({ chatNumber: d._intakeTelefone, texto });
          await event.data.after.ref.update({
            avisoHumanoEnviado: true,
            avisoHumanoTipo: valorAlto ? 'valor_alto' : 'padrao',
            avisoHumanoMessageId: (r && r.message_id) || '',
            avisoHumanoEm: FieldValue.serverTimestamp(),
          });
          console.log(`[prepararResposta] AVISO HUMANO (${valorAlto ? 'valor alto' : 'padrão'}) enviado ${event.params.leadId}.`);
        } catch(e2){
          await event.data.after.ref.update({ erroEnvio: String((e2 && e2.message) || e2) });
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
    const patch = {};

    // 1) Garante o rascunho (só cria se ainda não existe).
    let texto = d.respostaPreparada;
    if(!texto){
      texto = montarMensagem(d);
      patch.respostaPreparada = texto;
      patch.respostaEnviada = false;
      patch.respostaPreparadaEm = FieldValue.serverTimestamp();
    }

    // 2) Envia de verdade só se a chave estiver ligada.
    if(await envioEstaAtivo()){
      try {
        const r = await enviarMensagem({ chatNumber: d._intakeTelefone, texto });
        patch.respostaEnviada = true;
        patch.chatguruMessageId = (r && r.message_id) || '';
        patch.respostaEnviadaEm = FieldValue.serverTimestamp();
        console.log(`[prepararResposta] ENVIADO ${event.params.leadId} (msg ${patch.chatguruMessageId}).`);
        // Marca MediaEnviada=Sim no ChatGuru (mesma variável de contexto que o botão
        // grava) → habilita os diálogos de interesse (3.3/3.4) também nos leads do
        // formulário. Melhor-esforço: se falhar, a média já foi enviada.
        try {
          await atualizarContexto({ chatNumber: d._intakeTelefone, variaveis: { MediaEnviada: 'Sim' } });
          patch.mediaEnviadaMarcada = true;
        } catch(e2){
          console.warn(`[prepararResposta] média enviada, mas falhou marcar MediaEnviada em ${event.params.leadId}:`, (e2 && e2.message) || e2);
        }
      } catch(e){
        patch.respostaEnviada = false;
        patch.erroEnvio = String((e && e.message) || e);
        console.error(`[prepararResposta] ERRO ao enviar ${event.params.leadId}:`, e);
      }
    } else {
      console.log(`[prepararResposta] Rascunho pronto para ${event.params.leadId} (envio DESLIGADO).`);
    }

    if(Object.keys(patch).length) await ref.update(patch);
  }
);
