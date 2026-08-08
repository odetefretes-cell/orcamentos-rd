# 📋 Guia do Atendente — Orçamentos Automáticos OBS Transportes

Este guia explica, de forma simples, como funciona a rotina de orçamentos e **o que
você precisa fazer** em cada situação. O sistema ajuda vocês: ele já calcula e envia
a média sozinho na maioria dos casos. Vocês entram nos casos que precisam de gente. 😊

---

## 🟢 Situação 1 — Cliente preencheu o FORMULÁRIO do site

**O que o sistema faz (sozinho):**
- Recebe o pedido, cria o lead no CRM, **calcula a média e ENVIA sozinho** no WhatsApp do cliente.
- O lead aparece no CRM já com um vendedor (rodízio) e o valor médio.

**O que VOCÊ faz:**
- ✅ Nada de imediato — só **acompanhar**.
- Se o cliente **responder que tem interesse**, veja a Situação 4.

---

## 🔵 Situação 2 — Cliente CHAMOU DIRETO (sem formulário)

**O que o sistema faz:**
- Ainda não tem os dados do transporte.

**O que VOCÊ faz:**
1. **Peça as informações** ao cliente: veículo, cidade de origem, cidade de destino,
   valor do veículo, se funciona, se é blindado, se é leilão.
2. Quando o cliente responder com os dados, **acione o botão**:
   > Na conversa → menu **"⋯"** → **"Acionar um diálogo"** → grupo "ChatGuru Integrações"
   > → **"Gerar Orçamento (Backend OBS)"** → **Executar**.
3. Pronto: o sistema **cria o lead e envia a média**. (Se faltar algum dado, ele mesmo pergunta ao cliente.)

---

## 🔴 Situação 3 — Lead que vai para ATENÇÃO HUMANA

**Quando acontece:** valor do veículo **acima de R$ 500 mil**, **sem valor informado**,
**frota** (vários veículos), ou rota **sem preço na tabela**.

**O que o sistema faz:**
- **NÃO** envia a média. Manda ao cliente: *"Recebemos sua solicitação! Um atendente vai
  preparar seu orçamento e retorna em instantes."*
- O lead aparece no CRM marcado com **🔴 atenção humana**.
- Se for **acima de R$ 500 mil**, a mensagem é especial (fala de cuidado e seguro adequado).

**O que VOCÊ faz:**
- 🧑 **Prepare o orçamento manualmente** e responda o cliente. O cliente já foi avisado
  que vocês vão retornar, então é só dar sequência.

---

## 🟡 Situação 4 — Cliente respondeu com INTERESSE (depois da média)

**O que o sistema faz:**
- **Dentro do horário** (seg–sex 9h–18h · sáb 8h–12h): manda a pergunta **/confirmar**
  (🅰️ base a base ou 🅱️ com coleta/entrega) e move o lead para **AGUARDANDO**.
- **Fora do horário:** manda uma mensagem dizendo que retornam no horário comercial.

**O que VOCÊ faz:**
- 📞 **Assuma o AGUARDANDO:** confirme o valor exato. Se o cliente escolher **coleta/entrega**,
  **peça os endereços completos** (o valor muda pelos km). Depois feche o transporte.

---

## ⚡ Resumo rápido

| Situação | O sistema faz | O que VOCÊ faz |
|---|---|---|
| **Formulário do site** | Calcula e envia a média sozinho | Só acompanhar |
| **Chamou direto** | Espera os dados | Pedir infos → clicar em **"Gerar Orçamento"** |
| **Alto valor / sem valor / frota / sem rota** | Avisa o cliente que um atendente vai preparar | Fazer o orçamento **manual** |
| **Cliente com interesse** | Manda /confirmar + AGUARDANDO | Confirmar valor, pedir endereços, fechar |

---

## 🤖 Regras que o sistema já segue (pra vocês saberem)

- **Moto elétrica** → cota como moto 300cc.
- **Leilão / veículo que não funciona / carro + mudança** → manda a média como
  **ESTIMATIVA** (a equipe ajusta o valor final depois).
- **Acima de R$ 500 mil** → não cota automático, manda pra vocês.

---

## 💡 Dicas

- **Não chegou a média num lead do CRM?** Abra o card do lead e clique em
  **"🤖 Enviar automático"** — ele calcula e envia na hora.
- **Horário de atendimento:** seg–sex **9h–18h** · sábado **8h–12h**.
- **O responsável no ChatGuru e no CRM devem ser o mesmo** — ao acionar o orçamento de um
  contato direto, confira/ajuste o "Responsável" da conversa para o mesmo vendedor do CRM.
- Toda média enviada é um **valor de referência** — o valor final é confirmado quando o
  cliente demonstra interesse.

---

*Dúvidas sobre o sistema? Fale com o administrador.*
