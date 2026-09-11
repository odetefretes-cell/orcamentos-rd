# ⛔ AGUARDANDO AS SPECS DA API OPHOS

> ⚠️ **Este arquivo foi corrigido em 11/09/2026.** A versão anterior pedia os manuais do
> **Integrador OPHOS 5.24** (TXT posicional, XML SEFAZ, pastas no Windows). Aquele nunca foi o
> canal: o suporte confirmou em 29/08 que a integração é **API REST**. Pedir o arquivo errado
> travou o projeto por duas semanas.

## O que colocar nesta pasta

As duas especificações JSON, que são de **documentação pública** (não exigem contrato):

| Arquivo a salvar aqui | Baixar de |
|---|---|
| `cte.json` | `https://developer.ophos.com.br/?url=/api/cte.json` |
| `mdfe.json` | `https://developer.ophos.com.br/?url=/api/mdfe.json` |

**Nenhum builder (`src/builders/`) pode ser escrito antes desses arquivos chegarem** — regra da
arquitetura (§2): parser/builder nasce da spec oficial, nunca de suposição.

## Como baixar

O ambiente do Claude Code **não alcança** `developer.ophos.com.br` nem `www.ophos.com.br` (a
rede de saída bloqueia os dois). Quem baixa é a VPS ou o navegador.

**Pela VPS** (mais rápido — a VPS tem saída livre, foi assim que pegamos a spec do Conta Azul):

```
cd ~/obs-repo
curl -sSL "https://developer.ophos.com.br/?url=/api/cte.json"  -o /tmp/cte.json
curl -sSL "https://developer.ophos.com.br/?url=/api/mdfe.json" -o /tmp/mdfe.json
head -c 300 /tmp/cte.json     # conferir que veio JSON, e não uma página de login
```

Se vier JSON de verdade, subir para o repositório (ou mandar os arquivos no chat).

**Pelo navegador:** abrir as duas URLs, salvar como `.json`, e subir em
`obs-fiscal-service/docs/ophos-layouts/` pelo GitHub
(branch `claude/automate-transport-contract-form-tgvad2` → *Add file → Upload files*).

## O que NÃO adianta procurar aqui

- **CIOT** — a OPHOS respondeu *"NÃO temos integração ainda"*. Não existe spec.
- **GNRE** — *"não emitimos GNRE"*. Não existe spec.
- **DC-e** — resposta ambígua (*"possível emitir junto com o CTe"*). Se não houver `dce.json`,
  é porque sai como parte do CT-e — confirmar com a OPHOS antes de projetar.
