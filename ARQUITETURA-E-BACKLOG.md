# OBS Transportes — Arquitetura, Segurança e Backlog

> Documento de contexto para o Claude Code.
> Levantado em **2026-09-04** por inspeção direta do VPS, da hospedagem
> compartilhada e do Claude Console. **Consolidado em 2026-09-05** com as
> correções aplicadas no VPS (seção 7.4).
> **Substitui qualquer versão anterior deste arquivo.**
> Complementa o `CLAUDE.md` — não o substitui.

---

## 0. Os dois ambientes — não confundir

| | **VPS** | **Hospedagem compartilhada** |
|---|---|---|
| Plano | KVM 2 | Cloud Startup |
| Host | `srv1910419.hstgr.cloud` | `srv1888-files.hstgr.io` |
| Roda | automação, API, Conta Azul | WordPress institucional |
| Acesso | SSH / console web | Gerenciador de Arquivos |
| Consome Claude API | **sim** | não |

Quase todo trabalho de automação é no **VPS**. O site institucional é na
**compartilhada**. São servidores diferentes.

---

## 1. VPS — infraestrutura

| Item | Valor |
|---|---|
| Host | `srv1910419.hstgr.cloud` |
| IPv4 | `187.127.53.211` |
| SO | Ubuntu 24.04 LTS |
| Recursos | 2 vCPU · 8 GB RAM · 100 GB disco |
| Região | Brasil — Campinas |
| Backup | semanal (não diário) |

**Serviços systemd ativos:** `caddy` (proxy reverso), `postgresql@16-main`,
`obs-contaazul`, `monarx-agent` (scanner de segurança), `ssh`, `cron`.

**Docker não está instalado.** Tudo roda nativo.

### Processos da aplicação

Gerenciados por **PM2 sob o usuário `obsrobo`** — não root.
`pm2 list` como root retorna vazio. Sempre `sudo -u obsrobo pm2 ...`.

| PM2 id | Nome | Entrypoint | Porta |
|---|---|---|---|
| 0 | `obs-api` | `/opt/obs-api/server.mjs` | `127.0.0.1:3000` |
| 28 | `obs-automacao` | `/opt/obs-automacao/integracao/vps/orquestrador.js` | `127.0.0.1:3001` |
| — | `obs-contaazul` | `/opt/obs-contaazul/src/server.js` | systemd, fora do PM2 |

Fonte versionada em `/root/obs-repo/`; cópia implantada em `/opt/`.

---

## 2. Pipeline de lead

```
orquestrador.js          node-cron  * * * * *  (America/Sao_Paulo)
  └─ require('../webhook.js')
       └─ webhook.js:213
            exports.processarLeadCompleto =
              require('./claude-extrator').processarLeadCompleto
            └─ claude-extrator.js  →  Claude API
```

- **Lembretes:** cron separado `5 8-19 * * *`
- **Persistência:** Firestore foi substituído por PostgreSQL através do shim
  `pg-compat.js`, que reimplementa a superfície do `firebase-admin/firestore`.
  Flag: `OBS_USAR_PG=true`.
  Por isso o código *parece* Firebase Functions (`event.data.after.ref`,
  `FieldValue.serverTimestamp()`) mas roda inteiramente no VPS.
- Ciclos vazios não chamam a API — o log registra
  `[fecharLeadsCompletos] Nenhum lead em recebimento.` sem custo de token.

**Captação de leads** é um app separado: `/opt/obs-robo/captar-leads.mjs`.

---

## 3. Configuração

Arquivo único de ambiente, carregado por `dotenv`:

```js
// orquestrador.js:34
require('dotenv').config({
  path: process.env.DOTENV_CONFIG_PATH || '/etc/obs-automacao/.env'
});
```

**`/etc/obs-automacao/.env`**

```
ANTHROPIC_API_KEY=<secret>
ANTHROPIC_MODEL=claude-sonnet-5
```

⚠️ **Verificado:** `/opt/obs-robo` e `/opt/obs-api` **não** leem esse arquivo.
Alterar `ANTHROPIC_MODEL` ali afeta **somente** o pipeline do orquestrador.

⚠️ `/proc/<pid>/environ` **não** mostra essas variáveis. O `dotenv` injeta em
runtime, depois do `exec`. Para inspecionar o valor efetivo:

```bash
sudo -u obsrobo node -e "require('dotenv').config({path:'/etc/obs-automacao/.env'}); console.log(process.env.ANTHROPIC_MODEL)"
```

---

## 4. Uso da Claude API

Uma única API key no Claude Console: **`obs-cotacoes`**.
Nenhum Agente Gerenciado criado — os modelos vivem no código/env, não no Console.

### Pontos de chamada

| Arquivo | Linha | Modelo (default no código) | Parâmetros |
|---|---|---|---|
| `claude-extrator.js` | 33 | `claude-opus-5` → **sobrescrito pelo .env** | `max_tokens: 4000`, `system: SISTEMA`, `output_config.format = json_schema`, `effort: 'low'` |
| `captar-leads.mjs` | 132 | `claude-haiku-4-5-20251001` | `max_tokens: 1000` |

`effort: 'low'` é aplicado condicionalmente — o Haiku retorna **400** com esse
parâmetro:

```js
if (!/haiku/.test(MODELO)) params.output_config.effort = 'low';
```

**Confirmado em 2026-09-04:** Sonnet 5 aceita `output_config.format` com
`json_schema` **e** `effort: 'low'`. A documentação de structured outputs ainda
não lista Sonnet 5 / Opus 5 entre os suportados — a lista está desatualizada.

### Custo — 30 dias até 2026-09-04

| Modelo | Custo | Papel |
|---|---|---|
| Opus 5 | ~US$ 46 | extrator (constante, ~US$ 1,80/dia) |
| Haiku 4.5 | ~US$ 39 | captar-leads (em rajadas, pico de US$ 7,70/dia) |
| **Total** | **US$ 85,25** | |

Volume: **29,9 mi tokens entrada / 3,7 mi saída**.
Entrada = 82% do custo. Zero uso de cache. Zero web search. Zero code execution.

---

## 5. Hospedagem compartilhada — estrutura

Plano Cloud Startup, expira 2027-03-29. Disco: 12,79 GiB / 100 GiB.
Gerenciador de arquivos em `srv1888-files.hstgr.io` (File Browser).

```
/domains/obstransportes.com.br/
├── public_html/            ← SERVIDO PELA WEB
│   ├── wp-admin/ wp-content/ wp-includes/   ← site principal, NÃO MEXER
│   ├── admin/ api/ lp/                      ← subdomínios
│   ├── adw/ develop/ temporario/            ← legado, ver backlog
│   ├── teste/                               ← WordPress secundário
│   └── wp-config.php .htaccess              ← NÃO MEXER
├── backups-privados/       ← criado 2026-09-04, fora do alcance da web
└── DO_NOT_UPLOAD_HERE      ← marcador da Hostinger: este nível não é servido
```

🔴 **REGRA:** nenhum backup, dump SQL, `.zip` ou `.tar.gz` dentro de
`public_html`. Sempre em `backups-privados/`.

### Conteúdo de `backups-privados/`

| Arquivo | Tamanho | Origem |
|---|---|---|
| `backup-12.29.2025_16-14-54_obstrans.tar.gz` | 10.997.948.623 B | movido 2026-09-04 |
| `.well-known.zip` | 489.937.930 B | movido 2026-09-04 |
| `error_log` | 905 B | movido 2026-09-04 |

Nada foi apagado. A decisão de apagar é do Luiz.

### Pastas legado em `public_html` (auditadas, não movidas)

| Pasta | WordPress? | Última modificação | Tamanho | Conteúdo |
|---|---|---|---|---|
| `temporario/` | não | 2025-12-31 | **0 MB, vazia** | nada |
| `develop/` | não | 2025-11-24 | 2,16 MB · 435 arq. | só `static/` |
| `adw/` | não | 2024-08-01 | 7,63 MB · 107 arq. | site estático Mobirise + `enviar_contato.php` |

---

## 6. Ferramentas de auditoria — receitas prontas

### Testar exposição sem baixar o arquivo

Abrir a URL num navegador **inicia o download**. Para arquivos grandes, use
`HEAD` a partir do console do próprio site (mesma origem, sem CORS):

```js
const r = await fetch('/arquivo.tar.gz', {method:'HEAD', cache:'no-store'});
({status: r.status});
```

`200` = exposto · `403` = protegido · `404` = não existe.

### API do File Browser (Gerenciador de Arquivos da Hostinger)

Muito mais rápido que clicar. Rode no console de uma aba já aberta no
gerenciador — o token vem do `localStorage`:

```js
const tok  = localStorage.getItem('jwt');
const base = location.pathname.split('/files')[0];

// listar um diretório (datas EXATAS, não "há 15 horas")
const res = p => fetch(base+'/api/resources'+encodeURI(p), {headers:{'X-Auth':tok}}).then(r=>r.json());

// busca recursiva — devolve NDJSON, uma linha por resultado
async function busca(p, q){
  const r = await fetch(base+'/api/search'+encodeURI(p)+'?query='+encodeURIComponent(q), {headers:{'X-Auth':tok}});
  const t = await r.text();
  return t.trim().split('\n').filter(Boolean).map(l => JSON.parse(l).path);
}

// mover (rename) — mesma partição, é instantâneo e preserva a data
await fetch(base+'/api/resources'+encodeURI(origem)
  +'?action=rename&destination='+encodeURIComponent(destino)+'&override=false',
  {method:'PATCH', headers:{'X-Auth':tok}});
```

⚠️ `/api/search` responde **NDJSON**, não JSON. `r.json()` devolve só um objeto
e engana — use `r.text()` e faça split por linha.

### Somar tamanho de diretório recursivamente

O botão "Calcular tamanho dos diretórios" da UI nem sempre renderiza. Alternativa:

```js
async function soma(p){
  let bytes=0, arquivos=0, ultimo='';
  for (const i of ((await res(p)).items||[])){
    if (i.isDir){ const s = await soma(p+i.name+'/'); bytes+=s.bytes; arquivos+=s.arquivos; if(s.ultimo>ultimo) ultimo=s.ultimo; }
    else { bytes+=i.size; arquivos++; if(i.modified>ultimo) ultimo=i.modified; }
  }
  return {bytes, arquivos, ultimo};
}
```

### Checklist de invasão em WordPress

1. `wp-config.php` mudou? (primeiro alvo numa invasão)
2. Algum `.php` dentro de `wp-content/uploads/`? (pasta de imagem não tem PHP)
3. Buscar nomes: `shell`, `b374k`, `wso`, `alfa`, `cmd`, `backdoor`, `filesman`,
   `adminer`, `.suspected`
4. **Filtrar falsos positivos** — `shell` e `eval` aparecem em código legítimo:
   `editor-modal-shell` (Elementor), `Text/Diff/Engine/shell.php` (core do WP),
   `EVAL_.php` (Predis/Redis), `ShellExec.php` (webp-express)
5. Assinatura de **auto-update legítimo**: `plugins/`, `upgrade/` e
   `upgrade-temp-backup/` mudando **no mesmo segundo**, de madrugada. É wp-cron,
   não invasor.

---

## 7. Mudanças aplicadas em 2026-09-04

### 7.1 Extrator migrado de Opus 5 para Sonnet 5

```bash
cp /etc/obs-automacao/.env /etc/obs-automacao/.env.bak-2026-09-04
sed -i 's/^ANTHROPIC_MODEL=.*/ANTHROPIC_MODEL=claude-sonnet-5/' /etc/obs-automacao/.env
sudo -u obsrobo pm2 restart obs-automacao --update-env
```

Validado antes de aplicar com uma chamada real de teste (json_schema +
`effort: 'low'` → `{"ok":true}`). Restart às **17:35:37**, sem erro.

**Impacto:** US$ 5/US$ 25 por MTok → US$ 2/US$ 10.
Extrator de ~US$ 46 para **~US$ 18/mês**. Total de **US$ 85 → ~US$ 57/mês**.

**Rollback:**

```bash
cp /etc/obs-automacao/.env.bak-2026-09-04 /etc/obs-automacao/.env
sudo -u obsrobo pm2 restart obs-automacao --update-env
```

**Validar:** `platform.claude.com/cost` agrupado por Modelo — a linha do Opus 5
deve zerar a partir de 05/09.

### 7.2 Três arquivos retirados da pasta pública

Todos verificados com `HEAD` antes (200) e depois (404). Movidos por *rename* na
mesma partição — instantâneo, integridade e data original preservadas.

| Arquivo | Antes | Depois |
|---|---|---|
| `backup-12.29.2025_16-14-54_obstrans.tar.gz` (10,24 GiB) | 200 | **404** |
| `.well-known.zip` (467 MiB) | 200 | **404** |
| `error_log` (905 B) | 200 | **404** |

O backup do WordPress continha banco, `wp-config.php` com senhas e arquivos de
clientes — estava baixável por qualquer um sem autenticação.

Site verificado no ar depois de cada operação.

### 7.3 Auditoria de segurança do `teste/` — sem comprometimento

Motivo: a pasta aparecia modificada "há 15 horas" sem ninguém da equipe ter mexido.

**Resultado: alarme falso.** Foi **auto-update do plugin MonsterInsights**
(`google-analytics-for-wordpress`) às **2026-09-04T06:13:55Z** (03:13 BRT).
Assinatura clássica de wp-cron: `plugins/`, `upgrade/` e `upgrade-temp-backup/`
no mesmo segundo, de madrugada.

Evidências de que **não** houve invasão:

- `teste/wp-config.php` intocado desde **2026-08-01T16:21:09Z**
- Nenhum arquivo na raiz de `teste/` alterado em 48h
- **Um único `.php`** em `wp-content/uploads/`: `mainwp/index.php`, **0 bytes**
  (placeholder anti-listagem)
- Varredura por `shell`/`b374k`/`wso`/`alfa`/`cmd`/`backdoor`/`filesman`/
  `adminer`/`.suspected`: só código legítimo de plugin e do core
- `wp-content/ai1wm-backups/` **vazio** (só `.htaccess`, `index.php`, `web.config`)
- `uploads/` tem `.htaccess` próprio
- **Wordfence instalado e ativo** — `wflogs/` gravando às 15:15 do mesmo dia

### 7.4 Correções aplicadas no VPS (2026-09-05)

Os itens de VPS do backlog anterior foram investigados e corrigidos. Todos estão
versionados na branch `obs-servidor-bootstrap`.

**`captar-leads.mjs` — 24 mi de tokens/mês.** Hipótese do backlog confirmada:
`mensagensCliente()` busca `/messages2/{id}/page/1` (a página inteira do chat) e o
prompt levava **todas** as mensagens, sem janela nem truncamento.
Corrigido com `recortarParaIA()`: o pedido de transporte fica nas primeiras mensagens
(cliente abrindo a conversa) ou nas últimas (voltando a pedir), nunca no miolo — então
vão as duas pontas, com o meio marcado como omitido.

| Conversa | Antes | Depois |
|---|---|---|
| 3 msgs | 59 chars | 59 — passa intacta |
| 15 msgs | 636 chars | 636 — passa intacta |
| 200 msgs | 18.492 chars | **2.183 (−88%)** |
| mensagem gigante | 9.010 chars | **511** (trunca em 500) |

Conversa curta e média não muda de comportamento. Validar na próxima captação pelo
log `✂️ conversa longa: N msgs → enviados N trechos`.

**`obs-api` — 20 restarts.** Eram **duas** causas somadas, ambas visíveis no log:

1. `BadRequestError: request aborted` (cliente fecha a aba no meio do POST) não tinha
   tratador no Express → exceção sem dono → PM2 reiniciava. Agora é tratada pelo que é:
   o outro lado desistiu, não há a quem responder.
2. Todo token que não passava no login próprio ia para o `verifyIdToken` do Firebase e
   voltava `has no "kid" claim` — **um warn por requisição**. Com o polling do app, uma
   aba com sessão vencida despejava centenas de linhas por minuto. ID token do Firebase
   sempre tem `kid` + RS256; o nosso é HS256 sem `kid`, então agora nem tentamos.

Somados: `unhandledRejection`/`uncaughtException` passam a ser registrados sem matar o
processo. **Validado:** 0 restarts, 82 MB (era 532 MB), `grep -c "kid"` no log = 0.

**`servidor-obs/deploy-api.sh` — script que faltava.** App, automação e Conta Azul tinham
deploy próprio; a API era atualizada à mão. Quem rodava só `pm2 restart obs-api`
reiniciava o processo com o código **antigo** de `/opt/obs-api` — a correção parecia
publicada e não estava. O script extrai `servidor-obs/api/` da branch, preserva `.env` e
`node_modules`, só roda `npm` quando o `package.json` muda, confere a sintaxe e reinicia.

**PM2 após reboot — já estava certo.** `/home/obsrobo/.pm2/dump.pm2` existe e
`pm2-obsrobo` está `enabled`. Não havia risco.

**`obs-contaazul` — não chama a Claude API.** Varredura em todo `contaazul/src/`: zero
referência a `anthropic` ou `claude-*`. É integração pura com a API do Conta Azul, fora
do controle de custo.

**A constante `SISTEMA` — o nome está errado no levantamento.** É **`SYSTEM`**, e não vem
de import nenhum: está declarada no próprio `claude-extrator.js`, **linha 89**, como
template literal. **4.737 caracteres ≈ 1.353 tokens** por chamada. Isso reforça a decisão
sobre cache: 1.353 tokens × 45 chamadas/dia é ruído perto dos 24 mi do captar-leads.

---

## 8. Backlog

### P2 — Decidir destino das pastas legado

- `temporario/` — **vazia**, remoção sem risco
- `develop/` — 2,16 MB, só arquivos estáticos, sem uso aparente desde 11/2025
- `adw/` — landing page Mobirise de 2024 com `enviar_contato.php` ativo.
  PHP sem manutenção há 2 anos exposto na web é superfície de ataque gratuita.
  Páginas de agradecimento por vendedor (`-luiz`, `-brenda`, `-leonardo`,
  `-nataly`) sugerem campanha encerrada.

Decisão do Luiz. Se for remover, **mover para `backups-privados/` primeiro**.

### Analisado e descartado — cache de prompt

**Não implementar no volume atual.**

O extrator faz ~45 chamadas/dia — uma a cada ~13 minutos em horário comercial.
O cache padrão expira em **5 minutos** e a escrita custa **1,25x** o input.
Nessa frequência paga-se o write quase sempre e quase nunca se aproveita o read:
sairia **mais caro**.

**Reconsiderar quando:** o volume passar de ~1 chamada a cada 4 minutos
sustentados, ou se o `SISTEMA` for grande o suficiente para justificar cache de
1 hora (write 2x, break-even em 2 leituras).

### Já resolvido — não repetir

- Backup de 10 GB, `.well-known.zip` e `error_log` fora do `public_html` (404)
- Extrator em Sonnet 5
- `teste/` auditada, sem comprometimento
- `.htaccess.bk` / `.nfd-backup` / `.phpupgrader.*` já retornam **403** pela
  regra padrão do Apache (`<FilesMatch "^\.ht">`). **Não precisam de ação.**
- `effort: 'low'` já aplicado no extrator para modelos não-Haiku
- `captar-leads` já no Haiku 4.5, que é o modelo correto para a tarefa
- **Volume do `captar-leads` cortado** (recorte de conversa longa — §7.4)
- **`obs-api` estabilizado** (request aborted + token Firebase — §7.4)
- **PM2 persiste após reboot** — verificado, `enabled`
- **`obs-contaazul` não usa Claude API** · **`SYSTEM` é local ao extrator, linha 89**
- **`mainwp-child` no `teste/`** — o painel MainWP é **da OBS** (confirmado pelo Luiz em
  2026-09-05). Não é acesso de terceiro. Como esse plugin dá controle total do WordPress
  a quem tiver o painel, o cuidado que permanece é com a conta do próprio painel: senha
  forte e 2FA. Se um dia o painel for descontinuado, desativar o `mainwp-child` junto.

---

## 9. Comandos de referência

```bash
# Estado dos processos (SEMPRE como obsrobo)
sudo -u obsrobo pm2 list
sudo -u obsrobo pm2 logs obs-automacao --lines 40 --nostream

# Modelo efetivo
sudo -u obsrobo node -e "require('dotenv').config({path:'/etc/obs-automacao/.env'}); console.log(process.env.ANTHROPIC_MODEL)"

# Localizar chamadas à Claude API (excluindo o SDK)
grep -rn --exclude-dir=node_modules -E "claude-[a-z0-9.-]+|model:|max_tokens" \
  /opt/obs-automacao /opt/obs-robo /opt/obs-contaazul 2>/dev/null \
  | grep -viE "\.md:|\.d\.ts:|\.mts:"

# Serviços systemd
systemctl list-units --type=service --state=running --no-pager
```

### Armadilhas conhecidas

- `pm2 list` **como root retorna vazio** — os processos são do usuário `obsrobo`
- `/proc/<pid>/environ` **não mostra variáveis do dotenv** — injetadas após o `exec`
- `grep -r "claude-"` sem `--exclude-dir=node_modules` retorna centenas de
  falsos positivos: o SDK `@anthropic-ai/sdk` lista todos os modelos já lançados
- Abrir a URL de um arquivo grande **inicia o download** — use `HEAD`
- O File Browser mostra data relativa ("há 15 horas"). Para data exata, leia o
  atributo `datetime` do `<time>` ou use `/api/resources`
- `/api/search` do File Browser responde **NDJSON**, não JSON
- **`pm2 restart obs-api` NÃO publica código novo** — o processo roda de `/opt/obs-api`,
  não do repositório. Use `bash servidor-obs/deploy-api.sh`. Vale o mesmo para os outros
  serviços: cada um tem seu `deploy-*.sh`
- O Chrome traduz nomes de pasta na tela: `themes`→"temas",
  `upgrade`→"atualizar", `wordfence`→"cerca de palavras", `mainwp-child`→
  "mainwp-filho". **Confira sempre pela API, não pelo texto renderizado.**

---

## 10. Referências

- Preços da API: https://platform.claude.com/docs/en/about-claude/pricing
- Structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Custo por modelo: https://platform.claude.com/cost
