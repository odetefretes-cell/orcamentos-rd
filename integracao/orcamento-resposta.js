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

const db = getFirestore();

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
        precisaAjuste: !!e.precisaAjuste,
        motivoAjuste: e.motivoAjuste || '',
        chatId: d.chatId || '',
        _intakeTelefone: telefone,
        ultimaInteracao: new Date().toISOString(),
      };
      if(categoria) dados.categoria = categoria; // honra "moto elétrica = 300cc"

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

    await event.data.after.ref.update({ leadCriado: true, leadId, leadCriadoEm: FieldValue.serverTimestamp() });
    console.log(`[criarLeadNoCrm] Lead ${telefone} criado no CRM como ${leadId} (categoria: ${categoria || 'auto'}).`);
  }
);

/* ---- ETAPA 5A.2: média calculada → prepara a resposta (RASCUNHO, sem enviar) ---- */
exports.prepararResposta = onDocumentUpdated(
  { document: 'crm_leads/{leadId}', region: 'southamerica-east1' },
  async (event) => {
    const d = event.data && event.data.after && event.data.after.data();
    if(!d) return;
    // Só age nos leads que a automação criou, com média já calculada e sem rascunho.
    if(!d._intakeTelefone) return;
    if(d.respostaPreparada) return;
    if(!formatarBRL(d.valorEstimado)) return; // ainda sem média válida

    const texto = montarMensagem(d);
    await event.data.after.ref.update({
      respostaPreparada: texto,
      respostaEnviada: false,               // Fase A: NÃO envia; só deixa pronto
      respostaPreparadaEm: FieldValue.serverTimestamp(),
    });
    console.log(`[prepararResposta] Rascunho pronto para ${event.params.leadId} (média ${d.valorEstimado}).`);
  }
);
