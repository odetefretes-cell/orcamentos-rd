#!/usr/bin/env python3
"""
Gera um arquivo de orçamento (.xlsx) por lead do RD Station CRM.

- Puxa negociações via API do RD Station CRM.
- Filtra os leads no estágio "EMITIR ORÇAMENTO" (leads novos que ainda precisam de cotação).
- Para cada lead com dados de rota/veículo, preenche uma cópia do template
  (aba "ORÇAMENTO PARTICULAR" ou "CNPJ" conforme o campo Empresa/particular).
- Preenche: cliente, telefone, CNPJ (quando disponível), origem, destino,
  veículo e observações. Deixa FRETE e FIPE em branco para fechamento manual.

Uso:
    RD_TOKEN=seu_token python3 gerar_orcamentos.py

Requer: openpyxl  (pip install openpyxl)
"""
import os
import re
import json
import urllib.request

TOKEN = os.environ.get("RD_TOKEN", "")
TEMPLATE = os.environ.get("TEMPLATE", "emissor_orcamento.xlsx")
OUTDIR = os.environ.get("OUTDIR", "orcamentos_gerados")
STAGE_ALVO = "EMITIR ORÇAMENTO"
MAX_PAGES = int(os.environ.get("MAX_PAGES", "4"))   # ~50 negócios por página


def fetch_deals():
    deals = []
    for page in range(1, MAX_PAGES + 1):
        url = (f"https://crm.rdstation.com/api/v1/deals"
               f"?token={TOKEN}&limit=50&page={page}")
        with urllib.request.urlopen(url) as r:
            data = json.load(r)
        deals += data["deals"]
        if not data.get("has_more"):
            break
    return deals


def cf(deal, label):
    """Valor de um campo personalizado pelo rótulo."""
    for c in deal.get("deal_custom_fields", []):
        if c["custom_field"]["label"] == label:
            return c["value"]
    return None


def sanit(s):
    s = re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")
    return s[:40] or "lead"


def gerar():
    import openpyxl

    if not TOKEN:
        raise SystemExit("Defina a variável de ambiente RD_TOKEN.")
    os.makedirs(OUTDIR, exist_ok=True)

    deals = fetch_deals()
    alvo = [d for d in deals if d["deal_stage"]["name"].strip() == STAGE_ALVO]

    gerados, pulados = [], []
    for x in alvo:
        name = x["name"].replace(" - Negociação", "").strip()
        origem = cf(x, "Cidade de origem")
        destino = cf(x, "Cidade de destino")
        modelo = cf(x, "Modelo do veículo")

        # Sem nenhum dado de rota/veículo -> lead incompleto, pula.
        if not any([origem, destino, modelo]):
            pulados.append(name)
            continue

        tipo = (cf(x, "Empresa/particular:") or "").strip().lower()
        sheet_name = "CNPJ" if tipo == "empresa" else "ORÇAMENTO PARTICULAR"

        wb = openpyxl.load_workbook(TEMPLATE)
        ws = wb[sheet_name]
        for sn in list(wb.sheetnames):      # mantém só a aba do orçamento
            if sn != sheet_name:
                del wb[sn]
        wb.active = 0

        # Cliente + telefone
        contato = (x.get("contacts") or [{}])[0]
        tel = ""
        if contato.get("phones"):
            tel = (contato["phones"][0].get("phone") or "").strip()
        linha = f"Cliente: {name}"
        if tel:
            linha += f"   |   Tel: {tel}"
        ws["A10"] = linha

        # CNPJ (não vem do CRM -> em branco para preencher)
        if sheet_name == "CNPJ":
            ws["A11"] = "CNPJ: "

        # Veículo
        ws["B17"] = modelo or ""
        ws["F17"] = None            # FIPE em branco
        func = (cf(x, "Veículo está funcional?") or "").strip().lower()
        obs = "FUNCIONA" if func == "sim" else (
            "NÃO FUNCIONA" if func in ("não", "nao") else "")
        extra = []
        envio = cf(x, "Data de envio do veículo")
        if envio:
            extra.append(f"Envio: {envio}")
        valor = cf(x, "Valor do Veículo")
        if valor:
            extra.append(f"Valor informado: {valor}")
        ws["H17"] = (obs + ("  |  " if obs and extra else "")
                     + "  ".join(extra)).strip()

        # Rota
        ws["B23"] = origem or ""
        ws["E23"] = destino or ""
        ws["H23"] = None            # prazo de trânsito em branco

        # Frete em branco (fórmulas de seguro/CTE/totais recalculam sozinhas)
        for c in ["K7", "K8", "K9", "N22", "K10", "K11"]:
            ws[c] = None

        fn = os.path.join(OUTDIR, f"Orcamento_{sanit(name)}.xlsx")
        wb.save(fn)
        gerados.append((name, sheet_name, f"{origem} -> {destino}", modelo))

    print(f"Gerados: {len(gerados)}")
    for g in gerados:
        print("  •", g[0], f"[{g[1]}]", "|", g[2], "|", g[3])
    if pulados:
        print("\nPulados (sem dados de rota/veículo):", pulados)


if __name__ == "__main__":
    gerar()
