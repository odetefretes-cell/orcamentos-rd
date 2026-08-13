/* OBS TRANSPORTES — Botão flutuante de WhatsApp que abre o FORMULÁRIO COMPLETO de cotação.
   Ao clicar no botão verde, abre um popup com o formulário da OBS (veículo, origem, destino…);
   ao enviar, o cliente vai pro WhatsApp com a mensagem pronta (mesmo fluxo do obs-cotacao.js).

   USO no WordPress/Elementor — cole ESTA única linha (no widget HTML ou no rodapé do tema):
     <script src="https://odetefretes-cell.github.io/orcamentos-rd/integracao/obs-botao-wpp.js" defer></script>

   Depois, esconda/remova o botão de WhatsApp do plugin antigo para não ficarem dois. */
(function () {
  'use strict';
  if (window.__obsBotaoWpp) return; window.__obsBotaoWpp = true;

  // Cache-bust DIÁRIO: o `?v=AAAA-MM-DD` muda a cada dia, então o navegador baixa o
  // obs-cotacao.js novo em até 24h automaticamente (sem depender do cache do WP).
  // Assim, futuras atualizações do widget entram sozinhas — não repete o problema
  // do lead que pega a versão antiga (sem o pré-cadastro).
  var COTACAO_JS = 'https://odetefretes-cell.github.io/orcamentos-rd/integracao/obs-cotacao.js?v=' + (new Date().toISOString().slice(0, 10));

  var CSS = ''
    + '#obsWppBtn{position:fixed;right:20px;bottom:20px;z-index:99998;width:60px;height:60px;border-radius:50%;'
    + 'background:#25d366;border:none;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.28);display:flex;'
    + 'align-items:center;justify-content:center;transition:transform .15s,box-shadow .15s}'
    + '#obsWppBtn:hover{transform:scale(1.06);box-shadow:0 8px 26px rgba(0,0,0,.34)}'
    + '#obsWppBtn svg{width:34px;height:34px;fill:#fff}'
    + '#obsWppBtn .obsWppPulse{position:absolute;inset:0;border-radius:50%;background:#25d366;opacity:.45;'
    + 'animation:obsWppPulse 2s ease-out infinite;z-index:-1}'
    + '@keyframes obsWppPulse{0%{transform:scale(1);opacity:.45}100%{transform:scale(1.9);opacity:0}}'
    + '#obsWppTip{position:fixed;right:88px;bottom:34px;z-index:99998;background:#fff;color:#1f2a26;'
    + 'font:600 13px/1.3 -apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:9px 13px;border-radius:10px;'
    + 'box-shadow:0 4px 16px rgba(0,0,0,.18);max-width:210px}'
    + '#obsWppTip:after{content:"";position:absolute;right:-6px;bottom:16px;border:6px solid transparent;border-left-color:#fff}'
    + '#obsWppOverlay{position:fixed;inset:0;z-index:99999;background:rgba(10,12,16,.6);backdrop-filter:blur(3px);'
    + 'display:none;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 12px}'
    + '#obsWppOverlay.on{display:flex}'
    + '#obsWppCard{background:#fff;border-radius:16px;width:520px;max-width:96vw;position:relative;'
    + 'box-shadow:0 20px 60px rgba(0,0,0,.4);padding:8px 8px 4px}'
    + '#obsWppClose{position:absolute;top:10px;right:12px;z-index:2;width:34px;height:34px;border-radius:50%;'
    + 'border:none;background:#eef0f2;color:#333;font-size:20px;cursor:pointer;line-height:1}'
    + '#obsWppClose:hover{background:#e0e3e6}'
    + '@media(max-width:480px){#obsWppTip{display:none}#obsWppBtn{right:16px;bottom:16px}}';

  var ICON = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16.02 3.2c-7.06 0-12.8 5.73-12.8 12.79 0 2.25.59 4.45 1.71 6.39L3.2 28.8l6.6-1.73a12.77 12.77 0 0 0 6.22 1.59h.01c7.05 0 12.79-5.74 12.79-12.8 0-3.42-1.33-6.63-3.75-9.05a12.7 12.7 0 0 0-9.05-3.61zm0 23.32h-.01a10.6 10.6 0 0 1-5.4-1.48l-.39-.23-4.02 1.05 1.07-3.92-.25-.4a10.54 10.54 0 0 1-1.62-5.64c0-5.86 4.77-10.63 10.63-10.63 2.84 0 5.5 1.11 7.51 3.12a10.55 10.55 0 0 1 3.11 7.52c0 5.86-4.77 10.62-10.62 10.62zm5.83-7.96c-.32-.16-1.89-.93-2.18-1.04-.29-.11-.5-.16-.72.16-.21.32-.82 1.04-1.01 1.25-.19.21-.37.24-.69.08-.32-.16-1.35-.5-2.57-1.59-.95-.85-1.59-1.9-1.78-2.22-.19-.32-.02-.49.14-.65.14-.14.32-.37.48-.56.16-.19.21-.32.32-.53.11-.21.05-.4-.03-.56-.08-.16-.72-1.74-.99-2.38-.26-.62-.52-.54-.72-.55l-.61-.01c-.21 0-.56.08-.85.4-.29.32-1.11 1.09-1.11 2.66 0 1.57 1.14 3.08 1.3 3.29.16.21 2.25 3.43 5.44 4.81.76.33 1.35.52 1.81.67.76.24 1.46.21 2.01.13.61-.09 1.89-.77 2.16-1.52.27-.75.27-1.39.19-1.52-.08-.13-.29-.21-.61-.37z"/></svg>';

  function inject() {
    if (document.getElementById('obsWppBtn')) return;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

    var btn = document.createElement('button');
    btn.id = 'obsWppBtn'; btn.type = 'button'; btn.setAttribute('aria-label', 'Solicitar cotação pelo WhatsApp');
    btn.innerHTML = '<span class="obsWppPulse"></span>' + ICON;
    document.body.appendChild(btn);

    var tip = document.createElement('div'); tip.id = 'obsWppTip';
    tip.textContent = 'Solicite sua cotação 🚚'; document.body.appendChild(tip);

    var ov = document.createElement('div'); ov.id = 'obsWppOverlay';
    // container PRÓPRIO (id distinto) — não colide com um #obs-cotacao que já exista na página
    ov.innerHTML = '<div id="obsWppCard"><button id="obsWppClose" type="button" aria-label="Fechar">&times;</button>'
                 + '<div id="obsWppForm"></div></div>';
    document.body.appendChild(ov);

    function abrir() { ov.classList.add('on'); tip.style.display = 'none'; carregarForm(); }
    function fechar() { ov.classList.remove('on'); }
    btn.addEventListener('click', abrir);
    document.getElementById('obsWppClose').addEventListener('click', fechar);
    ov.addEventListener('click', function (e) { if (e.target === ov) fechar(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') fechar(); });

    // monta o formulário dentro do modal na 1ª abertura. Usa a função global obsCotacaoMount
    // exposta pelo obs-cotacao.js — funciona mesmo que o formulário JÁ exista na página.
    var montado = false;
    function carregarForm() {
      if (montado) return;
      var alvo = document.getElementById('obsWppForm');
      function tentar() { if (window.obsCotacaoMount) { window.obsCotacaoMount(alvo); montado = true; return true; } return false; }
      if (tentar()) return;
      // ainda não carregado nesta página → carrega o obs-cotacao.js e espera a função aparecer
      if (!document.querySelector('script[src*="obs-cotacao.js"]')) {
        var s = document.createElement('script'); s.src = COTACAO_JS; s.defer = true; document.body.appendChild(s);
      }
      var n = 0, iv = setInterval(function () { if (tentar() || ++n > 50) clearInterval(iv); }, 200);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();
