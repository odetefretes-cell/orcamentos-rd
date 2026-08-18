# Plano — levar MAIS coisas pro Hostinger (app + automação)

> Preparado em **18/08/2026** (noite da virada). Objetivo: reduzir o que ainda
> depende do Firebase, num ritmo **seguro** (nada durante o expediente; um passo
> por vez; rollback pronto). **Recomendação: deixar a virada de hoje ESTABILIZAR
> 1–2 dias** (acompanhar os leads reais) antes de mexer mais.

## Onde estamos (depois da virada de hoje)
- 🟢 **No seu servidor:** banco (PostgreSQL), API, tabela de fretes, robô.
- 🔵 **Ainda no Firebase:** login da equipe (Auth), hospedagem do app (Hosting),
  automação 24h (Cloud Functions), buffer de entrada + logs (Firestore), upload (Storage).

---

## PASSO 1 — Servir o APP pelo próprio VPS  (menor, ~1 sessão)
Tirar o `sistema.obstransportes.com.br` do Firebase Hosting e servir o `index.html`
direto do Caddy no VPS (como já fazemos com `/app` e `/teste`).

**Como:**
1. Publicar o `index.html` no VPS (Caddy serve em `sistema.obstransportes.com.br`).
2. Apontar o DNS de `sistema` para o **IP do VPS** (hoje é CNAME pro Firebase).
3. Caddy emite o SSL sozinho; a CSP já libera `api.obstransportes.com.br`.
4. Publicar o app pelo VPS passa a ser: copiar o `index.html` da branch de dev
   pra `/opt/obs-api/publico/` (um `git show ... > sistema.html`), sem GitHub Actions.

**Risco:** baixo–médio (é troca de hospedagem do domínio). **Rollback:** voltar o
DNS de `sistema` para o Firebase Hosting.
**Ganho:** app 100% no seu servidor; deploy sem depender do Firebase Hosting.
**Atenção:** o login continua sendo **Firebase Auth** (a menos que se faça o Passo 3).

---

## PASSO 2 — Mover a AUTOMAÇÃO pro VPS  (grande, projeto dedicado)
Rodar o pipeline do ChatGuru no servidor, em vez de Cloud Functions + gatilhos do Firestore.

**O que muda:**
- **Webhook do ChatGuru** deixa de apontar pra Cloud Function e passa a apontar pra um
  endpoint no VPS (Caddy → serviço Node, ex.: `api.obstransportes.com.br/chatguru`).
- **Buffer de entrada** (`crm_leads_intake`) sai do Firestore → PostgreSQL.
- **Agendados** (`fecharLeadsCompletos`, `enviarPendentesPG`) viram **cron/PM2** no VPS.
- **IA (Anthropic)** passa a ser chamada do VPS (mesma chave).
- **Gatilhos** (que hoje encadeiam as etapas) viram **chamadas diretas** no serviço.

**Risco:** ALTO (é a automação que fatura 24h). Só com bateria de testes + janela fora
do expediente + rollback. **Rollback:** reapontar o webhook do ChatGuru de volta pra
Cloud Function e religar as funções.
**Ganho:** encerra a dependência de Firestore + Cloud Functions (tudo no seu servidor).

---

## PASSO 3 (opcional, depois) — Login próprio
Trocar o Firebase Auth por login próprio (a API já valida token; hoje confia no
Firebase). Só vale a pena depois dos passos 1 e 2. Baixa prioridade (o Auth é seguro
e barato).

---

## Ordem sugerida
1. **Estabilizar** a virada de hoje (1–2 dias, acompanhando os leads reais).
2. **Passo 1** (app no VPS) — rápido e de baixo risco.
3. **Passo 2** (automação no VPS) — projeto à parte, com testes e rollback.
4. **Passo 3** (login próprio) — só se fizer sentido.

## Pendências que continuam valendo
- Limpar **duplicados antigos** (`lead_wpp_{número completo}` — chaves com >8 dígitos).
- Formulário do site (`obs-cotacao.js`) grava direto no Firestore (o lead ainda chega
  via ChatGuru; endurecer no Passo 2).
- Girar a **chave de serviço do Firebase**, a **senha do robô** e o **API_TOKEN**.
