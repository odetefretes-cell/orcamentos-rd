# Integração OBS Transportes × Conta Azul (backend em Node.js)

Backend que liga o **sistema OBS** ao **Conta Azul Pro** (API v2) por código, no
lugar da automação de navegador. Ele:

- registra a **venda** do frete (receita), com as parcelas conforme a forma de pagamento;
- lança a **despesa** do prestador, com **trava de duplicidade** (placa+frete) e
  **reconciliação** do retorno assíncrono (202) do Conta Azul;
- guarda e renova sozinho o token de acesso (OAuth2), e expõe rotas simples que o
  site do OBS chama.

O pagamento em si (aprovação do PIX) continua no app **CA de Bolso** — o backend
deixa a despesa pronta, como manda a regra da OBS.

> **Fluxo visual:** veja o artefato "Como funciona a integração OBS ↔ Conta Azul".

---

## Arquitetura em uma linha

```
Site OBS (Hostinger)  ──HTTPS + X-OBS-Secret──►  este backend (Node, mesmo VPS)  ──OAuth2──►  Conta Azul API v2
```

O backend fica no **mesmo VPS Hostinger** do sistema, num subdomínio
(ex.: `api.obstransportes.com.br`). O banco é SQLite num arquivo — no VPS o disco
é persistente, então o `refresh_token` fica seguro.

---

## Pré-requisitos

- **VPS Hostinger** com acesso SSH (Ubuntu/Debian).
- **Node.js 20+** e **npm**.
- Conta **Conta Azul Pro** ativa (a API exige Pro).
- Um **app de produção** no portal de desenvolvedores do Conta Azul (ver abaixo).
- Um subdomínio apontando para o VPS (ex.: `api.obstransportes.com.br`).

---

## Passo 1 — Preparar o Conta Azul

1. **Cadastre os 2 serviços** (a API exige serviço, não aceita texto livre):
   `Serviços > Cadastros > Serviços > Novo serviço` — crie
   `Transporte de veículo - cegonha` e `Transporte de veículo - guincho`.
   Marque tipo **Prestado** (ou ambos), nunca só "Tomado". Anote os **UUIDs**.
2. **Crie o app de PRODUÇÃO** no portal de desenvolvedores. Na URL de
   redirecionamento coloque **exatamente**:
   `https://api.obstransportes.com.br/oauth/callback` (sem barra no fim).
   Guarde **Client ID** e **Client Secret** no gerenciador de senhas.
3. Confirme que as categorias existem na conta: `Fretes recebidos` (receita) e
   `Materiais Aplicados na Prestação de Serviços` (despesa). A API **não cria**
   categoria.

## Passo 2 — Instalar no VPS

```bash
sudo mkdir -p /var/www/obs-ca && sudo chown $USER /var/www/obs-ca
cd /var/www/obs-ca
git clone <seu-repo> .      # ou envie os arquivos por scp
npm ci --omit=dev
cp .env.example .env
nano .env                   # preencha (ver .env.example)
mkdir -p data               # onde fica o SQLite (DB_PATH aponta pra cá)
```

Preencha no `.env`: `OBS_SHARED_SECRET` (invente um longo), `CA_CLIENT_ID`,
`CA_CLIENT_SECRET`, `CA_REDIRECT_URI`, `SERVICE_CEGONHA_ID`, `SERVICE_GUINCHO_ID`,
`OBS_ORIGIN` (o domínio do site).

## Passo 3 — Rodar como serviço (PM2)

```bash
sudo npm i -g pm2
pm2 start src/server.js --name obs-ca
pm2 save && pm2 startup      # sobe sozinho no boot do VPS
pm2 logs obs-ca              # acompanhar
```

## Passo 4 — Nginx + HTTPS no subdomínio

`/etc/nginx/sites-available/api.obstransportes.com.br`:

```nginx
server {
  server_name api.obstransportes.com.br;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/api.obstransportes.com.br /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.obstransportes.com.br   # TLS grátis (Let's Encrypt)
```

## Passo 5 — Conectar o Conta Azul (uma vez)

Abra no navegador: `https://api.obstransportes.com.br/oauth/start`
Faça login no Conta Azul **real**, informe o 2FA, autorize. Vai aparecer
"✅ Conta Azul conectado". Confira em `/oauth/status`.

> Não deixe a integração parada **mais de 2 semanas** — o refresh token do Conta
> Azul expira nesse prazo. No uso diário isso não acontece.

## Passo 6 — Ligar o site do OBS

No sistema (que já está na Hostinger), use o cliente de `obs-client/obs-integration.js`.
No botão **"Registrar no Conta Azul"** da fila de receita, chame `registrarVenda(...)`;
no botão **"Lançar no Conta Azul"** da fila de prestador, chame `lancarDespesa(...)`.
O contrato dos campos está em `src/domain/mapVenda.js` e `src/domain/mapDespesa.js`.

> **Segredo:** o ideal é o próprio site (backend do VPS) injetar o `X-OBS-Secret`,
> para não expor o segredo no JavaScript público. Se chamar direto do front, trate
> o segredo como "senha de porta": CORS restrito ao seu domínio e troca periódica.

---

## Endpoints

| Método | Rota | Para quê |
|---|---|---|
| GET | `/health` | ping |
| GET | `/oauth/start` | conectar a conta (navegador) |
| GET | `/oauth/callback` | retorno do Conta Azul |
| GET | `/oauth/status` | está conectado? quando renova? |
| POST | `/obs/venda` | registrar a venda do frete (receita) |
| POST | `/obs/despesa` | lançar a despesa do prestador |
| GET | `/obs/status?frete=NNNN` | o que já foi lançado para um frete |

As rotas `/obs/*` exigem o header `X-OBS-Secret`.

### Exemplo — venda
```json
POST /obs/venda
{ "frete": 1523, "modal": "cegonha", "valor": 1200, "formaPagamento": "PIX_50_50",
  "previsaoChegada": "2026-08-30",
  "cliente": { "nome": "Fulano", "documento": "12345678000199" },
  "origem": "SP", "destino": "BA", "veiculo": "Fox", "placa": "JWD8986" }
```

### Exemplo — despesa (com cobrança consolidada)
```json
POST /obs/despesa
{ "prestador": { "nome": "Sonia Maria", "documento": "10818549000141" },
  "valor": 750, "pixKey": "+5588996959745",
  "itens": [ { "frete": 1333, "placa": "EHY8E86" }, { "frete": 1489, "placa": "SNY5E24" } ] }
```
Se algum par placa+frete já foi lançado, responde **409** com os conflitos. Para
lançar mesmo assim (confirmação explícita), reenvie com `"forcar": true`.

---

## Testes

```bash
npm test          # 20 testes: mapeadores, ledger/duplicidade, tokens e ponta a ponta
npm run mock-ca   # sobe um Conta Azul falso em http://localhost:4010 para testar local
```

O teste ponta a ponta sobe o app real contra o mock — não toca na conta real.

---

## Cuidados importantes

- **Banco em disco persistente.** `DB_PATH` tem que ficar num caminho fixo do VPS
  (ex.: `/var/www/obs-ca/data/obs-ca.db`) e entrar no backup. Perder o arquivo =
  perder o `refresh_token` = refazer o login.
- **Campos a confirmar na API.** Alguns nomes de campo do Conta Azul (condição de
  pagamento, id do fornecedor na conta a pagar, filtro por código de referência)
  estão marcados com `⚠️ VERIFICAR` no código. Rode primeiro na **conta de teste**
  (sandbox) do portal e ajuste num lugar só (os arquivos em `src/domain` e
  `src/contaazul`). Ver `docs/ARQUITETURA.md`.
- **Ordem recomendada:** primeiro os ajustes de processo no OBS (campo "valor
  contratado", categoria única, fila visível, trava na tela); a integração entra
  depois, para tirar a digitação.
