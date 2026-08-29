# Projeto: Integração Sistema OBS ⇄ OPHOS — Emissão Fiscal Automatizada

> Documento de arquitetura para implementação via Claude Code.
> Escopo: CT-e, CIOT, MDF-e, DC-e via API/Integrador OPHOS + emissão de GNRE com boleto via agente de IA.
> Autor do contexto: operação real da OBS Transportes (emissões manuais feitas hoje no OPHOS Small Business web).

---

## 1. Contexto

**Empresa:** OBS Transportes (Odete Barbosa Santos Transportes, CNPJ 08.165.584/0001-67, IE 635.532.351.110, Simples Nacional). Transporte de veículos via cegonha/guincho, ~90% da operação com prestadores terceirizados (TACs e ETCs), atendimento Brasil inteiro.

**Sistemas atuais:**
- **CRM interno** (`sistema.obstransportes.com.br`) — Kanban de leads + "ficha do frete" (Autorização de Transporte + Contrato). A ficha tem TODOS os dados de negócio: contratante, coleta, entrega, veículo transportado (marca/modelo, placa, chassi, ano, cor, valor), valor do frete, prestadores, observações.
- **OPHOS Small Business** (`apps.ophos.com.br/osb`) — emissor fiscal: CT-e, CIOT (via TruckPad), MDF-e, DC-e. Hoje operado manualmente/via automação de navegador.
- **ChatGuru** — WhatsApp dos clientes.
- **Conta Azul** — financeiro.

**Fluxo hoje (manual, ~15–30 min por frete):** operador pega o nº do frete no CRM → digita tudo de novo no OPHOS → CT-e → conversão p/ CIOT → conversão p/ MDF-e → baixa PDFs → manda pro motorista.

**Objetivo:** o CRM ganha um botão **"Emitir documentação"** que dispara a cadeia inteira via integração, com aprovação humana antes de cada transmissão, e os PDFs voltam anexados ao frete. GNRE entra como etapa nova: quando o CT-e exigir recolhimento estadual, o agente emite a guia e disponibiliza o boleto ao cliente.

---

## 2. Canal de integração com a OPHOS

A OPHOS oferece o **Integrador** (https://www.ophos.com.br/suporte/integrador/): aplicativo Windows que faz a ponte com o sistema do cliente em três formatos:

| Formato | Descrição | Recomendação |
|---|---|---|
| **TXT padrão OPHOS** | Layout posicional por linhas (ex.: linha 023 = CIOT do MDF-e, linha 018 campo 7 = averbação seguradora) | ✅ **Formato principal** — é o mais completo (cobre CIOT e campos de averbação) |
| **XML padrão SEFAZ** | XML do CT-e 4.00 / MDF-e 3.00 | Alternativa p/ CT-e/MDF-e |
| **Web Services** | Endpoint HTTP | Preferir SE cobrir CIOT/DC-e — confirmar com suporte |

⚠️ **AÇÃO INICIAL (bloqueante):** os layouts oficiais baixados pelo Luiz (arquivos de API/manuais do Integrador) devem ser colocados na pasta `docs/ophos-layouts/` deste repositório ANTES de implementar os builders. Todo parser/builder deve ser gerado a partir desses arquivos, não de suposição. Versão atual do Integrador: **5.24** (contempla Reforma Tributária; layout MDF-e TXT 2.08).

**Arquitetura do Integrador:** ele roda numa máquina Windows (ou VM) monitorando pastas de entrada/saída:

```
C:\ophos-integrador\
  ├── entrada\    ← nosso serviço deposita os TXT/XML de emissão
  ├── retorno\    ← OPHOS devolve autorização/rejeição (protocolo, chave de acesso, motivo)
  └── processados\
```

Nosso backend conversa com essas pastas (agente local leve com filesystem watcher + fila HTTP para o backend, ou a própria VM roda o backend).

**Fallback:** enquanto a integração não cobre 100% (ex.: DC-e, downloads de PDF), manter a automação de navegador atual (skill Claude/Chrome) como executor alternativo do mesmo pipeline — a orquestração é a mesma, muda só o "driver".

---

## 3. Arquitetura proposta

```
┌─────────────────────┐
│  CRM OBS (frontend)  │  botão "Emitir documentação do frete Nº X"
└──────────┬──────────┘
           │ REST
┌──────────▼───────────────────────────────────────┐
│  obs-fiscal-service (backend novo — Node/TS)      │
│                                                   │
│  ┌────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ Orquestrador│→│ Builders      │→│ Driver     │ │
│  │ (máquina de │  │ CT-e/CIOT/   │  │ OPHOS      │ │
│  │  estados)   │  │ MDF-e/DC-e   │  │ (TXT/WS)   │ │
│  └────────────┘  └──────────────┘  └───────────┘ │
│  ┌────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ Validador   │  │ Agente GNRE  │  │ Storage    │ │
│  │ (regras §6) │  │ (§8)         │  │ PDFs/XMLs  │ │
│  └────────────┘  └──────────────┘  └───────────┘ │
└──────────┬───────────────────────────┬───────────┘
           │                           │
   ┌───────▼────────┐         ┌────────▼─────────┐
   │ OPHOS Integrador│         │ Portal GNRE /     │
   │ (pasta/WS)      │         │ API fiscal (§8)   │
   └────────────────┘         └──────────────────┘
```

**Stack sugerida:** Node.js + TypeScript, Fastify, fila BullMQ (Redis) para os jobs de emissão, SQLite/Postgres para o estado, storage de PDFs/XMLs em S3-compatível ou pasta sincronizada. Testes com Vitest. (Se o CRM já tiver backend próprio, avaliar embutir como módulo.)

> **Decisão de implementação (29/08/2026):** implementado em **Node.js puro (CommonJS)**,
> sem TS/Fastify/Redis, seguindo o padrão dos serviços já operados na VPS (`contaazul/`,
> `integracao/`). A arquitetura acima permanece; muda só a stack.

### Máquina de estados por frete (entidade `EmissaoFiscal`)

```
RASCUNHO → VALIDADO → CTE_ENVIADO → CTE_AUTORIZADO
        → CIOT_ENVIADO → CIOT_AUTORIZADO
        → MDFE_ENVIADO → MDFE_AUTORIZADO
        → [DCE_ENVIADA → DCE_AUTORIZADA]        (opcional, por pedido)
        → [GNRE_GERADA → GNRE_PAGA]             (quando aplicável, §8)
        → CONCLUIDO
qualquer etapa → REJEITADO(motivo) → correção → reenvio
```

Regra de ouro: **nenhuma transmissão sem aprovação explícita** (humana ou política pré-aprovada por tipo de documento). Documento fiscal é irreversível.

---

## 4. API do obs-fiscal-service (contrato para o CRM)

```
POST /fretes/{numero}/emissao            # inicia: monta payloads a partir da ficha, valida, retorna prévia
GET  /fretes/{numero}/emissao            # estado atual + documentos + pendências
POST /emissao/{id}/aprovar               # aprova a(s) próxima(s) etapa(s): body {etapas:["CTE","CIOT","MDFE"]}
POST /emissao/{id}/corrigir              # aplica correções a um payload rejeitado
GET  /emissao/{id}/documentos            # lista PDFs/XMLs (DACTE, CIOT, DAMDFE, DC-e, GNRE+boleto)
POST /viagens                            # agrupa 2+ fretes na MESMA viagem/placa → 1 MDF-e único
POST /webhooks/ophos-retorno             # (interno) retorno do Integrador: autorizado/rejeitado
```

**Entrada mínima** (o resto vem da ficha do CRM):

```json
{
  "frete": 1702,
  "valorConhecimento": 500.00,
  "viagem": { "fretesAgrupados": [1702, 1703], "rota": "PE X AL X SE X BA X MG X SP" },
  "prestador": { "cpfCnpj": "054.872.944-10", "nome": "DANILO BEZERRA", "rntrc": "054501855",
                 "tipo": "TAC_INDEPENDENTE", "cavalo": "FXY4661", "carreta": "EWL4J60",
                 "motorista": { "cpf": "041.014.426-65", "nome": "AURELIANO SALES DA SILVA" } },
  "averbacoes": [756, 757]
}
```

---

## 5. Pipeline de emissão (a cadeia nasce do CT-e)

1. **Coleta de dados**: `GET ficha do frete` no CRM (nº pode repetir entre ciclos — desambiguar por data mais recente + rota).
2. **CT-e** (um por frete/carga): montar, validar (§6), transmitir, aguardar autorização (chave de acesso 44 dígitos).
3. **CIOT** (um por CT-e — a ANTT permite N CIOTs por viagem): derivar do CT-e autorizado.
4. **MDF-e** (UM por viagem/placa): agrega TODOS os CT-es da viagem. Nunca emitir dois manifestos abertos para a mesma placa/UF de descarga — SEFAZ rejeita (`Existe MDF-e não encerrado para esta placa...`).
5. **DC-e** (sob demanda): declara o conteúdo espelhando o CT-e. ⚠️ módulo hoje **não ativado** na conta OBS (erro `O emissor não foi encontrado no sistema DC-e`, ambiente travado em Homologação) — abrir chamado no suporte OPHOS para credenciar o CNPJ e virar p/ Produção ANTES de implementar.
6. **GNRE** (quando aplicável — §8).
7. **Entrega**: PDFs (DACTE ×N, CIOT ×N, DAMDFE, DC-e, GNRE/boleto) anexados ao frete no CRM + envio opcional ao motorista/cliente via ChatGuru.
8. **Encerramento do MDF-e** ao fim da viagem (job com confirmação do operador de que a entrega ocorreu).

---

## 6. Regras de negócio

Ver **`docs/regras-negocio.md`** (documento vivo — o validador implementa essas regras;
cada aprendizado novo de emissão real entra lá E no validador).

---

## 7. Agente de IA (orquestração)

O agente é a camada entre o operador e o pipeline — não substitui o validador determinístico, complementa:

1. **Intake**: operador escreve no CRM/chat "emitir documentação do frete 1702 e 1703, mesma viagem, R$500 cada" → agente extrai parâmetros, consulta a ficha, monta o plano (quantos CT-es, CIOTs, 1 MDF-e, precisa GNRE?).
2. **Gaps**: se faltar dado (CEP, averbação, prestador, chassi inválido), o agente pergunta UMA vez, com contexto ("a ficha do 1702 é base-a-base sem CEP — uso 00000000?").
3. **Prévia + aprovação**: mostra resumo (valores, rotas, impostos) → operador aprova → pipeline executa.
4. **Tratamento de rejeição**: o agente lê o motivo SEFAZ/OPHOS, cruza com a base de regras do §6 (que vira uma tabela `rejeicao → correção conhecida`) e propõe o conserto; aplica só com aprovação.
5. **Pós-emissão**: anexa PDFs no frete, avisa o operador, dispara mensagens (motorista/cliente) se configurado.

Implementação: Claude API (tool use) com ferramentas = endpoints do §4. Nunca dar ao agente ferramenta de "transmitir sem aprovação".

---

## 8. GNRE + boleto (módulo novo)

**O que é:** a GNRE (Guia Nacional de Recolhimento de Tributos Estaduais) recolhe ICMS devido a outra UF. No transporte, o caso típico da OBS: **CT-e com início de prestação em UF ≠ SP** — várias UFs exigem o ICMS do frete recolhido antecipadamente por guia quando o transportador não tem IE local (mesmo Simples Nacional, conforme a UF).

**Fluxo proposto:**

```
CT-e AUTORIZADO
  → Motor de decisão: precisa GNRE?
      inputs: UF início da prestação, UF do emitente, IE nas UFs, regime (Simples),
              tabela por-UF (receita/código, alíquota, base = valor do frete, FECP)
  → SIM: gerar GNRE → obter guia PDF com código de barras ("boleto")
  → anexar ao frete + enviar ao pagador (operador/cliente) via ChatGuru/e-mail
  → registrar vencimento + status de pagamento (conciliar depois no Conta Azul)
```

**Caminhos de implementação (decidir na fase 0):**

| Opção | Como | Prós/Contras |
|---|---|---|
| A. **OPHOS** | Verificar com o suporte se o OSB/Integrador emite GNRE vinculada ao CT-e | Melhor se existir — mesma credencial; PODE não existir |
| B. **Webservice oficial GNRE** (www.gnre.pe.gov.br, API v2 XML) | Integração direta com certificado digital A1 da OBS | Gratuito e oficial; exige certificado A1 no backend + layout XML por UF (chato, mas estável) |
| C. **API fiscal de terceiro** (TecnoSpeed, Migrate, Focus etc.) | REST simples por cima do portal GNRE | Rápido de integrar; custo por guia |

Recomendação: perguntar A ao suporte OPHOS; em paralelo, prototipar B (o certificado A1 da empresa já existe para o e-CNPJ). A tabela de configuração por UF (`uf, codigoReceita, aliquota, exigeGnre(bool), detalhamentos`) fica editável no CRM — regra estadual muda.

**Papel do agente:** classifica a necessidade da guia por CT-e, preenche, mostra prévia do cálculo (base × alíquota), gera após aprovação e cobra o pagamento antes do embarque quando a UF exigir GNRE paga acompanhando o DACTE.

⚠️ Nota: "boleto" aqui = a própria guia GNRE com código de barras (paga em qualquer banco). Se a intenção for também repassar o custo ao cliente via boleto bancário próprio, isso é integração com o Conta Azul (cobrança) — módulo separado, fase 4.

---

## 9. Fases do projeto

| Fase | Entrega | Duração estimada |
|---|---|---|
| **0. Fundação** | Chamado OPHOS (WS? GNRE? DC-e? homologação?); VM do Integrador instalada; layouts em `docs/ophos-layouts/`; certificado A1 disponível; repo + CI | 1 semana |
| **1. CT-e** | Builder TXT/XML do CT-e + validador §6 + envio/retorno via Integrador em **homologação** → produção assistida (prévia + aprovação) | 2–3 semanas |
| **2. CIOT + MDF-e** | Conversão automática, viagem multi-CT-e, averbação sequencial, encerramento de MDF-e | 2–3 semanas |
| **3. Agente + PDFs** | Agente de orquestração no CRM, anexo automático de PDFs, envio ChatGuru | 2 semanas |
| **4. GNRE** | Motor de decisão por UF + emissão (opção escolhida na fase 0) + guia no frete + controle de pagamento | 2–3 semanas |
| **5. DC-e** | Após ativação do módulo pelo suporte | 1 semana |

Critério de corte por fase: 10 emissões reais consecutivas sem intervenção manual (além da aprovação).

---

## 10. Riscos e pontos abertos

1. **Formato exato da API OPHOS** — bloqueador nº 1. Os layouts baixados precisam entrar no repo; sem eles, só a automação de navegador funciona.
2. **CIOT via Integrador** — confirmar se o TXT cobre a requisição TruckPad completa (trecho, contratantes adicionais, veículos) ou se CIOT continua só via tela. Se só via tela → manter driver de navegador para o CIOT.
3. **DC-e não credenciada** (suporte OPHOS) e **credencial TruckPad** (`Missing 2fa check` já ocorreu — reautorização é com o suporte).
4. **Sequência de averbação** compartilhada com emissões manuais → migrar contador para o CRM e proibir emissão manual sem registrar.
5. **Cadastros sujos no OPHOS** (proprietários de veículo errados) → cadastro de prestadores/veículos no CRM vira fonte da verdade e o payload sempre sobrescreve.
6. **GNRE por UF** é legislação viva → tabela configurável + revisão contábil trimestral.
7. **Certificado A1** no backend = segredo crítico (vault/KMS, nunca em repo).
8. **Ambiente de homologação** para TUDO antes de produção (o Integrador tem ambiente de homologação — usar).

---

## 11. Estrutura de repositório

```
obs-fiscal-service/
├── docs/
│   ├── ophos-layouts/          ← ARQUIVOS DA API OPHOS (colocar aqui)
│   ├── regras-negocio.md       ← §6 deste doc, mantido vivo
│   └── gnre-por-uf.md
├── src/
│   ├── api/                    (rotas §4)
│   ├── domain/                 (EmissaoFiscal, Viagem, Frete, ContadorAverbacao)
│   ├── builders/               (cte, ciot, mdfe, dce, gnre)
│   ├── validators/             (regras §6 como funções puras + testes)
│   ├── drivers/
│   │   ├── ophos-integrador/   (TXT in/out, watcher de retorno)
│   │   ├── ophos-browser/      (fallback: automação atual)
│   │   └── gnre/               (opção A/B/C)
│   ├── agent/                  (tools p/ Claude API, prompts, política de aprovação)
│   └── workers/                (fila de emissão, watcher de retorno, encerramento MDF-e)
├── test/
│   └── fixtures/               (fretes reais anonimizados: 1702/1703 como caso multi-CT-e)
└── README.md
```
