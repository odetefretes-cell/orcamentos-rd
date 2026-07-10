# orcamentos-rd

Gerador de orçamentos de transporte de veículos a partir dos leads do **RD Station CRM**.

## O que faz

`gerar_orcamentos.py` puxa as negociações do RD Station via API, seleciona os leads
no estágio **"EMITIR ORÇAMENTO"** (leads novos que ainda precisam de cotação) e gera
**um arquivo `.xlsx` por lead** a partir do template `emissor_orcamento.xlsx`.

Campos preenchidos automaticamente por lead:

- Cliente + telefone
- Origem e destino
- Veículo (marca/modelo) e se está funcional
- Data de envio desejada / valor informado (observações)
- Template escolhido conforme "Empresa/particular": aba **CNPJ** ou **ORÇAMENTO PARTICULAR**

Campos deixados **em branco** para fechamento manual:

- Frete (carretas, coleta, entrega)
- Valor da FIPE
- Prazo de trânsito
- CNPJ — *não existe como campo no RD Station CRM atualmente*

As fórmulas de seguro, CTE e totais permanecem no template e recalculam sozinhas
quando o frete é lançado.

## Uso

```bash
pip install openpyxl
RD_TOKEN=seu_token python3 gerar_orcamentos.py
```

Variáveis de ambiente opcionais: `TEMPLATE`, `OUTDIR`, `MAX_PAGES`.

Os arquivos são gravados em `orcamentos_gerados/`.
