# Ativar o upload de documentos (Firebase Storage)

Para o cliente conseguir **anexar as fotos** (doc do veículo, CNH, comprovante) no
formulário, é preciso ativar o **Firebase Storage**. Passo a passo (uma vez só).

> Isso exige o plano **Blaze (pré-pago)**, que pede um cartão. **Você não é cobrada
> dentro da franquia grátis** (5 GB) — para o volume de vocês, tende a ficar em R$ 0.
> Ainda assim, configure um **alerta de orçamento** (passo 3) para total segurança.

## 1. Ativar o plano Blaze (com alerta de orçamento)
1. Acesse **https://console.firebase.google.com** → projeto **obs-fretes**.
2. No menu inferior esquerdo, clique em **Fazer upgrade** (Spark → **Blaze**).
3. Selecione/So crie uma **conta de faturamento** (cadastre o cartão) e confirme.
4. **Alerta de orçamento** (recomendado): na tela do Blaze, defina um **orçamento**
   (ex.: **R$ 10/mês**) — o Google avisa por e-mail se aproximar. (Também dá para
   fazer depois em Google Cloud → *Billing* → *Budgets & alerts*.)

## 2. Ativar o Storage
1. No menu esquerdo: **Criar** (Build) → **Storage**.
2. Clique em **Começar** → modo **Produção** → local **southamerica-east1 (São Paulo)**
   → **Concluir**.

## 3. Regras do Storage
1. Aba **Regras** (dentro do Storage) → apague tudo → cole e **Publicar**:

   ```
   rules_version = '2';
   service firebase.storage {
     match /b/{bucket}/o {
       match /docs/{freteId}/{fileName} {
         allow read, write: if true;
       }
     }
   }
   ```
   > Libera apenas a pasta `docs/` (onde ficam as fotos dos pedidos). Se quiser
   > reforçar depois (limitar tamanho/tipo, ou exigir login), me avise.

## Pronto
Depois disso, no link do cliente aparece a seção **📎 Documentos** e o envio funciona.
As fotos ficam acessíveis para a equipe pelos links no card do Relatório.

> Observação de privacidade (LGPD): as fotos são de documentos pessoais. Os links do
> Firebase têm um token secreto (não são adivinháveis), mas trate esses documentos com
> cuidado. Se quiser proteção extra (acesso só com login), dá para evoluir depois.
