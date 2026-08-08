# Regras de decisão: automático x humano (Etapa 4)

Quando o lead estiver **completo** (`statusIntake: "completo"`), a Etapa 4 vai
mandar o texto pro Claude EXTRAIR os campos e DECIDIR o caminho:

- **AUTOMÁTICO** → o sistema calcula o orçamento e responde pelo ChatGuru.
- **HUMANO** → marca o lead como `AGUARDANDO` e NÃO responde sozinho.

## Desviar para HUMANO quando:

1. **Valor do veículo acima de R$ 500.000** (meio milhão).
   > Atualizado em 2026-08-07: antes estava R$ 12.000 (valor incorreto).
   > O correto é **> R$ 500.000**.
2. **Lead sem o valor do veículo informado**.
3. **Qualquer coisa fora do padrão** / valor claramente errado.

## Automáticos com tratamento especial:

Estes casos **continuam automáticos** (mandam a média pro cliente), com uma
marcação pra equipe:

- **Moto elétrica** → orça **como moto 300cc** (`orcarComo = "moto 300cc"`).
  Não precisa de ajuste manual.
- **Leilão** → `precisaAjuste = true`, `motivoAjuste = "leilão"`.
- **Veículo que não funciona / não liga** → `precisaAjuste = true`,
  `motivoAjuste = "veículo não funciona"`.
- **Carro + mudança** → `precisaAjuste = true`, `motivoAjuste = "carro + mudança"`.
  Manda a média do **veículo**; a mudança/bagagem é ajustada à parte.

  > Atualizado em 2026-08-07: leilão, "não funciona", moto elétrica e
  > carro+mudança **saíram do humano**. A ideia é enviar a média pra manter o
  > cliente engajado; se houver interesse, a equipe ajusta com as especificações.

## Caso contrário:

Segue no **AUTOMÁTICO** normal (extrai campos → calcula orçamento → responde),
com `precisaAjuste = false` e `orcarComo = ""`.

## Campos que chegam do formulário do site (numa única mensagem):

Nome, Telefone, E-mail, Tipo de cliente, Veículo, Tipo de veículo,
Valor do veículo, Funciona/liga, Blindado, Origem, Destino, Observação.

> Observação: como o formulário chega como UMA mensagem de texto só, o Claude
> extrai todos esses campos direto do texto. Não dependemos de o ChatGuru
> separar campo a campo.
