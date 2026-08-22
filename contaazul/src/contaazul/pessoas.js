// Pessoas no Conta Azul (cliente e prestador são a mesma entidade, diferenciada
// por "perfis"). Busca por documento (CPF/CNPJ) e cria se não existir.
import { ca } from './client.js';
import { log, mask } from '../logger.js';

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
// Telefone no formato que o CA exige: DDXXXXXXXXX (DDD+número, SEM o 55 do país,
// sem zeros à esquerda). "5511988456171" → "11988456171".
function telefoneBR(v) {
  let d = soDigitos(v);
  if (!d) return '';
  d = d.replace(/^0+/, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length > 11) d = d.slice(-11);
  return d;
}

// A API v2 quer `perfis` como lista de OBJETOS { tipo_perfil: 'Cliente'|'Fornecedor' }
// (português, capitalizado) — confirmado lendo uma pessoa real. NÃO é ['FORNECEDOR'].
const PERFIL_LABEL = { CLIENTE: 'Cliente', FORNECEDOR: 'Fornecedor' };
// A API v2 devolve listas em `items` (inglês) — não `itens`.
const listaDe = (data) => (Array.isArray(data) ? data : (data?.items || data?.itens || data?.content || []));

/**
 * Acha uma pessoa pelo documento. Retorna o objeto ou null.
 * ⚠️ VERIFICAR o nome do parâmetro de busca contra o OpenAPI do endpoint
 * (pode ser 'documento', 'cpf_cnpj' ou busca textual). Ajuste aqui num lugar só.
 */
export async function buscarPessoaPorDocumento(documento) {
  const doc = soDigitos(documento);
  if (!doc) return null;
  // ⚠️ A API pode IGNORAR o filtro e devolver a lista geral — por isso conferimos
  // o documento de verdade (pegar o [0] às cegas devolvia a pessoa errada, e a
  // venda caía em "Cliente da venda não encontrado com o ID informado").
  const { data } = await ca.get('/v1/pessoas', { documento: doc, termo_busca: doc, tamanho_pagina: 100 });
  return listaDe(data).find((x) => [x.documento, x.cpf, x.cnpj].some((v) => soDigitos(v) === doc)) || null;
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
    if (achado?.id) {
      // pessoa existe mas sem o PERFIL necessário (ex.: só Fornecedor e a venda
      // precisa de Cliente) → tenta acrescentar o perfil (best-effort).
      const alvos = (p.perfis || []).map((x) => PERFIL_LABEL[String(x).toUpperCase()] || x);
      const tem = (alvo) => (achado.perfis || []).some((x) => String(x.tipo_perfil || x).toLowerCase() === String(alvo).toLowerCase());
      const faltando = alvos.filter((a) => !tem(a));
      if (faltando.length) {
        try {
          await ca.put('/v1/pessoas/' + achado.id, {
            perfis: [ ...(achado.perfis || []).map((x) => ({ tipo_perfil: x.tipo_perfil || x })), ...faltando.map((a) => ({ tipo_perfil: a })) ],
          });
          log.info('CA pessoa: perfil adicionado', { id: achado.id, faltava: faltando.join(',') });
        } catch (e) { log.warn('CA pessoa: não consegui adicionar perfil (segue com o id achado)', { id: achado.id, erro: e.message }); }
      }
      return achado.id;
    }
  }
  // Cria. Sem documento, cria só pelo nome (a OBS aceita prestador sem CPF).
  // Cliente de VENDA precisa de cadastro COMPLETO pra emitir cobrança Pix/boleto:
  // CPF/CNPJ + endereço completo (enderecos[]) + telefone_celular. Campos confirmados
  // lendo uma pessoa real: enderecos[{cep,logradouro,numero,complemento,bairro,cidade,estado,pais}].
  const end = p.endereco || null;
  const body = {
    nome: p.nome,
    // tipo_pessoa é obrigatório na API: 'Jurídica' p/ CNPJ (14 díg), senão 'Física'.
    tipo_pessoa: (p.tipoPessoa) || (doc.length === 14 ? 'Jurídica' : 'Física'),
    // schema oficial CriarPessoa: os campos são `cpf` e `cnpj` (NÃO `documento` —
    // a API ignorava em silêncio e a pessoa nascia sem CPF → cobrança INVALIDO).
    ...(doc ? (doc.length === 14 ? { cnpj: doc } : { cpf: doc }) : {}),
    ...(p.email ? { email: p.email } : {}),
    // o campo REAL do telefone é telefone_celular (o "telefone" não persiste)
    ...(telefoneBR(p.telefone) ? { telefone_celular: telefoneBR(p.telefone) } : {}),
    ...(end && (end.cep || end.logradouro) ? {
      enderecos: [{
        cep: String(end.cep || '').replace(/\D/g, ''),
        logradouro: end.logradouro || '',
        numero: end.numero || 'S/N',
        complemento: end.complemento || '',
        bairro: end.bairro || '',
        cidade: end.cidade || '',
        estado: end.estado || '',
        pais: 'Brasil',
      }],
    } : {}),
    // perfis no formato REAL: [{ tipo_perfil: 'Cliente' }] / [{ tipo_perfil: 'Fornecedor' }]
    ...(p.perfis ? { perfis: p.perfis.map((x) => ({ tipo_perfil: PERFIL_LABEL[String(x).toUpperCase()] || x })) } : {}),
  };
  const { data } = await ca.post('/v1/pessoas', body);
  const id = data?.id || data?.uuid;
  if (!id) throw new Error('Conta Azul não devolveu id da pessoa criada');
  log.info('CA pessoa criada', { nome: p.nome, doc: mask(doc) });
  return id;
}
