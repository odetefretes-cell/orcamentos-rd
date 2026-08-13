/* ============================================================================
   OBS Transportes — Ponte de integração
   ChatGuru (WhatsApp API oficial)  ⇄  SW Fretes (cálculo)  ⇄  CRM (Firestore)

   Firebase Cloud Functions (2ª geração, Node 18+).
   Sobe UMA função HTTPS com 2 rotas:

     POST  /cotar          → recebe os dados do cliente (do ChatGuru),
                             calcula na SW Fretes, cria o lead no CRM e
                             devolve o valor médio p/ o ChatGuru responder.

     POST  /interesse      → botão SIM/NÃO do WhatsApp; marca o interesse
                             no lead do CRM (aparece na hora no Kanban da equipe).

   O app (index.html) já escuta a coleção `crm_leads` em tempo real
   (onSnapshot), então tudo que esta função gravar aparece sozinho no CRM.

   ----------------------------------------------------------------------------
   CONFIGURAÇÃO (nunca coloque tokens no index.html público):
     firebase functions:config:set \
        sw.apptoken="SEU_APPTOKEN"  sw.bearer="SEU_BEARER" \
        chatguru.secret="UM_SEGREDO_QUALQUER"
   (ou variáveis de ambiente SW_APPTOKEN, SW_BEARER, CG_SECRET na 2ª geração)
   ============================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

const SW_URL      = 'https://api.swweb.info/v1/freight-quotes/quote';
const SW_APPTOKEN = process.env.SW_APPTOKEN || '';
const SW_BEARER   = process.env.SW_BEARER   || '';
const CG_SECRET   = process.env.CG_SECRET   || '';

// Categoria SW por tipo de veículo (ajuste conforme o cadastro da OBS na SW).
// 4 = Carro Passeio (exemplo do manual). Deixe um padrão seguro.
const CATEGORIA_PADRAO = 4;

function soDigitos(v){ return String(v==null?'':v).replace(/\D/g,''); }
function hoje(){ return new Date().toISOString().slice(0,10); }

/* Chama a SW Fretes e devolve o melhor resultado (menor preço que atende). */
async function calcularSW({ cepOrigem, cepDestino, valorVeiculo, categoria, dataColeta }){
  const body = {
    source: 'full', itemType: 2, fillTotals: 1,
    collectDate: dataColeta || hoje(),
    fromPostalCode: soDigitos(cepOrigem),
    toPostalCode:   soDigitos(cepDestino),
    productCategoryCode: categoria || CATEGORIA_PADRAO,
    totalValue: Number(valorVeiculo) || 0
  };
  const resp = await fetch(SW_URL, {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'AppToken': SW_APPTOKEN,
      'Authorization': 'Bearer ' + SW_BEARER
    },
    body: JSON.stringify(body)
  });
  const json = await resp.json().catch(()=> ({}));
  if(!resp.ok || json.status !== 1){
    const msg = (json && json.message) || ('SW HTTP '+resp.status);
    throw new Error(msg);
  }
  const results = (json.data && json.data.results) || [];
  const atende = results.filter(r => r.serves === 1 && r.price != null);
  if(!atende.length) throw new Error('Sem transportadora para a rota informada.');
  // destaque 1 = melhor escolha; senão, menor preço.
  atende.sort((a,b)=> (b.highlight===1) - (a.highlight===1) || a.price - b.price);
  const best = atende[0];
  // taxas (details) -> composição editável no CRM
  const composicao = (best.details||[]).map(d => ({
    desc: d.description || '',
    valor: String(d.value != null ? d.value : ''),
    ativo: d.enabled === 1,
    opcional: d.required === 0
  }));
  // trechos (legs) -> trajetos
  const trajetos = (best.legs||[]).map(g => ({
    de: (g.fromCityName||'') + (g.fromState?', '+g.fromState:''),
    para: (g.toCityName||'') + (g.toState?', '+g.toState:''),
    transportadora: g.carrierName || '',
    valor: String(g.price != null ? g.price : '')
  }));
  return {
    cotacaoId: json.data.id,
    valor:  best.price,
    prazo:  best.deliveryDays || null,
    entrega: best.deliveryDate || null,
    cidadeOrigem:  json.data.fromCityName || '',
    cidadeDestino: json.data.toCityName || '',
    composicao, trajetos
  };
}

/* Cria/atualiza o lead no CRM (mesma coleção que o app escuta). */
async function gravarLead(id, dados){
  await db.collection('crm_leads').doc(id).set(dados, { merge:true });
}

exports.obsIntegracao = onRequest({ cors:true, region:'southamerica-east1' }, async (req, res) => {
  try{
    // teste rápido no navegador (GET) — confirma que a função está no ar
    if(req.method === 'GET'){ res.json({ ok:true, servico:'obsIntegracao', dica:'use POST em /cotar e /interesse' }); return; }
    if(req.method !== 'POST'){ res.status(405).json({ ok:false, erro:'use POST' }); return; }
    // segredo simples compartilhado com o ChatGuru
    if(CG_SECRET && req.get('X-CG-Secret') !== CG_SECRET){
      res.status(401).json({ ok:false, erro:'não autorizado' }); return;
    }
    const rota = (req.path||'').replace(/\/+$/,'');
    const b = req.body || {};

    // ----- 1) Cotar + criar lead -----
    if(rota.endsWith('/cotar') || rota===''){
      // chave = últimos 8 dígitos (mesma do formulário do site e do webhook do ChatGuru) → não duplica
      const leadId = 'lead_wpp_' + (soDigitos(b.telefone).slice(-8) || soDigitos(b.telefone || Date.now()));
      let cot = null, erroCot = '';
      // A SW Fretes é OPCIONAL: se não houver tokens configurados, pula o cálculo —
      // o próprio app (crmAutoCalcSite) calcula o lead do WhatsApp automaticamente no CRM.
      if(SW_APPTOKEN && SW_BEARER){
        try{
          cot = await calcularSW({
            cepOrigem: b.cepOrigem, cepDestino: b.cepDestino,
            valorVeiculo: b.valorVeiculo, categoria: b.categoria,
            dataColeta: b.dataEnvio
          });
        }catch(e){ erroCot = e.message || String(e); }
      }

      const lead = {
        id: leadId,
        nome: b.nome || '', telefone: b.telefone || '', email: b.email || '',
        empresa: b.tipo || '', cpfCnpj: b.cpfCnpj || '',
        veiculoDesc: b.veiculo || b.modelo || '',
        origem: b.origem || cot?.cidadeOrigem || '',
        destino: b.destino || cot?.cidadeDestino || '',
        valorVeiculo: b.valorVeiculo || '',
        funciona: b.funciona || '', blindado: b.blindado || '',
        dataEnvio: b.dataEnvio || '',
        etapa: 'novo', prioridade: 'quente',
        origemLead: 'whatsapp', interesse: '',
        valorCotacaoSW: cot ? String(cot.valor) : '',
        prazoSW: cot && cot.prazo ? String(cot.prazo) : '',
        cotacaoId: cot ? String(cot.cotacaoId) : '',
        valorEstimado: cot ? String(cot.valor) : '',
        composicao: cot ? cot.composicao : [],
        trajetos: cot ? cot.trajetos : [],
        vendedor: '',
        dataEntrada: hoje(),
        ultimaInteracao: new Date().toISOString(),
        timeline: FieldValue.arrayUnion({
          data: new Date().toISOString(), tipo:'criacao',
          texto: cot ? `Lead do WhatsApp (ChatGuru). Cotação SW: R$ ${cot.valor} (prazo ${cot.prazo||'?'} dias).`
               : erroCot ? `Lead do WhatsApp (ChatGuru). Falha ao cotar na SW: ${erroCot} — o CRM calcula sozinho.`
                     : `Lead recebido pelo WhatsApp (ChatGuru) — cálculo automático no CRM.`
        })
      };
      await gravarLead(leadId, lead);
      res.json({
        ok:true, leadId,
        cotou: !!cot,
        valor: cot ? cot.valor : null,
        prazo: cot ? cot.prazo : null,
        erro: erroCot || undefined
      });
      return;
    }

    // ----- 2) Botão de interesse (SIM/NÃO) -----
    if(rota.endsWith('/interesse')){
      const leadId = b.leadId || ('lead_wpp_' + (soDigitos(b.telefone||'').slice(-8) || soDigitos(b.telefone||'')));
      const val = /sim|yes|1|true/i.test(String(b.interesse)) ? 'sim'
                : /nao|não|no|0|false/i.test(String(b.interesse)) ? 'nao' : '';
      await gravarLead(leadId, {
        interesse: val,
        etapa: val==='sim' ? 'contato' : (val==='nao' ? 'perdido' : 'novo'),
        ultimaInteracao: new Date().toISOString(),
        timeline: FieldValue.arrayUnion({
          data:new Date().toISOString(), tipo:'whatsapp',
          texto: val==='sim' ? 'Cliente respondeu SIM (tem interesse) no WhatsApp.'
               : val==='nao' ? 'Cliente respondeu NÃO no WhatsApp.'
               : 'Resposta de interesse recebida.'
        })
      });
      res.json({ ok:true, leadId, interesse: val });
      return;
    }

    res.status(404).json({ ok:false, erro:'rota desconhecida' });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, erro: e.message || String(e) });
  }
});

/* ----------------------------------------------------------------------------
   Webhook de ENTRADA de leads do ChatGuru (Etapa 1+2 da automação).
   Fica num arquivo separado (chatguru-webhook.js) pra não misturar com a ponte
   de cotação acima. O require vem DEPOIS do initializeApp() de propósito.
   ---------------------------------------------------------------------------- */
const _chatguru = require('./chatguru-webhook');
exports.chatguruWebhook      = _chatguru.chatguruWebhook;      // Etapa 1+2: recebe/salva
exports.fecharLeadsCompletos = _chatguru.fecharLeadsCompletos; // Etapa 3: fecha após 60s

// Etapa 4: quando o lead fica completo, o Claude extrai os campos e decide.
exports.processarLeadCompleto = require('./claude-extrator').processarLeadCompleto;

// Etapa 5 (Fase A): cria o lead no CRM p/ o sistema calcular a média e prepara
// a resposta como RASCUNHO (ainda não envia pro cliente).
const _orc = require('./orcamento-resposta');
exports.criarLeadNoCrm   = _orc.criarLeadNoCrm;
exports.prepararResposta = _orc.prepararResposta;

// Pré-cadastro do lead do formulário no ChatGuru (chat_add + Cotando=Sim), pra o
// Opener não disparar o intake por cima do lead que veio pelo formulário do site.
exports.preCadastrarLead = require('./precadastro').preCadastrarLead;
