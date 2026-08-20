// Pessoas no Conta Azul (cliente e prestador são a mesma entidade, diferenciada
// por "perfis"). Busca por documento (CPF/CNPJ) e cria se não existir.
import { ca } from './client.js';
import { log, mask } from '../logger.js';

const soDigitos = (s) => String(s || '').replace(/\D/g, '');

/**
 * Acha uma pessoa pelo documento. Retorna o objeto ou null.
 * ⚠️ VERIFICAR o nome do parâmetro de busca contra o OpenAPI do endpoint
 * (pode ser 'documento', 'cpf_cnpj' ou busca textual). Ajuste aqui num lugar só.
 */
export async function buscarPessoaPorDocumento(documento) {
  const doc = soDigitos(documento);
  if (!doc) return null;
  const { data } = await ca.get('/v1/pessoas', { documento: doc, tamanho_pagina: 1 });
  const lista = Array.isArray(data) ? data : (data?.itens || data?.content || []);
  return lista[0] || null;
}

/**
 * Garante que a pessoa existe (cria se preciso) e devolve o id.
 * @param {{nome:string, documento?:string, email?:string, telefone?:string, perfis?:string[]}} p
 * @returns {Promise<string>} id da pessoa no Conta Azul
 */
export async function garantirPessoa(p) {
  const doc = soDigitos(p.documento);
  if (doc) {
    const achado = await buscarPessoaPorDocumento(doc);
    if (achado?.id) return achado.id;
  }
  // Cria. Sem documento, cria só pelo nome (a OBS aceita prestador sem CPF).
  const body = {
    nome: p.nome,
    ...(doc ? { documento: doc } : {}),
    ...(p.email ? { email: p.email } : {}),
    ...(p.telefone ? { telefone: soDigitos(p.telefone) } : {}),
    // 'perfis' ex.: ['CLIENTE'] ou ['FORNECEDOR'] — VERIFICAR enum no OpenAPI.
    ...(p.perfis ? { perfis: p.perfis } : {}),
  };
  const { data } = await ca.post('/v1/pessoas', body);
  const id = data?.id || data?.uuid;
  if (!id) throw new Error('Conta Azul não devolveu id da pessoa criada');
  log.info('CA pessoa criada', { nome: p.nome, doc: mask(doc) });
  return id;
}
