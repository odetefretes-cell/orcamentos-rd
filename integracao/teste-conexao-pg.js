/* ============================================================================
   Teste de conexão com o servidor novo (PostgreSQL via API).
   Roda no Cloud Shell, SEM fazer deploy de nenhuma função — só confere que o
   ambiente das Cloud Functions consegue ler e gravar no seu servidor.

   Uso:
     cd ~/orcamentos-rd/integracao
     OBS_API_URL='https://api.obstransportes.com.br' \
     OBS_API_TOKEN='SEU_TOKEN' \
     node teste-conexao-pg.js
   ============================================================================ */
const { pgDb, listar, _req } = require('./pg-api');

(async () => {
  try {
    console.log('→ API:', process.env.OBS_API_URL || '(padrão)');
    const saude = await _req('GET', '/api/health');
    console.log('→ saúde:', JSON.stringify(saude));

    const leads = await listar('crm_leads');
    console.log('→ leads no PostgreSQL:', leads.length);

    // teste de gravação num documento TEMPORÁRIO (não interfere em nada real)
    const ref = pgDb.collection('crm_leads').doc('_teste_conexao_pg');
    await ref.set({ ok: true, quando: new Date().toISOString(), origem: 'teste-conexao' });
    const lido = await ref.get();
    console.log('→ gravou e leu de volta:', lido.exists, JSON.stringify(lido.data()));
    await _req('DELETE', '/api/crm_leads/_teste_conexao_pg');
    console.log('→ documento de teste apagado.');

    console.log('\n✅ CONEXÃO OK — as Functions conseguem LER e GRAVAR no seu servidor.');
  } catch (e) {
    console.error('\n❌ FALHOU:', e && e.message || e);
    process.exit(1);
  }
})();
