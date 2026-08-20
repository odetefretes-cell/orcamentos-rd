// Serviços de frete. A API exige um serviço já cadastrado (não aceita item
// avulso de texto livre, diferente da tela). Os UUIDs vêm do .env.
import { config } from '../config.js';

/**
 * Devolve o UUID do serviço conforme o modal.
 * @param {'cegonha'|'guincho'} modal
 */
export function idServico(modal) {
  const m = String(modal || 'cegonha').toLowerCase();
  const id = m === 'guincho' ? config.servicos.guincho : config.servicos.cegonha;
  if (!id) {
    throw new Error(
      `UUID do serviço "${m}" não configurado. Cadastre o serviço no Conta Azul e ` +
      `preencha SERVICE_${m === 'guincho' ? 'GUINCHO' : 'CEGONHA'}_ID no .env.`
    );
  }
  return id;
}
