/* ============================================================================
   OBS — driver.js  (a CADEIA DE GATILHOS, reimplementada como orquestração)

   No Firestore havia gatilhos encadeados:
     update em crm_leads_intake  → processarLeadCompleto (IA)
       → que dava update em crm_leads_intake → criarLeadNoCrm
         → que dava update em crm_leads → prepararResposta (envio)

   No PostgreSQL NÃO existem gatilhos. Este driver os SUBSTITUI chamando os
   MESMOS handlers do pipeline (sem alterá-los), na ordem certa, uma vez por
   ciclo do cron. Os handlers já são idempotentes (guards iaProcessado,
   leadCriado, respostaEnviada / claim atômico), então re-execuções não
   duplicam trabalho nem mensagens.

   Dependências são INJETADAS (fsdb, listar, handlers) para o selftest poder
   rodar tudo em memória sem tocar nos arquivos do pipeline.

   ----------------------------------------------------------------------------
   FORMATO DO EVENTO (CloudEvent-like) que cada handler espera:

     processarLeadCompleto(event):
        lê event.data.after.data()  → doc atual do intake
            event.data.after.ref    → docRef (faz .update)
            event.params.telefone
        NÃO lê event.data.before.

     criarLeadNoCrm(event):
        lê event.data.after.data()  → doc atual do intake
            event.data.after.ref    → docRef (usado em db.runTransaction + .update)
            event.params.telefone
        NÃO lê event.data.before.

   Por isso montamos:
     { params:{telefone},
       data:{ before:{exists:false, data:()=>({}), ref},
              after:{ exists:true, id:telefone, data:()=>docAtual, ref } } }
   com `ref = fsdb.collection('crm_leads_intake').doc(telefone)` — o MESMO db
   que os handlers usam via getFirestore(), para que as escritas (update/tx)
   persistam de fato.
   ============================================================================ */

'use strict';

function criarDriver({ fsdb, listar, handlers, log }) {
  const {
    fecharLeadsCompletos,
    processarLeadCompleto,
    criarLeadNoCrm,
    enviarPendentesPG,
  } = handlers;
  const logger = log || console;

  const INTAKE = 'crm_leads_intake';

  /* Monta o event CloudEvent-like que os onDocumentUpdated esperam. */
  function buildEvent(telefone, docAtual) {
    const ref = fsdb.collection(INTAKE).doc(telefone);
    return {
      params: { telefone },
      data: {
        before: { exists: false, id: telefone, data: () => ({}), ref },
        after: { exists: true, id: telefone, data: () => docAtual, ref },
      },
    };
  }

  /* Relê o doc do intake fresco (garante que o guard seja avaliado sobre o
     estado REAL persistido, não sobre a cópia do listar). */
  async function lerIntake(id) {
    const snap = await fsdb.collection(INTAKE).doc(id).get();
    return snap.exists ? snap.data() : null;
  }

  async function drivePipelineOnce() {
    // (a) Fecha leads em silêncio há > janela (60s) — handler REAL. Marca
    //     statusIntake='completo' nos que estavam 'recebendo'.
    await fecharLeadsCompletos();

    // (b) Etapa IA: para cada intake 'completo' e ainda NÃO processado, chama
    //     processarLeadCompleto (extrai + decide). Inclui os fechados na hora
    //     pelo webhook (fechadoManual), que não passam por fecharLeadsCompletos.
    let intakes = await listar(INTAKE);
    for (const it of intakes) {
      if (it.statusIntake !== 'completo' || it.iaProcessado) continue;
      const cur = await lerIntake(it.id);
      if (!cur || cur.statusIntake !== 'completo' || cur.iaProcessado) continue;
      try {
        await processarLeadCompleto(buildEvent(it.id, cur));
      } catch (e) {
        logger.error(`[driver] processarLeadCompleto ${it.id}:`, (e && e.message) || e);
      }
    }

    // (c) Etapa CRM: para cada intake 'automatico' ou 'aguardando_humano' e
    //     ainda SEM lead criado, chama criarLeadNoCrm (cria o lead + calcula a
    //     média no backend). Reler o intake porque (b) acabou de alterá-lo.
    intakes = await listar(INTAKE);
    for (const it of intakes) {
      const st = it.statusIntake;
      if ((st !== 'automatico' && st !== 'aguardando_humano') || it.leadCriado) continue;
      const cur = await lerIntake(it.id);
      if (!cur) continue;
      if ((cur.statusIntake !== 'automatico' && cur.statusIntake !== 'aguardando_humano') || cur.leadCriado) continue;
      try {
        await criarLeadNoCrm(buildEvent(it.id, cur));
      } catch (e) {
        logger.error(`[driver] criarLeadNoCrm ${it.id}:`, (e && e.message) || e);
      }
    }

    // (d) Envio: o verificador robusto do pipeline (modo PostgreSQL) manda a
    //     média / o aviso humano pendentes, com trava atômica /claim.
    await enviarPendentesPG();
  }

  return { drivePipelineOnce, buildEvent };
}

module.exports = { criarDriver };
