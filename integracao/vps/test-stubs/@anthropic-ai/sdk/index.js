/* Mock do @anthropic-ai/sdk para o selftest.
   O pipeline faz: const Anthropic = require('@anthropic-ai/sdk'); new Anthropic();
   client.messages.create(params) → { stop_reason, content:[{type:'text', text}] }.
   Devolvemos uma extração canônica de decisão 'automatico' (formulário completo).
   O texto pode ser sobrescrito por ANTHROPIC_MOCK_JSON (env) se o teste quiser. */
'use strict';

const CANONICO = {
  nome: 'Cliente Teste',
  email: '',
  telefone: '5511999998888',
  tipoCliente: 'Pessoa Física',
  veiculo: 'Carro passeio',
  tipoVeiculo: 'Carro passeio',
  valorVeiculo: 50000,
  valorInformado: true,
  funciona: true,
  blindado: false,
  motoEletrica: false,
  leilao: false,
  carroMudanca: false,
  origem: 'Santo André, SP',
  destino: 'Betim, MG',
  observacao: '',
  decisao: 'automatico',
  motivo: 'Dentro do padrão',
  precisaAjuste: false,
  motivoAjuste: '',
  orcarComo: '',
  faltaInfo: false,
  faltamCampos: [],
  perguntaCliente: '',
  pediuAtendente: false,
};

class Anthropic {
  constructor() { /* ignora ANTHROPIC_API_KEY */ }
  get messages() {
    return {
      create: async () => {
        const text = process.env.ANTHROPIC_MOCK_JSON || JSON.stringify(CANONICO);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
      },
    };
  }
}

module.exports = Anthropic;
module.exports.default = Anthropic;
module.exports.Anthropic = Anthropic;
