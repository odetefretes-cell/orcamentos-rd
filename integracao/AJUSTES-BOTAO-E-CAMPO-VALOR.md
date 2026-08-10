# OBS — 2 ajustes no ChatGuru (botão + campo valor)

Contexto: um lead pelo botão "Gerar Orçamento" que **faltava o valor** entrou em
Fase C (o robô perguntou), mas a resposta do cliente não chegava ao backend e a
pergunta se repetia. Causa: o **botão gravava `MediaEnviada=Sim`**, que **desliga o
encaminhador**. O backend já foi ajustado pra se auto-corrigir (na Fase C ele liga
`Cotando=Sim` e limpa `MediaEnviada`), mas os 2 ajustes abaixo deixam 100% limpo.

---

## Ajuste 1 (RECOMENDADO) — botão 3.2 não deve pré-marcar `MediaEnviada`

**Diálogo:** "Gerar Orçamento (Backend OBS)" — ID `6a764da144d8d8cf0d70356a`.

- **Hoje:** Contexto de Saída = `MediaEnviada = Sim`.
- **Trocar para:** Contexto de Saída = **`Cotando = Sim`**.

**Por quê:** o botão marcava "média enviada" no clique — mas nem sempre a média sai
(quando falta dado, o backend PERGUNTA em vez de cotar). Esse `MediaEnviada=Sim`
prematuro bloqueia o encaminhador (que exige `MediaEnviada != Sim`) e faz a resposta
do cliente se perder. **O backend já grava `MediaEnviada=Sim` sozinho via API quando
a média REALMENTE sai** (confirmado em produção) — então o botão não precisa marcar.
Trocar para `Cotando=Sim` ainda garante que o encaminhador capture as respostas.

> Resultado: botão → (se tem tudo) backend cota e marca MediaEnviada; (se falta algo)
> backend pergunta e o encaminhador capta a resposta → cota. Sem repetir pergunta.

---

## Ajuste 2 (OPCIONAL) — campo personalizado "Valor do veículo"

Hoje **não existe** um campo personalizado para o valor do veículo — por isso o valor
só vive na conversa (e depende do encaminhador para chegar ao backend).

- **Criar** o campo personalizado **"Valor do veículo"** (gerenciador de Campos
  Personalizados).
- Assim o atendente pode **preencher o valor** e o botão "Gerar Orçamento" já manda
  tudo pronto → cota **sem** depender da Fase C.

> Não é obrigatório (o encaminhador já resolve pela conversa), mas dá um caminho
> direto pro atendente nos contatos diretos.

---

## Teste (após o Ajuste 1)

1. Contato de teste, **sem valor**, aciona "Gerar Orçamento" → robô pergunta o valor.
2. Cliente responde o valor (ex.: "12000") → em ~1-2 min a **média** chega sozinha.
3. Não deve repetir a pergunta.
