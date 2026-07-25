# Ativar o modo compartilhado (nuvem) — fila em tempo real + link do cliente ao vivo

Por padrão o sistema funciona **local** (os dados ficam no navegador de cada
computador). Para que **NATALY e YASMIN vejam a MESMA fila em tempo real** e o
**link do cliente atualize sozinho**, ative o modo **nuvem** com o Firebase
(gratuito, do Google). Leva ~10 minutos, uma única vez.

> Se preferir, me mande a *configuração* (passo 4) que eu deixo tudo pronto e publicado.

## Passo a passo

### 1. Criar o projeto no Firebase
1. Acesse **https://console.firebase.google.com** e faça login com uma conta Google.
2. Clique em **Adicionar projeto** → dê um nome (ex.: `obs-fretes`) → avançar
   (pode desativar o Google Analytics) → **Criar projeto**.

### 2. Criar o banco de dados (Firestore)
1. No menu lateral, **Criar** → **Firestore Database**.
2. Clique em **Criar banco de dados** → escolha o modo **produção** →
   local **southamerica-east1 (São Paulo)** → **Ativar**.
3. Aba **Regras** → cole as regras abaixo → **Publicar**:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /fretes/{id} {
         allow read, write: if true;
       }
     }
   }
   ```
   > Isso libera a coleção `fretes` para o app funcionar sem login. É adequado para
   > uso interno. Se quiser reforçar a segurança depois (senha/limitar acesso), me avise.

### 3. Registrar o aplicativo Web
1. Na **Visão geral do projeto** (engrenagem → **Configurações do projeto**),
   role até **Seus apps** e clique no ícone **`</>`** (Web).
2. Dê um apelido (ex.: `painel`) → **Registrar app**.
3. O Firebase mostra um trecho com `const firebaseConfig = { ... }`. **Copie** só
   o conteúdo entre chaves `{ ... }` (apiKey, authDomain, projectId, etc.).

### 4. Colar a configuração no sistema
1. Abra o arquivo **`index.html`** num editor de texto (ou me mande a config).
2. Procure por **`const FIREBASE_CONFIG = {`**.
3. Cole os dados do seu projeto ali dentro. Deve ficar assim (com os seus valores):

   ```js
   const FIREBASE_CONFIG = {
     apiKey: "AIza...seu-valor...",
     authDomain: "obs-fretes.firebaseapp.com",
     projectId: "obs-fretes",
     storageBucket: "obs-fretes.appspot.com",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abc123"
   };
   ```
4. Salve. Pronto — ao abrir a página, no topo do Relatório aparece
   **☁ Compartilhado (tempo real)**.

### 5. Publicar a página (para todas usarem o mesmo link)
Para as operadoras e os clientes abrirem pelo navegador, a página precisa estar
**publicada na internet**. O jeito grátis é o **GitHub Pages** — me avise que eu
publico e te envio o link fixo (algo como `https://odetefretes-cell.github.io/orcamentos-rd/`).

## Como fica depois de ativado
- Todo frete salvo entra numa **fila única** que todas veem ao vivo.
- Quando uma operadora **puxa** um frete, ele some da fila das outras na hora.
- O **link do cliente** passa a ser **ao vivo**: cada atualização que a operadora
  adicionar aparece sozinha na página do cliente (sem reenviar o link).

> Os dados de `apiKey`/`projectId` do Firebase Web **não são segredo** — eles ficam
> no código do site por natureza. A proteção real vem das *Regras* do Firestore.
