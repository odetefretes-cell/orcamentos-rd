/*
 * Snippet para o SISTEMA OBS (roda no navegador do site).
 * Coloque o segredo NÃO aqui em texto puro se puder evitar — o ideal é o site
 * ter um pequeno proxy no próprio VPS que injeta o X-OBS-Secret. Se for chamar
 * direto do front, saiba que o segredo fica visível; nesse caso trate-o como
 * "senha de porta", troque periodicamente e restrinja o CORS ao seu domínio.
 *
 * Uso:
 *   const api = criarClienteOBS({ baseUrl: 'https://api.obstransportes.com.br', secret: '...' });
 *   await api.registrarVenda({ ... });
 *   await api.lancarDespesa({ ... });
 *   await api.status(1523);
 */
export function criarClienteOBS({ baseUrl, secret }) {
  async function req(path, { method = 'GET', body } = {}) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-OBS-Secret': secret,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  }

  return {
    // Ver contrato em src/domain/mapVenda.js
    registrarVenda: (venda) => req('/obs/venda', { method: 'POST', body: venda }),
    // Ver contrato em src/domain/mapDespesa.js. Para forçar após aviso de
    // duplicidade (409), reenvie com { ...despesa, forcar: true }.
    lancarDespesa: (despesa) => req('/obs/despesa', { method: 'POST', body: despesa }),
    status: (frete) => req('/obs/status?frete=' + encodeURIComponent(frete)),
  };
}

/*
 * Exemplo de uso no botão "Registrar no Conta Azul" da fila de receita:
 *
 * botao.addEventListener('click', async () => {
 *   const r = await api.registrarVenda({
 *     frete: ficha.numero,
 *     modal: 'cegonha',
 *     valor: ficha.valorNegociado,
 *     formaPagamento: 'PIX_50_50',
 *     previsaoChegada: ficha.previsaoEntrega,   // vencimento da 2ª parcela
 *     cliente: { nome: ficha.cliente, documento: ficha.cpfCnpj },
 *     origem: ficha.origem, destino: ficha.destino,
 *     veiculo: ficha.veiculo, placa: ficha.placa,
 *   });
 *   if (r.data.duplicado) alert('Esse frete já estava registrado.');
 *   else mostrarNumeroVenda(r.data.ca.numero);
 * });
 */
