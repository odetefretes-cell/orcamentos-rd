# Robô de rotinas da OBS (servidor / VPS)

Sistema **à parte** do backend do Firebase — roda no VPS, 24h, e tira da extensão do
Chrome as rotinas do ChatGuru (começando pela **captação de leads**). Lê o ChatGuru
**raspando a tela** (Playwright), porque a API do ChatGuru só envia, não lê conversas.

> ⚠️ **Aditivo e sem risco:** enquanto este robô é montado/testado, a extensão continua
> funcionando. O robô sobe **desligado / em modo-teste** e só assume quando validado.
> **Não toca** no backend do Firebase (Cloud Functions) nem no app (index.html).

## Requisitos do VPS
- Ubuntu com SSH (root), **Node.js 20+**, **PM2**, **Chromium** (via Playwright).

## Instalar (no VPS, via SSH)
```
cd robo
cp .env.example .env      # preencha os segredos no .env (NUNCA sobe pro GitHub)
npm install
npx playwright install --with-deps chromium
```

## Testar a conexão (seguro — só leitura)
```
node testar-conexao.js
```
Deve imprimir `✅ Firestore OK` e `✅ ChatGuru: Chromium headless OK`.

## Segredos
Ficam **só** no arquivo `.env` do VPS (no `.gitignore`). Nunca no código/GitHub.
Ver `.env.example` para a lista.
