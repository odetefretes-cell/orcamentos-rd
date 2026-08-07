# Regras de decisão: automático x humano (Etapa 4)

Quando o lead estiver **completo** (`statusIntake: "completo"`), a Etapa 4 vai
mandar o texto pro Claude EXTRAIR os campos e DECIDIR o caminho:

- **AUTOMÁTICO** → o sistema calcula o orçamento e responde pelo ChatGuru.
- **HUMANO** → marca o lead como `AGUARDANDO` e NÃO responde sozinho.

## Desviar para HUMANO quando:

1. **Moto elétrica**.
2. **Valor do veículo acima de R$ 500.000** (meio milhão).
   > Atualizado em 2026-08-07: antes estava R$ 12.000 (valor incorreto).
   > O correto é **> R$ 500.000**.
3. **Carro + mudança** (bagagem / itens junto com o veículo).
4. **Lead sem o valor do veículo informado**.
5. **Qualquer coisa fora do padrão** / valor claramente errado.

## Automático, mas a média é só ESTIMATIVA (precisaAjuste=true):

Estes casos **continuam automáticos** (manda a média pro cliente), mas ficam
marcados com `precisaAjuste=true` e `motivoAjuste`. A ideia: enviar a média pra
manter o cliente engajado e, se houver interesse, a equipe ajusta o orçamento
com as especificações reais.

- **Leilão** — leiloeira / pátio de leilão.
- **Veículo que não funciona / não liga**.

  > Atualizado em 2026-08-07: antes estes dois iam pra humano; agora mandam a
  > média como estimativa a ajustar.

## Caso contrário:

Segue no **AUTOMÁTICO** normal (extrai campos → calcula orçamento → responde).

## Campos que chegam do formulário do site (numa única mensagem):

Nome, Telefone, E-mail, Tipo de cliente, Veículo, Tipo de veículo,
Valor do veículo, Funciona/liga, Blindado, Origem, Destino, Observação.

> Observação: como o formulário chega como UMA mensagem de texto só, o Claude
> extrai todos esses campos direto do texto. Não dependemos de o ChatGuru
> separar campo a campo.
