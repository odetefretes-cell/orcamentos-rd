# Regras de negócio da emissão fiscal (§6 — documento VIVO)

Regras vindas de dezenas de emissões reais no OPHOS. O validador (`src/validators/`)
implementa cada uma antes de qualquer transmissão. **Toda regra nova aprendida em
emissão real entra AQUI e no validador, no mesmo commit.**

## CT-e

- **CFOP 6932** na entrada; para tomador não-contribuinte o OPHOS regrava como **6357** — comportamento esperado, não é erro.
- Série **001**. Tomador = Remetente. Forma de pagamento = À Pagar. Tipo serviço Normal.
- Pessoa física: Segmento **Não Contribuinte** + Tipo ICMS tomador **Não contribuinte**.
- Endereço: prevalece o da FICHA sobre o resolvido por CEP (CEP resolve errado com frequência). Número ausente → `SN`. Fretes base-a-base: logradouro/bairro `BASE`; **CEP ausente → `00000000`** (decisão do Luiz, 29/08/2026).
- Carga: valor = valor do veículo; produto predominante `VEICULO`; NCM predominante vazio; quantidade `1 UNIDADE / UN`.
- Bloco **Veículo Novo**: chassi (17 chars exatos — se a ficha trouxer spec de bateria tipo `60V45AH6A`, perguntar ao operador; padrão autorizado = completar com zeros à esquerda), nr. cor `01`, descrição da cor, modelo **sem espaço no final** (espaço final = rejeição `cvc-pattern-valid`), valor unitário, valor do frete.
- Documento do remetente obrigatório: tipo **Outros/Declaração**, nº = nº do frete, valor = valor da carga (documento vazio bloqueia o salvamento).
- Impostos: componente `FRETE` compõe BC → calcular imposto → **Situação Tributária = Simples Nacional por último** (o cálculo reverte a ST se feito depois).
- Aba Rodoviário do CT-e: **vazia** (cavalo/carreta/motorista entram só no MDF-e).

## CIOT (provedor TruckPad, via OPHOS)

- **Sempre derivado do CT-e** (conversão). CIOT criado do zero trava com `O bairro do destinatário não foi informado`.
- Tipo de operação: **Sou Contratante** (a OBS contrata o prestador). Autenticação: **dados do contratante**.
- **Valor da operação = valor do CT-e − R$ 100,00** (margem OBS). Parametrizável.
- Tipo de viagem: **Carga Fracionada**. Data fim = emissão + 10 dias. **NCM `8703` (4 dígitos — o campo é varchar(4)!)**. Peso 1.000 kg. Tipo de carga: Carga Geral.
- Contratado: CNPJ/CPF, nome e **RNTRC sem zero à esquerda** (054501855 → `54501855`).
- Trecho: município de coleta REAL → município de entrega (⚠️ não usar o endereço de faturamento — bug já ocorrido: saiu Olinda em vez de Jaboatão). Roteirizar. Veículos (cavalo 3 eixos, carreta 2) e motorista (CPF + nome).
- Valores: pagamento formal Banco `341` / Ag `8866` / CC `158820`; CPF/CNPJ do proprietário = o do contratado.
- **Carga fracionada: o tomador do CT-e entra SEMPRE como contratante adicional** (aba Contratantes). Sem isso o CIOT volta com erro.
- CIOT autorizado retorna nº de 12 dígitos (ex.: 520026376913).

## MDF-e

- Série **002**. Tipo de emitente: Prestador de serviço de transporte. **Tipo de transportador: ETC** (⚠️ o OPHOS reseta para TAC a cada recarga da tela — no Integrador, garantir no payload; em navegador, conferir por último).
- **Percurso**: UFs intermediárias da rota, em ordem (rota `PE X AL X SE X BA X MG X SP` → percurso `AL, SE, BA, MG`; origem e destino não entram). Sem percurso = rejeição.
- **NCM completo `87032310`** (diferente do CIOT!). Peso bruto por documento: 1.000 kg.
- Veículo: cavalo (Cavalo mecânico / Não aplicável / Terceiro); reboque (Aberta / Terceiro; se placa não cadastrada, preencher tara 1000, cap. 1000 kg / 100 m³). Proprietário dos dois: dados do prestador, IE `ISENTO`, tipo **TAC Independente** (padrão do sistema vem "TAC Agregado" — trocar; confirmado pelo Luiz p/ Danilo Bezerra). ⚠️ conferir proprietário contra CRLV — cadastros do OPHOS têm dados errados (ex.: FQP2A33 traz proprietário de outra empresa).
- Motorista: CPF + nome (não autopreenche).
- Pagamento: Info. Pagamento com **valor contrato = SOMA dos CIOTs da viagem**, componente FRETE de mesmo valor, À vista, **Indicador Alto Desempenho = Não** (obrigatório), banco 341/8866/158820.
- **CIOT no MDF-e: o OPHOS aceita SÓ UM** (tentativas de adicionar 2º são ignoradas silenciosamente). Vincular um; os demais permanecem válidos na ANTT — layout TXT linha 023, verificar se via Integrador aceita N.
- **Seguro/Averbação**: apólice Allianz `517720243Y540000497` já cadastrada; incluir **um nº de averbação POR CARGA, ANTES de transmitir** (depois de autorizado não entra mais). Sequencial de averbação: manter contador no NOSSO sistema (fonte da verdade), hoje em **757**. ⚠️ nunca confiar em lista filtrada do OPHOS para descobrir o último.
- MDF-e com CT-es de UFs de início diferentes: conversão conjunta falha — montar a partir de um CT-e e incluir os demais pela chave de acesso (44 dígitos) no descarregamento.
- **Encerramento**: declarar fim de viagem só com confirmação de entrega. Monitorar MDF-es `Autorizado` sem Data Evento > 5 dias (SEFAZ bloqueia novas emissões da placa).

## DC-e

- Série própria `001` (criar uma única vez — numeração fiscal permanente, exige OK do operador).
- Item obrigatoriamente vinculado a produto do catálogo (`VEICULO / VEICULO AUTOMOTOR / NCM 87032310 / UN`) — descrição digitada à mão NÃO persiste.
- Destinatário = endereço de ENTREGA do CT-e. Observação: referência ao CT-e/frete/chassi.
- Pré-requisito: ativação do módulo pelo suporte OPHOS (§5.5 da arquitetura).

## Numerações e contadores (fonte da verdade = nosso banco)

| Contador | Último valor (29/08/2026) |
|---|---|
| CT-e série 001 | 000006469 |
| MDF-e série 002 | 000001186 |
| Requisição CIOT | 64559 |
| **Averbação seguro** | **757** |
