# orçamentos-rd · OBS Transportes

Ferramenta interna para **preencher automaticamente** a **Autorização de Transporte**
(controle interno) e o **Contrato de Transporte de Veículos** (envio ao cliente),
a partir das informações coletadas no WhatsApp (ChatGuru).

Substitui o preenchimento manual da planilha `CADASTRO DE FRETES`: você digita uma vez,
e o sistema monta as duas páginas prontas para imprimir ou salvar em PDF.

## Como usar

1. Abra o arquivo **`index.html`** no navegador (Chrome, Edge, etc.) — é só dar dois cliques,
   não precisa instalar nada e funciona sem internet.
2. Preencha o formulário com o que o cliente enviou pelo WhatsApp:
   - **Dados do frete** (nº, atendente, data, responsável)
   - **Veículos** — vários por ficha (botão **＋ Adicionar veículo**, até 20).
     Cada um com marca/modelo, placa, chassi, ano, cor e valor. Todos entram
     nas tabelas da Autorização e do Contrato.
   - **Trajeto e frete** (origem, destino, valor, forma de pagamento, prazo)
   - **Contratante** (nome, CPF/CNPJ, telefone, endereço…)
   - **Coleta** e **Entrega** — só quando o cliente acionar (se ficar em branco,
     repete os dados do contratante — base × base)
   - **Checklist de documentos** recebidos (doc do veículo, CNH/RG, comprovante…)
3. As duas páginas são montadas **em tempo real** logo abaixo do formulário.
4. Clique em:
   - **🖨️ Imprimir / PDF (os 2)** — gera a Autorização + o Contrato
   - **Só Autorização (pág. 1)** — apenas o controle interno
   - **Só Contrato (pág. 3)** — apenas o documento do cliente
   - No diálogo de impressão, escolha **"Salvar como PDF"** para enviar ao cliente.

## Histórico de fretes

- **💾 Salvar frete** — guarda o frete no histórico deste navegador (por nº e cliente).
- **🔎 Buscar** — filtre a lista por **nº, cliente, placa, origem ou destino**.
- **Fretes salvos** (lista) — escolha um frete salvo para **recarregar** todos os dados.
- **＋ Novo frete** — começa um frete em branco.
- **🗑️ Excluir** — remove do histórico o frete que está aberto.
- O que você digita fica guardado como **rascunho automático**: se fechar sem salvar,
  ao reabrir o formulário continua preenchido.

## Relatório · Fila e área das operadoras

Aba **📋 Relatório · Operadoras** (no topo). O fluxo é por **fila**:

1. Todo frete **salvo** na aba *Nova Ficha* entra automaticamente na **🕓 FILA**.
2. Na fila, cada frete mostra os botões **⬇ Puxar p/ NATALY**, **⬇ Puxar p/ YASMIN**… —
   a operadora **puxa a demanda para o seu controle**.
3. Depois de puxado, o frete sai da fila e vai para a **área daquela operadora**,
   que acompanha até a conclusão.

Detalhes:
- O campo **Atendente** da ficha é o **responsável pela venda** (vendedor(a)) — não é
  quem opera o frete.
- Pílulas no topo: **FILA**, cada **operadora**, **TODAS**, e **＋ operadora** para
  cadastrar/gerir a lista de operadoras.
- Filtro por **status** (Andamento, Concluído, Cancelado) e **busca** por nº, cliente,
  placa, origem, destino ou vendedor.
- **Resumo**: na fila, exibindo, em andamento, concluídos e **total em aberto**.
- No card já puxado a operadora edita (salva sozinho): **Status, Nº averbação,
  Previsão de entrega, Pago 1/2**; o sistema calcula **Em aberto** (frete − pago) e
  **Saldo** (pago − prestadores). Botão **↩ Fila** devolve o frete para a fila e
  **Abrir ficha** volta para reimprimir os documentos.

### Pedido de frete pelo cliente (mesmo link do acompanhamento)

Na aba Nova Ficha, o botão **🔗 Cliente preencher (novo pedido)** cria um pedido em
branco e gera **um link** para enviar ao cliente (WhatsApp).

- O cliente abre o link e **preenche os próprios dados** (nome, contato, endereço,
  veículo(s), origem/destino) — vira um **pedido de frete**.
- O pedido cai na **FILA de vocês** com o selo **📥 PEDIDO DO CLIENTE**; a operadora
  puxa, revisa e emite o cadastro + contrato (ao **Salvar frete**, o pedido é
  considerado cadastrado).
- **É o mesmo link**: depois de cadastrado, aquele link do cliente deixa de mostrar o
  formulário e passa a mostrar o **acompanhamento do transporte** (andamento ao vivo).
- Privacidade: a página do cliente carrega **apenas o pedido dele**, não os demais fretes.

### Atualizações e link de acompanhamento do cliente

- **Histórico de atualizações internas** — cada anotação é registrada com data/hora,
  formando um histórico para a operadora acompanhar a evolução do transporte.
- **Atualizações para o cliente** — um histórico separado, com a linguagem voltada
  ao cliente.
- **🔗 Gerar link de acompanhamento do cliente** — cria um link que abre uma página
  com o **andamento do transporte** (status, dados e a linha do tempo de atualizações
  do cliente). É só enviar pelo WhatsApp; o cliente abre e acompanha.
  - O link carrega os dados na própria URL (não expõe dados internos nem pagamentos).
  - **Para o cliente conseguir abrir**, a página precisa estar **publicada na internet**
    (ex.: GitHub Pages). A cada nova atualização para o cliente, gere o link de novo.

## Modo compartilhado (nuvem) — fila única em tempo real

Por padrão os dados ficam **no navegador de cada computador** (modo local). Para que
todas as operadoras vejam a **mesma fila em tempo real** e o **link do cliente atualize
sozinho**, ative o **modo nuvem** com o Firebase (grátis). Passo a passo em
**[`CONFIGURAR-NUVEM.md`](CONFIGURAR-NUVEM.md)**.

Depois de ativado:
- Fila **única** que todas veem ao vivo; ao **puxar**, o frete some da fila das outras na hora.
- Link do cliente **ao vivo**: cada atualização aparece sozinha, sem reenviar o link.
- O topo do Relatório mostra o modo atual (**Modo local** ou **☁ Compartilhado**).

## Prestadores (ficha)

Na seção **8 · Prestadores** você adiciona quantos precisar (botão **＋ Adicionar
prestador**), cada um com Empresa/Motorista, Telefone, **Placa/Veículo transportado**,
Data de saída e Valor. Aparecem na Autorização (controle interno) e alimentam o
controle de conferência/pagamento na aba **Financeiro**.

## Importar fretes EM ANDAMENTO (do relatório)

No topo da aba **Operacional** há o botão **⬆ Importar fretes em andamento**. Ele traz
para o sistema **apenas os fretes EM ANDAMENTO** do relatório (RELATORIO_FRETES_NATALY),
já cruzados com os cadastros (CADASTRO DE FRETES) para preencher a ficha completa
(cliente, CPF, endereços, veículo com placa/chassi/ano/cor, valor, forma de pagamento,
Nº averbação e a última anotação de andamento no histórico).

- Cada frete entra direto na **área da operadora** (NATALY / YASMIN), conforme o relatório.
- **Não duplica**: fretes que já existem (mesmo número) são ignorados — pode clicar de novo à vontade.
- Concluídos e cancelados **não** são importados (só os em andamento).

> A lista vem do arquivo `andamento.json` (gerado a partir das planilhas). Para atualizar
> com um relatório novo, envie a planilha para a OBS que o arquivo é regerado.

## Banco de clientes (importar das planilhas)

Na aba **Clientes**, o botão **⬆ Importar cadastro de clientes** cadastra todos os clientes
dos arquivos CADASTRO DE FRETES (por CPF/CNPJ), com **contato, endereço e histórico** de
transportes. Não apaga os já cadastrados — só completa dados que faltam e mescla o histórico.
Depois, ao emitir novos fretes, o cadastro é usado no **preenchimento automático por CPF**.

## Aba 📊 Mensal / Metas

Levantamento por mês a partir do RELATORIO_FRETES_NATALY:

- **Contratos fechados** (total do mês − cancelados), **concluídos**, **em andamento** e **cancelados**.
- **Nível de meta** atingido pela empresa (Abaixo / Meta / Acelerado / Turbo / Máquina) e o **bônus**.
- Quebra **por operadora** (NATALY / YASMIN): fechados e em andamento no mês.
- Tabela do **plano de comissionamento** para referência.

> Os números vêm da planilha (arquivo `resumo-mensal.json`). Envie um relatório novo para a
> OBS que o levantamento é regerado.

## Alerta de falta de atualização (24h)

No Relatório, todo frete **em andamento** que fica **24h sem atualização** ganha o
selo **⚠ Xh sem atualização**. Há um filtro **⚠ ATRASADOS** e um contador no resumo,
para a operadora não esquecer de dar andamento.

## Aba 💰 Financeiro

- **A receber (clientes)**: valor do frete, recebido, em aberto, **previsão de
  recebimento** e situação (**A receber / Vencido / Quitado**). Vencidos destacados,
  com totais de receita, recebido, em aberto e **vencido**.
- **Lucro por frete**: `Lucro = frete − prestadores − imposto (12% quando marcado) −
  seguro`. O **seguro é calculado automaticamente** pela tabela oficial **RCTR-C**
  (taxa da UF de origem → UF de destino × valor do veículo), com opção de digitar
  manual por cima. Totais de receita, custos, lucro e **margem %**.
- **Prestadores — conferência e pagamento**: cada prestador (por placa/veículo) com
  **Conferido**, **No pagamento** e **Pago**. Os conferidos ficam destacados, com
  filtros (a conferir / conferidos / a pagar / pagos) e totais.

## Logo da empresa

- Já vem um **logo padrão OBS Transportes** que aparece sozinho no cabeçalho da
  Autorização **e** do Contrato.
- **🖼️ Escolher logo** — para usar o **logo oficial em imagem** (PNG/JPG), com encaixe
  perfeito. Ele fica salvo para os próximos fretes.
- **Remover logo** — volta ao logo padrão.

## Backup / passar para outro computador

- **Exportar** — baixa um arquivo `frete-XXXX.json` com todos os dados.
- **Importar** — carrega um `.json` exportado antes (depois clique em *Salvar frete*).

## Imprimir em PDF

Ao clicar em imprimir, o navegador já sugere o nome do arquivo automaticamente
(ex.: `Contrato 1531.pdf`, `Autorizacao 1531.pdf`). No diálogo, escolha
**"Salvar como PDF"**.

## O que já vem preenchido (empresa contratada)

- **ODETE BARBOSA SANTOS TRANSPORTES (OBS TRANSPORTES)**
- CNPJ: 08.165.584/0001-67 · IE: 635.532.351.110
- Av. Padre Anchieta, 176 — Jordanópolis — São Bernardo do Campo / SP
- Fones: (11) 4352-4103 · (11) 4352-1524

## Cláusulas do contrato

O Contrato (página 3) já traz o **texto jurídico completo** retirado da planilha —
cláusulas **1 DO OBJETO, 2 DO SERVIÇO, 3 DO SEGURO** (inclui a apólice ALLIANZ) e
**4 DO PRAZO** — impresso automaticamente acima das assinaturas, em uma única página A4.

## Observações

- Os dados ficam **somente no seu navegador** (nada é enviado para a internet).
- O contrato separa **marca** e **modelo** automaticamente quando você usa a barra `/`
  no campo *Marca / Modelo* (ex.: `HONDA/NXR150 BROS`).
- Valores aceitam `2339.80` ou `2.339,80`; ambos viram `R$ 2.339,80`.
