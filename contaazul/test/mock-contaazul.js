// Mock do Conta Azul para desenvolvimento/teste local, sem tocar na conta real.
// Uso standalone:  npm run mock-ca   (sobe em http://localhost:4010)
// Uso em teste:    import { startMockCA } from './mock-contaazul.js'
import express from 'express';

export function startMockCA(port = 0) {
  const app = express();
  app.use(express.json());

  const db = { pessoas: [], vendas: [], contasAPagar: [], refreshCount: 0 };

  app.post('/oauth/token', (req, res) => {
    db.refreshCount++;
    res.json({
      access_token: 'mock-access-' + db.refreshCount,
      refresh_token: 'mock-refresh-' + db.refreshCount, // rotativo, como o real
      expires_in: 3600,
      token_type: 'Bearer',
    });
  });

  app.get('/v1/categorias', (req, res) => res.json([
    { id: 'cat-receita', nome: 'Fretes recebidos' },
    { id: 'cat-despesa', nome: 'Materiais Aplicados na Prestação de Serviços' },
  ]));

  app.get('/v1/centro-de-custo', (req, res) => res.json([
    { id: 'cc-fretes', nome: 'FRETES' },
    { id: 'cc-guincho', nome: 'GUINCHO' },
  ]));

  app.get('/v1/pessoas', (req, res) => {
    const doc = String(req.query.documento || '');
    res.json(db.pessoas.filter((p) => doc && p.documento === doc));
  });
  app.post('/v1/pessoas', (req, res) => {
    const id = 'pessoa-' + (db.pessoas.length + 1);
    const pessoa = { id, ...req.body };
    db.pessoas.push(pessoa);
    res.status(201).json(pessoa);
  });

  app.post('/v1/venda', (req, res) => {
    const id = 'venda-' + (db.vendas.length + 1);
    const venda = { id, ...req.body };
    db.vendas.push(venda);
    res.status(201).json(venda);
  });

  // conta a pagar: responde 202 SEM id (igual ao real)
  app.post('/v1/financeiro/eventos-financeiros/contas-a-pagar', (req, res) => {
    const id = 'cap-' + (db.contasAPagar.length + 1);
    db.contasAPagar.push({ id, codigo_referencia: req.body.codigo_referencia, valor: req.body.valor });
    res.status(202).json({});
  });

  app.get('/v1/financeiro/eventos-financeiros/contas-a-pagar/buscar', (req, res) => {
    const ref = String(req.query.codigo_referencia || '');
    res.json(db.contasAPagar.filter((c) => String(c.codigo_referencia || '').split(',').includes(ref)));
  });

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const p = server.address().port;
      resolve({ server, url: `http://localhost:${p}`, db, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// standalone
const direto = process.argv[1] && process.argv[1].endsWith('mock-contaazul.js');
if (direto) {
  startMockCA(Number(process.env.MOCK_PORT || 4010)).then(({ url }) => {
    console.log('Mock Conta Azul em ' + url);
  });
}
