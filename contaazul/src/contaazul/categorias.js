// Resolve IDs de categoria e centro de custo por NOME (a API não cria categoria;
// tem que já existir na conta). Resultado é cacheado em memória.
import { ca } from './client.js';

let cacheCategorias = null;
let cacheCentros = null;

function normaliza(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // tira acentos
    .trim().toLowerCase();
}

async function carregarCategorias() {
  if (cacheCategorias) return cacheCategorias;
  const { data } = await ca.get('/v1/categorias');
  const lista = Array.isArray(data) ? data : (data?.items || data?.itens || data?.content || []);
  cacheCategorias = lista;
  return lista;
}

async function carregarCentros() {
  if (cacheCentros) return cacheCentros;
  const { data } = await ca.get('/v1/centro-de-custo');
  const lista = Array.isArray(data) ? data : (data?.items || data?.itens || data?.content || []);
  cacheCentros = lista;
  return lista;
}

export async function idCategoria(nome) {
  const lista = await carregarCategorias();
  const alvo = normaliza(nome);
  const achado = lista.find((c) => normaliza(c.nome || c.name) === alvo);
  if (!achado) {
    throw new Error(`Categoria "${nome}" não existe no Conta Azul. Cadastre na tela antes (a API não cria categoria).`);
  }
  return achado.id || achado.uuid;
}

export async function idCentroCusto(nome) {
  const lista = await carregarCentros();
  const alvo = normaliza(nome);
  const achado = lista.find((c) => normaliza(c.nome || c.name) === alvo);
  if (!achado) {
    throw new Error(`Centro de custo "${nome}" não existe no Conta Azul.`);
  }
  return achado.id || achado.uuid;
}

// Para testes: limpa o cache.
export function _resetCache() {
  cacheCategorias = null;
  cacheCentros = null;
}
