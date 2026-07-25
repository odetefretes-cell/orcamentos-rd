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
  Atualização, Pago 1/2**; o sistema calcula **Em aberto** (frete − pago) e
  **Saldo** (pago − prestadores). Botão **↩ Fila** devolve o frete para a fila e
  **Abrir ficha** volta para reimprimir os documentos.

## Prestadores (ficha interna)

Na seção **8 · Prestadores** você lança até 4 motoristas/transportadoras
(Empresa/Motorista, Telefone, Data de saída, Valor e Status). Eles aparecem
**apenas na Autorização** (controle interno), nunca no contrato do cliente.

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
