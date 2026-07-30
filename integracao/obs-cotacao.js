/* OBS TRANSPORTES — Formulário de cotação (carregado como arquivo externo)
   Uso no WordPress/Elementor (widget HTML), cole apenas:
     <div id="obs-cotacao"></div>
     <script src="https://odetefretes-cell.github.io/orcamentos-rd/integracao/obs-cotacao.js" defer></script>
   Este arquivo cria o formulário (estilo + campos + Estado→Cidade via IBGE) e grava
   o lead direto no CRM da OBS (Firebase). Atualizações são automáticas. */
(function () {
  'use strict';
  if (window.__obsCotacao) return; window.__obsCotacao = true;

  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyC4rDP5_lQ6o_ASjM_ndauC2HCq4JxnKuQ",
    authDomain: "obs-fretes.firebaseapp.com",
    projectId: "obs-fretes",
    storageBucket: "obs-fretes.firebasestorage.app",
    messagingSenderId: "307588629600",
    appId: "1:307588629600:web:0914b25247953b56b06f05"
  };
  // Ponte Make → RD Station (o navegador manda pro Make; o Make entrega no RD pelo servidor, sem bloqueio CORS)
  var MAKE_WEBHOOK = 'https://hook.us2.make.com/s1a9hk0iu3oyn80or2dkvdslppgt2utz';
  // WhatsApp oficial da OBS (ChatGuru) — o formulário leva o cliente pra cá com a mensagem pronta,
  // para a conversa nascer no ChatGuru já com as informações e a janela de 24h aberta.
  var WPP_NUMERO = '5511932225311';
  // monta a mensagem que o cliente envia no WhatsApp (mesma estrutura da página #orc do app)
  function montarMsgWpp(lead) {
    var l = [
      '*Solicitação de orçamento — OBS Transportes*', '',
      'Nome: ' + lead.nome,
      'Telefone: ' + lead.telefone,
      (lead.email ? 'E-mail: ' + lead.email : null),
      'Tipo de cliente: ' + (lead.tipoCliente || ''),
      'Veículo: ' + lead.veiculoDesc,
      'Tipo de veículo: ' + (lead.categoria || ''),
      (lead.valorVeiculo ? 'Valor do veículo: ' + lead.valorVeiculo : null),
      'Funciona/liga: ' + (lead.funciona || ''),
      'Blindado: ' + (lead.blindado || ''),
      'Origem: ' + lead.origem,
      'Destino: ' + lead.destino,
      (lead.mensagem ? 'Observação: ' + lead.mensagem : null),
      '', 'Gostaria de receber o valor do transporte.'
    ].filter(Boolean);
    return l.join('\n');
  }
  var RD_IDENTIFICADOR = 'Cotacao Site OBS';

  var UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

  var CSS = ''
    + '.obs-cot{max-width:640px;margin:0 auto;font-family:inherit;color:#1f2733}'
    + '.obs-cot *{box-sizing:border-box}'
    + '.obs-titulo{margin:0 0 4px;font-size:22px;font-weight:800}'
    + '.obs-sub{margin:0 0 16px;font-size:14px;color:#5b6673}'
    + '.obs-cot label{display:block;font-size:13px;font-weight:600;margin-bottom:10px;color:#2b3542}'
    + '.obs-cot label span{color:#e8202a}'
    + '.obs-cot input,.obs-cot select,.obs-cot textarea{width:100%;margin-top:5px;padding:11px 12px;font-size:15px;border:1px solid #cfd6de;border-radius:10px;background:#fff;color:#1f2733;font-family:inherit}'
    + '.obs-cot input:focus,.obs-cot select:focus,.obs-cot textarea:focus{outline:none;border-color:#e8202a;box-shadow:0 0 0 3px rgba(232,32,42,.12)}'
    + '.obs-grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}'
    + '@media(max-width:540px){.obs-grid2{grid-template-columns:1fr}}'
    + '.obs-box{border:1px solid #e2e7ee;border-radius:12px;padding:12px 14px 2px;margin:0 0 12px}'
    + '.obs-box legend{font-size:13px;font-weight:700;padding:0 6px;color:#2b3542}'
    + '.obs-box legend span{color:#e8202a}'
    + '.obs-check{display:flex;align-items:flex-start;gap:9px;font-weight:500!important;font-size:13px;color:#3a4653;margin:4px 0 16px}'
    + '.obs-check input{width:auto;margin-top:2px}'
    + '.obs-btn{width:100%;padding:14px;font-size:16px;font-weight:800;color:#fff;background:#e8202a;border:none;border-radius:10px;cursor:pointer;transition:filter .15s}'
    + '.obs-btn:hover{filter:brightness(.93)}.obs-btn:disabled{opacity:.6;cursor:default}'
    + '.obs-erro{color:#c0392b;font-size:13px;font-weight:600;margin:10px 0 0;text-align:center}'
    + '.obs-ok{text-align:center;padding:32px 18px}'
    + '.obs-ok-ic{width:64px;height:64px;line-height:64px;margin:0 auto 14px;border-radius:50%;background:#16a34a;color:#fff;font-size:34px;font-weight:800}'
    + '.obs-ok h3{margin:0 0 8px;font-size:22px;font-weight:800}.obs-ok p{margin:0;color:#5b6673;font-size:15px}';

  var HTML = ''
    + '<div class="obs-cot">'
    + '<form id="obsForm" novalidate>'
    + '<h3 class="obs-titulo">Solicite sua cotação</h3>'
    + '<p class="obs-sub">Preencha os dados abaixo e nossa equipe retorna pelo WhatsApp.</p>'
    + '<div class="obs-linha"><label>Tipo de cliente <span>*</span>'
    + '<select name="tipoCliente" required><option value="">Selecione…</option><option>Pessoa Física</option><option>Pessoa Jurídica</option></select></label></div>'
    + '<div class="obs-linha"><label>Nome completo <span>*</span><input type="text" name="nome" required autocomplete="name" placeholder="Seu nome"></label></div>'
    + '<div class="obs-grid2">'
    + '<label>WhatsApp <span>*</span><input type="tel" name="telefone" required autocomplete="tel" placeholder="(11) 90000-0000"></label>'
    + '<label>E-mail <span>*</span><input type="email" name="email" required autocomplete="email" placeholder="voce@email.com"></label></div>'
    + '<div class="obs-grid2">'
    + '<label>Veículo (marca / modelo) <span>*</span><input type="text" name="veiculo" required placeholder="Ex.: Honda Civic 2020"></label>'
    + '<label>Tipo de veículo <span>*</span><select name="categoria" required><option value="">Selecione…</option><option>Carro passeio</option><option>Carro grande</option><option>Moto até 300cc</option><option>Moto até 700cc</option><option>Moto acima de 700cc</option></select></label></div>'
    + '<div class="obs-grid2">'
    + '<label>O veículo funciona (liga e anda)? <span>*</span><select name="funciona" required><option value="">Selecione…</option><option>Sim</option><option>Não</option></select></label>'
    + '<label>Veículo blindado? <span>*</span><select name="blindado" required><option value="">Selecione…</option><option>Sim</option><option>Não</option></select></label></div>'
    + '<div class="obs-linha"><label>Valor aproximado do veículo<input type="text" name="valorVeiculo" inputmode="numeric" placeholder="Ex.: R$ 60.000"></label></div>'
    + '<fieldset class="obs-box"><legend>Origem (de onde sai) <span>*</span></legend><div class="obs-grid2">'
    + '<label>Estado<select name="origemUF" class="obs-uf" required data-alvo="origemCidade"><option value="">Estado…</option></select></label>'
    + '<label>Cidade<select name="origemCidade" class="obs-cidade" required disabled><option value="">Escolha o estado primeiro</option></select></label></div></fieldset>'
    + '<fieldset class="obs-box"><legend>Destino (para onde vai) <span>*</span></legend><div class="obs-grid2">'
    + '<label>Estado<select name="destinoUF" class="obs-uf" required data-alvo="destinoCidade"><option value="">Estado…</option></select></label>'
    + '<label>Cidade<select name="destinoCidade" class="obs-cidade" required disabled><option value="">Escolha o estado primeiro</option></select></label></div></fieldset>'
    + '<div class="obs-linha"><label>Observação (opcional)<textarea name="mensagem" rows="2" placeholder="Alguma informação extra? (datas, retirada em casa, etc.)"></textarea></label></div>'
    + '<label class="obs-check"><input type="checkbox" name="consent" required><span>Autorizo a OBS Transportes a usar meus dados para retornar esta cotação.</span></label>'
    + '<button type="submit" class="obs-btn">Solicitar cotação</button>'
    + '<p class="obs-erro" id="obsErro" hidden></p>'
    + '</form>'
    + '<div class="obs-ok" id="obsOk" hidden><div class="obs-ok-ic">✓</div><h3>Abrindo o WhatsApp…</h3><p>Toque em <b>ENVIAR</b> na conversa que abrir para recebermos o seu pedido — nossa equipe retorna com a cotação por lá. Se não abrir, chame no WhatsApp (11) 93222-5311.</p></div>'
    + '</div>';

  function mount() {
    var host = document.getElementById('obs-cotacao');
    if (!host) return false;
    if (host.getAttribute('data-mounted')) return true;
    host.setAttribute('data-mounted', '1');

    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    host.innerHTML = HTML;
    var form = host.querySelector('#obsForm');
    var g = function (n) { var el = form.querySelector('[name="' + n + '"]'); return el ? el.value : ''; };

    // Estados
    form.querySelectorAll('.obs-uf').forEach(function (sel) {
      UFS.forEach(function (uf) { var o = document.createElement('option'); o.value = uf; o.textContent = uf; sel.appendChild(o); });
      sel.addEventListener('change', function () { carregarCidades(sel); });
    });

    // Cidades via IBGE
    var cache = {};
    function carregarCidades(ufSel) {
      var uf = ufSel.value;
      var alvo = form.querySelector('[name="' + ufSel.getAttribute('data-alvo') + '"]');
      if (!alvo) return;
      alvo.innerHTML = '<option value="">Carregando…</option>'; alvo.disabled = true;
      if (!uf) { alvo.innerHTML = '<option value="">Escolha o estado primeiro</option>'; return; }
      var done = function (lista) {
        alvo.innerHTML = '<option value="">Selecione a cidade…</option>' + lista.map(function (n) { return '<option>' + n + '</option>'; }).join('');
        alvo.disabled = false;
      };
      if (cache[uf]) { done(cache[uf]); return; }
      fetch('https://servicodados.ibge.gov.br/api/v1/localidades/estados/' + uf + '/municipios?orderBy=nome')
        .then(function (r) { return r.json(); })
        .then(function (arr) { cache[uf] = arr.map(function (m) { return m.nome; }); done(cache[uf]); })
        .catch(function (e) { alvo.innerHTML = '<option value="">(cidade indisponível — descreva na observação)</option>'; alvo.disabled = false; console.error('IBGE', e); });
    }

    // Firebase (carrega só ao enviar)
    var _db = null, _fb = null;
    function db() {
      if (_db) return Promise.resolve(_db);
      return import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js').then(function (appMod) {
        return import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js').then(function (fsMod) {
          _fb = fsMod; var app = appMod.initializeApp(FIREBASE_CONFIG, 'obs-form-cot'); _db = fsMod.getFirestore(app); return _db;
        });
      });
    }

    // envia o lead para a ponte Make (que entrega no RD Station pelo servidor) — em paralelo ao CRM
    function enviarRD(lead) {
      var body = {
        identificador: RD_IDENTIFICADOR,
        email: lead.email, nome: lead.nome, telefone: lead.telefone,
        tipoCliente: lead.tipoCliente, veiculo: lead.veiculoDesc, tipoVeiculo: lead.categoria,
        funciona: lead.funciona, blindado: lead.blindado, valorVeiculo: lead.valorVeiculo,
        origem: lead.origem, destino: lead.destino, observacao: lead.mensagem
      };
      return fetch(MAKE_WEBHOOK, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true
      }).then(function (r) { if (!r.ok) console.warn('Make status', r.status); })
        .catch(function (e) { console.warn('Ponte Make falhou (lead segue no CRM):', e); });
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var erro = host.querySelector('#obsErro'); erro.hidden = true;
      var btn = form.querySelector('.obs-btn');
      if (!g('tipoCliente') || !g('nome') || !g('telefone') || !g('email') || !g('veiculo') || !g('categoria') || !g('funciona') || !g('blindado') || !g('origemUF') || !g('origemCidade') || !g('destinoUF') || !g('destinoCidade')) {
        erro.textContent = 'Por favor, preencha todos os campos com *.'; erro.hidden = false; return;
      }
      if (!form.querySelector('[name="consent"]').checked) {
        erro.textContent = 'É necessário autorizar o uso dos dados para receber a cotação.'; erro.hidden = false; return;
      }
      btn.disabled = true; btn.textContent = 'Abrindo o WhatsApp…';
      var agora = new Date(), iso = agora.toISOString();
      var id = 'lead_site_' + agora.getTime() + '_' + Math.random().toString(36).slice(2, 7);
      var lead = {
        id: id, nome: g('nome'), empresa: '', telefone: g('telefone'), email: g('email'), cpfCnpj: '',
        veiculoDesc: g('veiculo'), placa: '', origem: g('origemCidade') + ' ' + g('origemUF'), destino: g('destinoCidade') + ' ' + g('destinoUF'),
        valorEstimado: '', etapa: 'novo', prioridade: 'morno', vendedor: '',
        origemLead: 'site', valorVeiculo: g('valorVeiculo'),
        funciona: g('funciona'), blindado: g('blindado'), dataEnvio: iso,
        tipoCliente: g('tipoCliente'), categoria: g('categoria'),
        interesse: '', valorCotacaoSW: '', prazoSW: '', cotacaoId: '',
        composicao: [], trajetos: [], enderecoColeta: '', enderecoEntrega: '',
        dataUltimoContato: '', dataFechamento: '', tarefas: [],
        dataEntrada: iso.slice(0, 10), ultimaInteracao: iso, motivoPerda: '',
        mensagem: g('mensagem'), origemUF: g('origemUF'), destinoUF: g('destinoUF'),
        timeline: [{ data: iso, tipo: 'criacao', texto: 'Lead recebido pelo formulário do site' }],
        _origemSite: true
      };
      // leva o cliente pro WhatsApp da OBS com tudo preenchido → a conversa nasce no ChatGuru
      // com as informações e a janela de 24h aberta (aí a equipe responde o orçamento direto).
      var waUrl = 'https://wa.me/' + WPP_NUMERO + '?text=' + encodeURIComponent(montarMsgWpp(lead));
      // grava no CRM e dispara o RD (melhor esforço); o redirecionamento acontece de qualquer forma
      db().then(function (base) {
        return _fb.setDoc(_fb.doc(base, 'crm_leads', id), lead);
      }).then(function () {
        try { enviarRD(lead); } catch (e) { console.error('RD', e); }   // envia ao RD (keepalive sobrevive à navegação)
      }).catch(function (e) {
        console.error('CRM/RD (segue pro WhatsApp mesmo assim):', e);
      }).then(function () {
        form.hidden = true; host.querySelector('#obsOk').hidden = false;   // mensagem de "abrindo o WhatsApp"
        window.location.href = waUrl;                                       // → WhatsApp / ChatGuru
      });
    });
    return true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  var t = 0, iv = setInterval(function () { if (mount() || ++t > 30) clearInterval(iv); }, 400);
})();
