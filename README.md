# orcamentos-rd

Gerador de orçamentos de transporte de veículos a partir dos leads do
**RD Station CRM**, com o **frete calculado automaticamente** pela malha de
rotas cadastrada.

## O que faz

`gerar_orcamentos.py` puxa as negociações do RD Station via API, seleciona os
leads no estágio **"EMITIR ORÇAMENTO"** (leads novos que ainda precisam de
cotação) e gera **um arquivo `.xlsx` por lead** a partir do template
`emissor_orcamento.xlsx`.

Para cada lead ele também **calcula o frete** cruzando origem/destino com o
banco de rotas (`banco_dados.xlsx`) através do módulo `roteador.py`.

### Preenchido automaticamente

- Cliente + telefone
- Origem e destino
- Veículo (marca/modelo), se está funcional, envio desejado
- Template escolhido conforme "Empresa/particular" (aba **CNPJ** ou **ORÇAMENTO PARTICULAR**)
- **CARRETAS** (custo de cada perna do trajeto) e **prazo**

### Deixado em branco (para fechamento manual)

- **Margem / LUCRO** (célula N22) — o frete preenchido é apenas o *custo* das pernas
- Valor da **FIPE** (F17)
- **Coleta/entrega** porta a porta (K10/K11)
- **CNPJ** — não existe como campo no RD Station CRM

As fórmulas de seguro, CTE e totais permanecem no template e recalculam
sozinhas.

## Como o frete é roteado

A malha é **hub-and-spoke**: rotas diretas que não existem são montadas
combinando trechos (as CARRETAS 1/2/3), pelo caminho de **menor custo**
entre transportadoras. Exemplos:

- `Manaus → Fortaleza` = Manaus→Belém + Belém→Fortaleza
- `Rio Branco → Porto Ferreira` = Rio Branco→Goiânia + Goiânia→SBC + SBC→Porto Ferreira

Cidades que não estão na malha (ex.: destinos muito pequenos ou mudanças
locais) ficam **sem rota** e o frete é deixado em branco.

## Uso

```bash
pip install openpyxl
RD_TOKEN=seu_token python3 gerar_orcamentos.py
```

Variáveis de ambiente opcionais: `TEMPLATE`, `BANCO`, `OUTDIR`, `MAX_PAGES`.
Ajustes de categoria de veículo por modelo ficam em `CATEGORIA_MANUAL`
(dentro de `gerar_orcamentos.py`).

Os arquivos são gravados em `orcamentos_gerados/`.

## Arquivos

| Arquivo | Descrição |
|---|---|
| `gerar_orcamentos.py` | Script principal (RD → roteamento → preenchimento) |
| `roteador.py` | Motor de roteamento de menor custo sobre o banco |
| `emissor_orcamento.xlsx` | Template do orçamento |
| `banco_dados.xlsx` | Banco de rotas/preços por transportadora |
| `orcamentos_gerados/` | Orçamentos gerados |
