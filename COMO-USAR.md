# OBS Transportes — Como usar e compartilhar com a equipe

## 1. O jeito certo: usar pelo LINK (já está no ar)

O sistema é um aplicativo web e **já está publicado**. Os operadores usam
abrindo este endereço no navegador (Chrome/Edge), **não** precisa instalar nada:

**https://odetefretes-cell.github.io/orcamentos-rd/**

- Cada colaborador faz **login** e vê **somente a sua área**:
  - **Administrador** — tudo
  - **Comercial** — CRM (leads/orçamentos) + relatório comercial
  - **Operacional** — Operacional + emissão de ficha/contrato + relatório
  - **Financeiro** — Financeiro + relatório financeiro
- Os dados ficam **na nuvem (Firebase)** e sincronizam ao vivo entre todos.
- Os **links do cliente** (acompanhamento do transporte e formulário de
  orçamento) só funcionam por esse endereço publicado.

### Deixar fácil para os operadores
- **Fixar no navegador**: abra o link → menu → “Adicionar aos favoritos”.
- **Atalho na área de trabalho** (Windows): abra o link no Edge → menu (⋯) →
  *Aplicativos* → *Instalar este site como aplicativo*. Vira um ícone no desktop.
- **Celular**: abra o link no Chrome → menu → *Adicionar à tela inicial*.
- **Compartilhar**: mande o link no grupo de WhatsApp da equipe.

## 2. OneDrive — para BACKUP (não para usar no dia a dia)

Guardar uma cópia no OneDrive serve como **backup/segurança**, mas o sistema
**não deve ser usado abrindo o arquivo direto do OneDrive**, porque:
- a **calculadora de frete** precisa de um servidor para ler a tabela
  (`tabela-fretes.json`) — aberto como arquivo local, o navegador bloqueia;
- os **links do cliente** só abrem pelo endereço publicado.

### Como salvar a cópia no OneDrive (backup)
1. Baixe os arquivos do sistema:
   - No GitHub, abra **https://github.com/odetefretes-cell/orcamentos-rd**
   - Botão verde **Code** → **Download ZIP**.
2. Descompacte o ZIP.
3. Copie a pasta para dentro do seu **OneDrive** (ex.: `OneDrive/OBS-Sistema`).
4. Pronto — está guardado. Para **usar de verdade**, continue usando o **link**
   do item 1.

> Dica: sempre que quiser uma cópia atualizada, baixe o ZIP de novo — ele já
> vem com as últimas alterações que estão no ar.

## 3. Resumo
- **Trabalhar** = pelo **link publicado** (sincroniza a equipe toda).
- **OneDrive** = só uma **cópia de segurança** dos arquivos.
- **Logins** ficam em *Configurações* (⚙️) — o administrador cria/edita/remove
  usuários e senhas dos colaboradores.
