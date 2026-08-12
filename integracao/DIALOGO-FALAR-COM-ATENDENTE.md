# OBS — Diálogo "Falar com Atendente" (ChatGuru) — spec para montar

**Objetivo:** quando o cliente pede para **falar com um atendente/pessoa**, o
ChatGuru deve automaticamente: **STATUS = AGUARDANDO**, **delegar a um atendente do
comercial** (responsável) e **marcar como não lido**, para o time assumir a conversa.

**Por que no ChatGuru (e não no backend):** status, responsável e "não lido" são
estado da conversa no ChatGuru. A **API do ChatGuru não tem** ação para mudar
status, delegar responsável ou marcar não lido — só enviar mensagem e gravar
variável de contexto. Logo, isso é um **diálogo** (igual aos 3.3/3.4).

> O **backend já foi ajustado** para acompanhar: quando a IA vê que o cliente pediu
> atendente (`pediuAtendente=true`), manda o lead direto pra **humano** (não fica
> perguntando dados) e cria/atualiza o lead no CRM na trilha de atenção humana.

---

## Diálogo novo — "Falar com Atendente"

- **Grupo:** ChatGuru Integrações
- **Tipo:** Contínuo · **Execução:** Automático · **Máx. Execuções:** 9999 · **Ação:** Ligada
- **Gatilho** (frases de "quero uma pessoa" — ajustar/'+' conforme o padrão real):
```
(!word=='atendente' OR !word=='falar com atendente' OR !word=='quero falar com atendente'
 OR !word=='preciso falar com um atendente' OR !word=='falar com alguém'
 OR !word=='falar com uma pessoa' OR !word=='atendimento humano' OR !word=='humano'
 OR !word=='me liga' OR !word=='chama alguém' OR !word=='quero um atendente'
 OR !word=='falar com vendedor' OR !word=='quero falar com alguém')
```
> Conferir a semântica do `!word` (se casa a mensagem que **contém** a expressão).
> Se necessário, usar as duas formas (palavra isolada "atendente" + frases).

- **Ações:**
  1. **STATUS → `AGUARDANDO`** (Ligado) — igual aos diálogos 3.3/3.4.
  2. **Delegar / Responsável → atendente do COMERCIAL** — usar a ação de
     delegação do ChatGuru (ex.: "Delegar p/ Fila" do comercial, ou atribuir a um
     atendente por rodízio se houver essa opção). Objetivo: sair de "Ninguém
     Delegado" e cair pra um atendente do comercial.
  3. **Marcar como NÃO LIDO** — se existir ação de diálogo para isso, ligar. Se o
     ChatGuru **não** tiver ação de "não lido" via diálogo, o AGUARDANDO +
     delegação já colocam a conversa na fila do atendente (validar na prática se
     aparece como pendente/não lida pra ele).
  4. *(Opcional)* **RESPONDER** com um aviso curto, pra não deixar o cliente no
     vácuo enquanto o atendente não chega:
     ```
     Claro! 😊 Já estou te encaminhando para um de nossos atendentes do comercial.
     Em instantes alguém do time fala com você por aqui.
     ```
     > Se preferir o chat **realmente sem resposta automática** (pra reforçar o
     > "não lido"), pode deixar esta ação DESLIGADA — é opcional.

- **Contexto de Saída (recomendado):** `Cotando = Nao`
  - Assim o **encaminhador** para de repassar mensagens desse contato (ele foi pra
    humano, não faz mais sentido a cotação automática seguir).

---

## Cuidados

- **Não conflitar com os diálogos de interesse (3.3/3.4):** aqueles disparam em
  "sim/quero/interesse" **com** `MediaEnviada=='Sim'`. Este dispara nas frases de
  "atendente/pessoa". Se houver sobreposição (ex.: "quero um atendente" casar o
  "quero" do 3.3), garantir que o "Falar com Atendente" tenha prioridade ou usar
  frases específicas.
- **Pode disparar a qualquer momento** (com ou sem média enviada) — o cliente pode
  pedir atendente antes ou depois da estimativa.

---

## Teste

1. Num contato de teste, mandar **"Preciso falar com um atendente"**.
2. Conferir: a conversa foi para **AGUARDANDO**, com um **responsável do comercial**
   e (se aplicável) **não lida**.
3. Conferir no CRM: o lead aparece na trilha de **atenção humana** (o backend marca
   `motivo = "cliente pediu atendente"`).
