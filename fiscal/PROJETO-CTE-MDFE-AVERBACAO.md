# OBS Transportes — Projeto: Módulo Fiscal Operacional (CT-e + MDF-e + Averbação)

Plano e pesquisa para incluir no sistema (setor operacional) a emissão de CT-e/MDF-e e a
averbação automática na apólice de seguro. Data: **22/08/2026**. Base: CLAUDE.md atualizado
(arquitetura VPS Hostinger, §0) + respostas do Luiz (emissão hoje em sistema terceiro,
apólice ativa, preferência por integração via API, volume 50–200 embarques/mês).

---

## 1. Por que agora (contexto regulatório)

- **Desde 10/03/2026 a ANTT fiscaliza eletronicamente os seguros obrigatórios** do
  transporte de cargas (Lei 14.599/2023, Resolução ANTT 6.068/2025, Portaria SUROC 27/2025).
  A verificação cruza automaticamente CT-e emitido × apólice/averbação. CT-e sem averbação
  correspondente vira exposição direta a autuação — além de viagem sem cobertura em sinistro.
- A Lei 14.599/2023 tornou obrigatórios **três seguros**: RCTR-C (danos à carga por
  acidente), RC-DC (desaparecimento/roubo de carga) e RC-V (danos a terceiros pelo veículo).
  Vale conferir com a corretora se a apólice atual da OBS cobre os três.
- Emissão hoje em sistema terceiro, desconectada do CRM: retrabalho do operador e risco de
  frete embarcado sem documento ou sem averbação. Integrar ao sistema próprio fecha esse buraco.

## 2. O que a regra diz para o modelo da OBS (90% terceirizado)

**CT-e** — a OBS, como transportadora contratada pelo cliente, **emite o CT-e "normal"**
(tomador = cliente) em todo frete, mesmo quando terceiriza a execução. O prestador
(subcontratado) emite o **CT-e de subcontratação** referenciando a chave do CT-e da OBS —
documento dele, não nosso. Atenção: na subcontratação, o **ICMS da prestação subcontratada
é responsabilidade da contratante (OBS)** na maioria das UFs — parametrizar com o contador.

**MDF-e** — é emitido por **quem executa o transporte** (quem tem veículo, motorista e
carga em trânsito). Nos fretes terceirizados, **o MDF-e é do prestador**, não da OBS.
A OBS só emite MDF-e nos fretes com **veículo próprio** (~10% da operação). Isso reduz
muito o escopo do módulo: MDF-e vira função secundária, não o centro do projeto.

**Averbação** — quem emite o CT-e averba na sua apólice: **todo CT-e da OBS deve ser
averbado**, terceirizado ou não. Na subcontratação de TAC (autônomo), a lei ainda prevê
que a **contratante contrate o seguro por viagem em nome do TAC** (RC-V em especial) —
ponto a validar com a corretora, pois impacta o custo por frete terceirizado com autônomo.

## 3. Possibilidades pesquisadas

### 3a. Emissão — API integrada ao sistema (caminho escolhido)

| Opção | O que é | Preço pesquisado |
|---|---|---|
| **Focus NFe** (recomendada) | API REST de CT-e/CT-e OS/MDF-e (+ NFe etc.), webhooks, armazenamento dos XML, sem fidelidade/setup, 30 dias grátis | **Solo R$ 89,90/mês** (1 CNPJ, 100 notas, R$ 0,10/nota adicional); Start R$ 113,90 (3 CNPJs) |
| TecnoSpeed PlugDFe/PlugNotas | API REST consolidada, foco em software houses | sob consulta |
| Webmania | API unificada NFe/CTe/MDFe | sob consulta |
| IntegraNotas | API de documentos fiscais | sob consulta |
| ~~Nuvem Fiscal~~ | API semelhante à Focus | **descartar** — resultado de busca indica encerramento do serviço em 31/07/2026 (confirmar antes de considerar) |

Com 50–200 embarques/mês, cada embarque gera ~1 CT-e (+ eventos e MDF-e próprios):
o plano Solo cobre a maior parte dos meses; pico de 200 docs ≈ R$ 89,90 + ~R$ 10 de
adicionais. **Custo fiscal estimado: R$ 90–120/mês.**

Requisito técnico da Focus: **certificado digital e-CNPJ modelo A1** (o A3 de cartão não
serve para API em nuvem).

### 3b. Emissão — sistema pronto sem integração (plano B)

Manter um emissor de mercado (como o atual). Custo parecido, zero desenvolvimento, mas
continua o retrabalho (redigitar dados que já estão no CRM) e sem gancho para averbação
automática e cobrança/DACTE no fluxo do ChatGuru. Só faz sentido se o desenvolvimento
interno travar.

### 3c. Averbação — como automatizar

O fluxo padrão do mercado: **CT-e autorizado na SEFAZ → XML enviado à averbadora →
averbadora declara à seguradora → nº de averbação retorna**. Três caminhos:

1. **AT&M (atmtec.com.br)** — averbadora mais usada; integração por **webservice (WS 2.0)**,
   envio de XML automático em tempo real. Requer usuário/senha/código ATM vinculados à
   apólice. Custo geralmente incluído na relação seguradora/corretora.
2. **Averbadora própria da seguradora** (portal/API próprio) — depende de quem é a
   seguradora da apólice da OBS.
3. **Averbação automática total** — algumas seguradoras capturam os CT-e direto da SEFAZ
   sem envio (averbação "embutida"). Se a apólice da OBS já for assim, o módulo só precisa
   **conferir e registrar** o nº de averbação, não enviar.

**Primeira ação do projeto: perguntar à corretora qual é a averbadora da apólice e se há
webservice.** Isso define o conector a construir.

## 4. Arquitetura proposta (mesmo padrão do Conta Azul — CLAUDE.md §11.8)

Novo serviço **`obs-fiscal`** na VPS (porta **3003**, systemd, pasta `fiscal/`):

```
index.html (Operacional)                    VPS
┌─────────────────────┐    JWT     ┌──────────────────┐  X-OBS-Secret  ┌───────────────┐
│ 🧾 Emitir CT-e      │──────────▶│ obs-api (:3000)   │──────────────▶│ obs-fiscal    │
│ 🚚 Emitir MDF-e     │           │ proxy /api/fiscal/*│               │ (:3003)       │
│ 🛡 Status averbação │◀──────────│                   │◀──────────────│               │
└─────────────────────┘           └──────────────────┘                └──┬─────────┬──┘
                                                                         │         │
                                                              Focus NFe API     AT&M WS
                                                              (CT-e/MDF-e)     (averbação)
```

- **Emissão:** `obs-fiscal` monta o JSON do CT-e a partir do lead/frete já existente no
  Postgres (cliente, origem/destino, veículo, valor — dados que o CRM já tem) e chama a
  Focus NFe. Webhook da Focus confirma autorização e devolve XML + DACTE (PDF).
- **Averbação:** ao receber o webhook de "autorizado", o serviço envia o XML à averbadora
  (AT&M WS ou equivalente) e grava o nº de averbação no frete. Falha de averbação gera
  alerta (e-mail/ChatGuru interno) — frete não embarca sem averbação.
- **Dados:** tabela nova `fiscal_docs (id, frete_id, tipo, chave, status, num_averbacao,
  xml_url, pdf_url, data jsonb, updated_at)` no Postgres `obs`.
- **Segredos:** `/etc/obs-fiscal/.env` (token Focus, credenciais averbadora,
  `OBS_SHARED_SECRET`); certificado A1 (.pfx) fica na Focus, não na VPS.
- **UI (setor operacional do `index.html`):** no card do frete liberado ao operacional,
  bloco "Fiscal": botão **Emitir CT-e** (pré-preenchido, operador só confere), status
  (autorizado/averbado com nº), link DACTE para mandar ao cliente/prestador pelo ChatGuru
  (reuso do `/api/chatguru/enviar`), botão **Emitir MDF-e** só quando veículo próprio,
  e **Cancelar/Carta de Correção** (eventos da própria API).

## 5. Pré-requisitos (Fase 0 — levantamento)

1. **Certificado e-CNPJ A1** da OBS (~R$ 150–250/ano). Se hoje só existe A3, emitir um A1.
2. **Inscrição Estadual ativa** e credenciamento como emissor de CT-e na SEFAZ da UF
   (homologação + produção) — normalmente o contador resolve.
3. **RNTRC ativo** na ANTT (já deve existir).
4. **Parametrização fiscal com o contador:** CFOP por tipo de prestação, regime/alíquota
   de ICMS por UF de início da prestação, tratamento do ICMS na subcontratação, série do
   CT-e ao migrar do sistema terceiro (continuar numeração ou abrir série nova).
5. **Dados da apólice com a corretora:** seguradora, nº da apólice, averbadora usada,
   credenciais de webservice, cobertura RCTR-C/RC-DC/RC-V, regra para subcontratação de TAC.
6. Descobrir **qual sistema terceiro** emite hoje (exportar XMLs históricos e numeração).

## 6. Fases do projeto

| Fase | Entrega | Duração estimada |
|---|---|---|
| **0 — Levantamento** | Itens da §5 + conta teste Focus NFe (30 dias grátis) | 1 semana (depende de contador/corretora) |
| **1 — Homologação** | `obs-fiscal` no ar; CT-e de teste autorizado em homologação a partir de um frete real do CRM; tabela `fiscal_docs` | 1–2 semanas |
| **2 — CT-e em produção** | Botão no operacional; emissão assistida em paralelo ao sistema terceiro; DACTE pelo ChatGuru | 1–2 semanas |
| **3 — Averbação automática** | Conector averbadora + nº de averbação no frete + alerta de falha + relatório diário "emitido × averbado" | 1–2 semanas |
| **4 — MDF-e (frota própria)** | Emissão + encerramento de MDF-e; contingência (SVC) documentada | 1 semana |
| **5 — Corte** | Desligar sistema terceiro; conciliar `fiscal_docs` × vendas do Conta Azul (frete faturado sem CT-e e vice-versa) | contínuo |

Regra de corte da Fase 2→5: um mês fechado com 100% dos CT-e emitidos pelo sistema novo,
batendo com o emissor antigo, e o contador validando os impostos.

## 7. Custos recorrentes estimados

| Item | Estimativa |
|---|---|
| API Focus NFe (Solo) | R$ 89,90–120/mês |
| Certificado A1 | ~R$ 200/ano |
| Averbadora (AT&M ou similar) | geralmente sem custo direto p/ transportadora (via seguradora) — confirmar |
| Infra | zero adicional (mesma VPS) |
| **Total** | **≈ R$ 110/mês** + o que já se paga de apólice |

Compensação: cancelamento da mensalidade do emissor terceiro atual.

## 8. Riscos e mitigação

- **Parametrização fiscal errada (ICMS/CFOP)** → multa. Mitigação: contador valida cada
  cenário em homologação antes de produção; Fase 2 roda em paralelo com o emissor atual.
- **CT-e sem averbação** → sem cobertura + fiscalização eletrônica ANTT. Mitigação:
  averbação disparada por webhook (não depende de gente) + relatório diário de pendências
  + trava visual "não embarcar sem averbação" no card.
- **Certificado A1 vencido** → emissão para. Mitigação: alerta automático 30 dias antes.
- **SEFAZ fora do ar** → emissão em contingência (a Focus trata SVC); documentar no runbook.
- **Subcontratação de TAC sem seguro por viagem (RC-V)** → passivo regulatório. Mitigação:
  resposta formal da corretora na Fase 0; se necessário, incluir averbação por viagem do
  TAC no fluxo.

## 9. Decisões pendentes (para o Luiz responder na Fase 0)

1. Qual o sistema/emissor terceiro atual (nome, e se exporta XML/numeração)?
2. Seguradora e averbadora da apólice — pedir à corretora o manual de integração.
3. UF da Inscrição Estadual emitente (define a SEFAZ e as regras de ICMS).
4. O contador topa validar a homologação (quem parametriza CFOP/impostos)?

---

## Fontes

- [Focus NFe — Planos e preços](https://focusnfe.com.br/precos/) · [API CT-e](https://focusnfe.com.br/produtos/conhecimento-transporte-eletronico-cte/)
- [SimplesCTe — Transportador subcontratado: CT-e, MDF-e e ICMS](https://simplescte.com.br/blog/transportador-subcontratado-como-fica-o-cte-mdfe-e-o-icms/) · [CT-e de subcontratação](https://simplescte.com.br/blog/cte-de-subcontratacao-o-que-e-quando-emitir/)
- [Mutuus — AT&M Averbação](https://www.mutuus.net/blog/atm-averbacao/) · [Averbação de cargas](https://www.mutuus.net/blog/averbacao-de-cargas-o-que-e/) · [Lei 14.599](https://www.mutuus.net/blog/entendendo-a-lei-14599/)
- [AT&M — Averbação eletrônica CT-e/NF-e](https://ww2.atmtec.com.br/downloads/averbacao-eletronica-cte-nfe/)
- [SETCEPAR — Fiscalização eletrônica dos seguros a partir de 10/03/2026](https://setcepar.com.br/comunicacao/seguros-obrigatorios-antt-ficalizacao-eletronica-a-partir-de-10-de-marco-de-2026)
- [ANTT — Integração nacional p/ verificação automática dos seguros](https://www.gov.br/antt/pt-br/assuntos/ultimas-noticias/antt-inicia-integracao-nacional-para-verificacao-automatica-dos-seguros-obrigatorios-do-transporte-de-cargas)
- [SUSEP — Norma do RC-V](https://www.gov.br/susep/pt-br/central-de-conteudos/noticias/2024/dezembro/publicada-norma-sobre-o-seguro-de-responsabilidade-civil-de-veiculo-rc-v-do-transportador-de-cargas)
- [Coelho & Dalle — Seguros obrigatórios: Lei 14.599 e Res. SUSEP 51/2025](https://coelhodalle.com.br/seguros-obrigatorios-no-transporte-de-cargas-o-que-mudou-com-a-lei-14-599-2023-e-a-resolucao-susep-51-2025/)
