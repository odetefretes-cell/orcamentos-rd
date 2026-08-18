# OBS — Servidor próprio (Hostinger) — Estado atual e runbook da virada

> Última atualização: **18/08/2026**. Objetivo: trazer o sistema da OBS para o
> **servidor próprio** (Hostinger VPS) — banco, API e app — "tudo num lugar só".
> **Regra de ouro: o sistema opera 100% no expediente; a virada só fora do horário.**

---

## 1. PRONTO e PROVADO

| Peça | Onde | Status |
|---|---|---|
| VPS + **PostgreSQL 16** + backup diário (03h, 14 dias) | Hostinger, `/etc/obs-db` | ✅ |
| Dados migrados (crm_leads 1763, fretes, publico, clientes, crm_config) | PostgreSQL | ✅ |
| **API ponte** (Express + pg, PM2 `obs-api`) | `/opt/obs-api`, 127.0.0.1:3000 | ✅ |
| **HTTPS** `https://api.obstransportes.com.br` (Caddy) | VPS | ✅ |
| Auth: **token** (robô/backend) + **login da equipe** (7 e-mails) + **leitura pública** de `publico/:id` | API | ✅ |
| API: `?merge=1`, `/api/rodizio/next` (rodízio atômico), `/api/:col/:id/claim` (trava de envio) | API | ✅ |
| **App inteiro no servidor** (ler+gravar provados) | `.../app?api=1` | ✅ |
| **Automação reconstruída pro PostgreSQL** (código pronto, atrás da chave `OBS_USAR_PG`) | `integracao/` | ✅ (falta deploy) |
| Teste de conexão Functions→servidor | `integracao/teste-conexao-pg.js` | ✅ passou |

## 2. Como funciona a automação nova (chave `OBS_USAR_PG`)
- **Desligada (padrão):** tudo roda como hoje (Firestore + gatilho `prepararResposta`). Nada muda.
- **Ligada:** os LEADS, o RODÍZIO e a leitura da TABELA vão pro PostgreSQL; o envio da média/aviso
  passa a ser feito pelo **verificador** `enviarPendentesPG` (roda de 1 em 1 min, com trava atômica
  `/claim` pra nunca enviar 2x). O **intake e a IA continuam no Firestore** (interno).
- Arquivos: `integracao/pg-api.js` (adaptador), `orcamento-resposta.js` (criarLeadNoCrm + verificador),
  `calc-fretes.js` (tabela), `claude-extrator.js` (config), `webhook.js` (rota legada + export).

---

## 3. RUNBOOK DA VIRADA

### 3.1 Preparação (pode fazer a qualquer hora — NÃO muda nada em produção)
No **Cloud Shell** — cria o segredo do token (necessário pro deploy):
```bash
cd ~/orcamentos-rd
printf 'COLE_O_API_TOKEN' | firebase functions:secrets:set OBS_API_TOKEN --data-file=-
```
> O token está em `/etc/obs-db/.env` no VPS (`grep '^API_TOKEN=' /etc/obs-db/.env`).

### 3.2 Deploy seguro (chave DESLIGADA — comportamento idêntico ao de hoje)
No **Cloud Shell**, com a branch de dev:
```bash
cd ~/orcamentos-rd && git fetch origin claude/automate-transport-contract-form-tgvad2 \
  && git checkout -f claude/automate-transport-contract-form-tgvad2 \
  && git reset --hard origin/claude/automate-transport-contract-form-tgvad2
firebase deploy --only functions
```
Isso publica o código novo **sem ligar a chave** — a automação segue no Firestore, igual. Só adiciona
a função nova `enviarPendentesPG` (inerte enquanto a chave estiver desligada).

### 3.3 A VIRADA (fora do expediente)
1. **Ligar a chave** (Cloud Shell): criar/editar `integracao/.env` com:
   ```
   OBS_USAR_PG=true
   ```
   e redeployar: `firebase deploy --only functions`
2. **Ligar o app na API:** no `index.html`, trocar `OBS_USAR_API_PADRAO = false` → `true`,
   commitar na branch de dev e publicar na produção:
   ```bash
   git push origin claude/automate-transport-contract-form-tgvad2:main
   ```
   (o Firebase Hosting publica sozinho; o app passa a usar a API sem `?api=1`.)
3. **Testar com 1 lead real** (seu próprio número) pelo fluxo do ChatGuru; acompanhar:
   `firebase functions:log --only criarLeadNoCrm,enviarPendentesPG`
   e conferir o lead + a média no app.

### 3.4 ROLLBACK (se algo sair diferente)
1. Funções: em `integracao/.env` pôr `OBS_USAR_PG=false` (ou remover a linha) e
   `firebase deploy --only functions`.
2. App: voltar `OBS_USAR_API_PADRAO = true` → `false`, `git push ...:main`.
Pronto — volta tudo pro Firebase, sem perda.

---

## 4. Ainda falta (itens menores, antes/junto da virada)
- [ ] **Formulário do site** (`obs-cotacao.js`) grava o lead direto no Firestore (client-side). Após a
      virada, o lead **ainda chega** (o form abre o WhatsApp → ChatGuru → backend cria no PostgreSQL);
      só se perde a gravação imediata de quem preenche e **não** manda a mensagem. Endurecer depois
      (endpoint público de criação de lead site).
- [ ] **Robô de captação** (`servidor-obs/captar-leads.mjs`) grava no Firestore e está em DRY_RUN.
      Repontar pro PostgreSQL quando for ativado.
- [ ] **Upload de documentos** continua no Firebase Storage (ok; migrar é opcional).
- [ ] **Tempo real** do app é polling ~8s (melhorar com endpoint "mudou desde"/SSE, se quiser).

## 5. Segurança (fazer com calma)
- [ ] Girar a chave de serviço do Firebase (o `.json` passou pelo chat).
- [ ] Trocar a senha do robô do ChatGuru (`Cajuina@2026#01`).
- [ ] Girar o `API_TOKEN` do servidor antes de qualquer exposição pública de escrita.

## 6. Comandos úteis (VPS, root)
```bash
# atualizar a API
cd ~/obs-repo && git fetch origin obs-servidor-bootstrap && git reset --hard origin/obs-servidor-bootstrap \
  && cp ~/obs-repo/servidor-obs/api/server.mjs /opt/obs-api/ && sudo -u obsrobo -H bash -lc 'pm2 restart obs-api'
# reconstruir a cópia de teste do app (/app)
cd ~/obs-repo && git fetch origin claude/automate-transport-contract-form-tgvad2 \
  && git show FETCH_HEAD:index.html > /opt/obs-api/publico/app.html && chmod a+r /opt/obs-api/publico/app.html
# saúde / token
curl -s https://api.obstransportes.com.br/api/health; echo
grep '^API_TOKEN=' /etc/obs-db/.env
```

## 7. Branches
- `obs-servidor-bootstrap` — servidor (`servidor-obs/`). **Nunca** vai pra `main`. VPS puxa daqui.
- `claude/automate-transport-contract-form-tgvad2` — `index.html` + `integracao/` (dev). App vai pra
  produção via `git push origin ...:main` (Hosting). Funções: deploy manual pelo Cloud Shell desta branch.
