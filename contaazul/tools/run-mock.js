// Sobe o mock do Conta Azul standalone para desenvolvimento local.
//   node tools/run-mock.js     (ou: npm run mock-ca)
import { startMockCA } from '../test/mock-contaazul.js';

const port = Number(process.env.MOCK_PORT || 4010);
startMockCA(port).then(({ url }) => {
  console.log('Mock Conta Azul rodando em ' + url);
});
