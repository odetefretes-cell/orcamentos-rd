# Ferramentas — tabela de fretes (base de cálculo)

A **calculadora de frete** dentro do CRM usa o arquivo **`tabela-fretes.json`**
(na raiz do projeto), gerado a partir do **`BANCO_DE_DADOS.xlsx`** da OBS.

O banco está em **constante evolução**. Para atualizar a tabela no sistema:

```bash
python3 ferramentas/gerar-tabela.py CAMINHO/BANCO_DE_DADOS.xlsx
git add tabela-fretes.json && git commit -m "Atualiza tabela de fretes" && git push
```

Isso regenera o `tabela-fretes.json` (rotas por transportadora, trajetos que
pertencem a cada rota, categorias e taxas por cidade). O app carrega esse
arquivo sob demanda (só quando o operador abre a calculadora).

## Como a calculadora usa a tabela

- **Frete Base** = valor tabelado da rota para a **categoria** escolhida.
  Em reembarque (vários trechos), soma o valor de cada trecho.
- **Seguro** = tabela RCTR-C (UF origem → UF destino) × valor do veículo,
  somando as taxas de cada trecho (mesma tabela já usada no Financeiro).
- **Recebimento** e **Coleta/Entrega** = taxas por cidade (aba *Configurações*).
- **Taxa Fixa / Imposto / Transbordo** = o operador confere/edita antes de emitir.

## Estrutura da planilha esperada

Cada aba de transportadora:
- Bloco de preços (colunas A–E): `Rota | Categoria | Valor (R$) | Tipo | Dias`
- Bloco de trajetos (colunas G–K): `Rota | Origem Cidade | UF | Destino Cidade | UF`
  (ligado ao preço pelo **nome da rota**)

Aba `Configurações`:
- Categorias de veículos (coluna A)
- Taxas por cidade (colunas C–F): `Cidade | UF | Recebimento | Coleta/Entrega`
