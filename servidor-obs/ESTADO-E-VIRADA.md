# OBS — Servidor próprio (Hostinger) — Estado atual e plano da virada

> Última atualização: **18/08/2026**. Objetivo do projeto: trazer o sistema da OBS
> para o **servidor próprio** (Hostinger VPS) — banco, API e app — "tudo num lugar só,
> mais seguro". **Regra de ouro: o sistema opera 100% no expediente; a virada nunca
> acontece durante o horário comercial.**

---

## 1. O que já está PRONTO e PROVADO (18/08)

Tudo isto roda no VPS **sem tocar na produção** (Firebase segue no ar normalmente):

| Peça | Onde | Status |
|---|---|---|
| VPS Hostinger (KVM2, Ubuntu 24.04, IP 187.127.53.211) | Hostinger | ✅ |
| Banco **PostgreSQL 16** + backup diário (03h, 14 dias) | VPS `/etc/obs-db` | ✅ |
| Dados migrados do Firestore → PostgreSQL (JSONB) | tabelas `crm_leads`(1763), `fretes`, `publico`, `clientes`, `crm_config` | ✅ |
| **API ponte** (Express + pg) | `/opt/obs-api` (PM2 `obs-api`, 127.0.0.1:3000) | ✅ |
| **HTTPS próprio** via Caddy | `https://api.obstransportes.com.br` | ✅ |
| Trava por **token** (robô/backend) | header `Authorization: Bearer` | ✅ |
| **Login da equipe** (7 e-mails, via Firebase ID token) | `/api/eu` | ✅ |
| Leitura **pública** de `publico/:id` (links de cliente) | `GET /api/publico/:id` | ✅ |
| **App inteiro rodando no servidor** (ler + gravar comprovados) | `https://api.obstransportes.com.br/app?api=1` | ✅ |
| Página de teste de login | `https://api.obstransportes.com.br/teste` | ✅ |

**Testado à mão e OK:** abrir lead, editar+salvar (persistiu após F5), criar lead,
mover no Kanban, tabela de fretes, clientes. Total de leads e métricas batendo.

---

## 2. Como a "ponte" funciona (app ↔ API)

- No `index.html` existe uma **ponte** (`criarPonteAPI`) que imita a fatia do Firestore
  que o app usa (`doc/collection/getDoc/setDoc/deleteDoc/writeBatch/onSnapshot`), mas
  falando com a API. O **login continua sendo o do Firebase** — a ponte usa o *ID token*
  do usuário logado pra autenticar cada chamada.
- **Tempo real** vira **polling** (checagem a cada ~8s). Funciona; é menos instantâneo
  que o Firestore. (Melhoria futura: endpoint de "mudou desde" ou SSE.)
- **Liga só com `?api=1`** na URL (ou `window.OBS_USAR_API`). Sem isso, o app é
  **idêntico à produção** (Firebase). Ver constante `OBS_USAR_API_PADRAO` (hoje `false`).
- `API_BASE` = `https://api.obstransportes.com.br` (sobrescreve com `?apibase=`).
- Uploads de documentos continuam no **Firebase Storage** (não migrado — ok por ora).

---

## 3. O BLOQUEIO da virada completa (a automação)

A automação 24h (Cloud Functions, pasta `integracao/`) é uma **corrente de gatilhos do
Firestore**:

```
intake grava → DISPARA criarLeadNoCrm → grava crm_leads → DISPARA prepararResposta → envia no WhatsApp
```

Cada passo dispara o próximo **porque é uma gravação no Firestore**. Se `crm_leads` for
pro PostgreSQL, **os gatilhos não disparam** e a automação para. Ou seja: mover a
automação **não é trocar o banco, é reconstruir a engrenagem** (e ela só é testável
fazendo deploy no Firebase, que mexe na produção).

**Consequência:** app e automação **têm que estar no mesmo banco**. Virar só o app
faria os leads novos do WhatsApp "sumirem" da tela da equipe. Por isso a virada
completa **não pode ser feita no escuro** — precisa da automação reconstruída e testada.

Pontos da automação que tocam dados compartilhados (para a reconstrução futura):
- `orcamento-resposta.js:240` — cria/atualiza `crm_leads/{leadId}` (dentro de `runTransaction`).
- `orcamento-resposta.js:47` — rodízio de vendedor em `crm_config/rodizio` (transação).
- `claude-extrator.js:41` — lê `crm_config/config` (`envioAtivo`).
- `calc-fretes.js:672` — lê a tabela `fretes/_tabela` (+ `_tabela_pN`).
- `webhook.js:102` — grava `crm_leads/{id}` (rota legada).
- Gatilhos: `criarLeadNoCrm` (dispara com intake), `prepararResposta` (dispara com o lead).

---

## 4. Plano da VIRADA (quando a automação estiver reconstruída e testada)

**Só fora do expediente.** Ordem:
1. Reconstruir a automação pra ler/gravar no PostgreSQL (via API) — **próximo passo dedicado**.
2. Testar a automação nova com **1 lead real** (log + rollback prontos).
3. Liberar `publico/` também na gravação da automação (cópia de acompanhamento).
4. No `index.html`: `OBS_USAR_API_PADRAO = true` e **deploy na `main`** (Firebase Hosting
   passa a servir o app já apontando pra API). CORS já libera `sistema.obstransportes.com.br`.
5. Monitorar. **Rollback:** `OBS_USAR_API_PADRAO = false` + deploy na `main` (volta pro Firebase).

---

## 5. Comandos úteis (no VPS, como root)

**Atualizar a API (branch `obs-servidor-bootstrap`):**
```bash
cd ~/obs-repo && git fetch origin obs-servidor-bootstrap && git reset --hard origin/obs-servidor-bootstrap \
  && cp ~/obs-repo/servidor-obs/api/server.mjs /opt/obs-api/ \
  && sudo -u obsrobo -H bash -lc 'pm2 restart obs-api'
```

**Reconstruir a cópia de teste do app (`/app`) a partir da branch de dev:**
```bash
cd ~/obs-repo && git fetch origin claude/automate-transport-contract-form-tgvad2 \
  && git show FETCH_HEAD:index.html > /opt/obs-api/publico/app.html && chmod a+r /opt/obs-api/publico/app.html
```

**Saúde / logs:**
```bash
curl -s https://api.obstransportes.com.br/api/health; echo
sudo -u obsrobo -H bash -lc 'pm2 logs obs-api --lines 30 --nostream'
```

**Token da API (quando o app/robô precisar):** `grep '^API_TOKEN=' /etc/obs-db/.env`

---

## 6. Pendências de segurança (fazer com calma)
- [ ] **Girar a chave de serviço do Firebase** (o `.json` passou pelo chat).
- [ ] **Trocar a senha do robô** do ChatGuru (`Cajuina@2026#01`).
- [ ] Antes de expor a API publicamente pra escrita em produção, considerar **girar o `API_TOKEN`** de novo.

## 7. Branches
- `obs-servidor-bootstrap` — arquivos do servidor (`servidor-obs/`). **Nunca** vai pra `main`.
- `claude/automate-transport-contract-form-tgvad2` — `index.html` (dev). Vai pra produção
  via `git push origin claude/...:main` (deploy automático no Firebase Hosting). A ponte
  já está aqui, **inerte** (só liga com `?api=1`).
