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
const { enviarMensagem } = require('./chatguru-api');

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

/* orcarComo (da Etapa 4) → categoria que o app entende (crmCategoriaSugerida). */
function categoriaDoOrcarComo(orcarComo){
  const s = (orcarComo || '').toLowerCase();
  if(/moto/.test(s) && /300/.test(s)) return 'Moto até 300cc';
  if(/moto/.test(s) && /700/.test(s)) return 'Moto até 700cc';
  return ''; // sem override → o app adivinha pela descrição do veículo
}

const TELEFONE_OBS = process.env.TELEFONE_OBS || '(11) 4352-4103';

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

/* ---- ETAPA 5A.1: intake 'automatico' → cria o lead no CRM (app calcula) ---- */
exports.criarLeadNoCrm = onDocumentUpdated(
  { document: 'crm_leads_intake/{telefone}', region: 'southamerica-east1' },
  async (event) => {
    const d = event.data && event.data.after && event.data.after.data();
    if(!d) return;
    if(d.statusIntake !== 'automatico') return; // só os que a IA liberou
    if(d.leadCriado) return;                     // já criado (evita repetir)

    const telefone = event.params.telefone;
    const e = d.extraido || {};

    const categoria = categoriaDoOrcarComo(e.orcarComo);

    // Responsável: se o ChatGuru já tiver um, respeita; senão (o normal, pois
    // todos entram "sem responsável"), o backend distribui por rodízio.
    let vendedor = canonVendedor(d.responsavelChatguru);
    if(!vendedor) vendedor = await proximoVendedor();

    const leadId = 'lead_wpp_' + telefone;
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

      if(!snap.exists){
        // lead novo: entra na coluna Novo Lead, sem trajetos (pro app calcular)
        tx.set(ref, {
          ...dados,
          etapa: 'novo',
          prioridade: 'quente',
          dataEntrada: new Date().toISOString().slice(0,10),
          timeline: [{
            data: new Date().toISOString(), tipo: 'criacao',
            texto: 'Lead automático (ChatGuru → IA). Aguardando cálculo da média.'
          }],
        });
      } else {
        // já existe: só atualiza os dados, sem mexer em etapa/vendedor/trajetos
        tx.update(ref, dados);
      }
    });

    await event.data.after.ref.update({
      leadCriado: true, leadId,
      vendedorAtribuido: vendedor || '',   // pra Etapa 5 setar o mesmo no ChatGuru
      leadCriadoEm: FieldValue.serverTimestamp(),
    });
    console.log(`[criarLeadNoCrm] Lead ${telefone} -> ${leadId} | vendedor: ${vendedor || '(nenhum)'} | categoria: ${categoria || 'auto'}.`);
  }
);

/* Chave liga/desliga do envio real, guardada no Firestore (crm_config/config,
   campo envioAtivo). Começa DESLIGADA (doc ausente = false). Assim você ativa o
   envio SEM re-deploy: basta pôr envioAtivo=true nesse documento. */
async function envioEstaAtivo(){
  try {
    const snap = await db.collection('crm_config').doc('config').get();
    return !!(snap.exists && snap.data().envioAtivo === true);
  } catch(_) { return false; }
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
