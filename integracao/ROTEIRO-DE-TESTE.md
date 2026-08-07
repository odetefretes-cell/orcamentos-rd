# Roteiro de teste — validar a automação de ponta a ponta

Siga na ordem. Cada teste tem **o que fazer**, **o que esperar** e **onde conferir**.
Links úteis:
- Firestore: https://console.firebase.google.com/project/obs-fretes/firestore/data
- Logs das funções: https://console.firebase.google.com/project/obs-fretes/functions/logs

> 💡 A média (Fase A) é calculada pelo **app**. Então, durante os testes, deixe o
> sistema **aberto no navegador, logado como admin** (é o que dispara o cálculo).

---

## Parte 0 — Subir tudo (uma vez)

No **Cloud Shell**:

```
cd ~/orcamentos-rd
git pull origin claude/obs-leads-automation-backend-kaga7q
cd integracao && npm install && cd ..
```

Cadastre os segredos (você já tem esses valores da tela de API do ChatGuru e da
Anthropic):

```
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set CHATGURU_API_KEY
firebase functions:secrets:set CHATGURU_ACCOUNT_ID
firebase functions:secrets:set CHATGURU_PHONE_ID
```

Suba as funções:

```
firebase deploy --only functions
```

✅ **Esperado:** `Deploy complete!` sem erro vermelho. (O envio começa DESLIGADO —
os segredos do ChatGuru só ficam prontos; nada é enviado ainda.)

---

## Parte 1 — Teste A: lead automático normal (o caminho feliz) 🚗

**Fazer:** dispare um lead pelo formulário do site com um carro comum, por ex.:
- Veículo: `Honda Civic 2019` · Valor: `80.000` · Funciona: `Sim` · Blindado: `Não`
- Origem: `São Paulo SP` · Destino: `Belo Horizonte MG`

**Acompanhar (no Firestore):**

1. **Entrada** — `chatguru_webhook_log`: surge um documento com o `raw`.
2. **Acúmulo** — `crm_leads_intake/{telefone}`: aparece com `statusIntake: "recebendo"`.
3. **Fecha (~1–2 min)** — `statusIntake` vira `"completo"` + campo `mensagemCompleta`.
4. **IA decide (segundos depois)** — aparece o campo **`extraido`** (nome, veículo,
   valorVeiculo, origem, destino…) e `statusIntake` vira **`automatico`**.
   Também: `vendedorAtribuido` (o vendedor do rodízio).
5. **Vai pro CRM** — em `crm_leads/lead_wpp_{telefone}`: o lead existe, com
   `vendedor` preenchido (mesmo do rodízio) e sem `respostaPreparada` ainda.
6. **Média (com o app aberto)** — em segundos, o `valorEstimado` é preenchido.
7. **Rascunho** — surge **`respostaPreparada`** com a mensagem no modelo da OBS,
   e `respostaEnviada: false`.

✅ **Validar:** leia o `respostaPreparada`. O **valor** e o **prazo** batem com o
que o sistema mostraria? O texto está certo? O **vendedor** é o esperado?

> Se o `valorEstimado` não aparecer: confirme que o sistema está **aberto no
> navegador** (admin). Sem isso, a média não é calculada nesta fase.

---

## Parte 2 — Teste B: atenção humana (não responde o cliente) 🧑

**Fazer:** dispare um lead com **valor acima de R$ 500.000** (ex.: um veículo de
`600.000`), ou **sem informar valor**.

**Esperar:**
- `crm_leads_intake`: `statusIntake` vira **`aguardando_humano`** (com `extraido.motivo`).
- `crm_leads/lead_wpp_{telefone}`: o lead aparece na coluna **Novo Lead**, com
  `atencaoHumano: true`, `motivoHumano` e um aviso 🔴 na timeline.
- **NÃO** deve existir `respostaPreparada` (nada é preparado nem enviado).

✅ **Validar:** o lead aparece no CRM pra equipe assumir, e **nada foi enviado**.

---

## Parte 3 — Teste C: moto elétrica (orça como 300cc) 🏍️

**Fazer:** dispare um lead com **moto elétrica** (ex.: veículo "moto elétrica X",
valor `20.000`).

**Esperar:**
- `extraido.motoEletrica: true` e `extraido.orcarComo: "moto 300cc"`.
- `statusIntake: "automatico"`.
- Em `crm_leads/...`: `categoria: "Moto até 300cc"` e a média calculada nessa
  categoria.

✅ **Validar:** a categoria ficou "Moto até 300cc" e a média saiu como moto 300cc.

---

## Parte 4 — Ligar o envio e testar com um número SEU 📤

Só depois de validar os rascunhos acima.

**Fazer:**
1. No Firestore, crie/edite o documento **`crm_config/config`** com o campo
   **`envioAtivo`** = `true` (boolean).
2. Dispare um lead de teste usando **um número de WhatsApp SEU** (não um cliente).

**Esperar:**
- Depois do rascunho, o lead recebe **`respostaEnviada: true`** e um
  `chatguruMessageId`.
- A mensagem do orçamento **chega no seu WhatsApp**.

✅ **Validar:** a mensagem chegou certinha no seu número.

> Deu erro? O lead fica com `erroEnvio` (leia a mensagem) e **não** fica em loop.
> Confira os segredos do ChatGuru e os logs da função `prepararResposta`.

**Para desligar de novo:** ponha `envioAtivo` = `false` (ou apague o campo).

---

## Onde ver os logs

Firebase Console → **Functions → Logs**, ou no Cloud Shell:
```
firebase functions:log --only chatguruWebhook,fecharLeadsCompletos,processarLeadCompleto,criarLeadNoCrm,prepararResposta
```
Procure as linhas: `LEAD RECEBIDO`, `... COMPLETO`, `[processarLeadCompleto] ... ->`,
`[criarLeadNoCrm] ...`, `[prepararResposta] ...`.

---

## Checklist rápido

- [ ] Parte 0: deploy sem erro
- [ ] Teste A: rascunho gerado com valor/prazo/vendedor corretos
- [ ] Teste B: atenção humana no CRM, sem resposta
- [ ] Teste C: moto elétrica como 300cc
- [ ] Parte 4: envio real chegou no meu WhatsApp
- [ ] Desliguei o envio de volta (se ainda em validação)
