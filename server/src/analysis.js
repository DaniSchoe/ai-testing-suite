// KI-Analyse eines Testlaufs: ein im Modellkatalog festgelegtes Modell bewertet die Ergebnisse, setzt sie in Kontext
// und fasst sie zusammen. Das Ergebnis steht in runs.analysis; ein Fehler dabei lässt den Lauf nie scheitern.
import { many, one, query } from './db.js';
import { briefResult } from './analysisBrief.js';
import { ENDPOINT_SELECT, llmClientFor, resolveModel } from './models.js';

// Das Analysemodell ist je Mandant festgelegt; Ergebnisse eines Mandanten gehen nie an das Modell eines anderen.
const settingKey = (tenantId) => `analysis_model:${tenantId}`;

export async function getAnalysisSetting(tenantId) {
  const row = await one('select value from app_settings where key = $1', [settingKey(tenantId)]);
  if (!row?.value?.endpoint_id || !row.value.model) return null;
  const endpoint = await one('select id, name from endpoints where id = $1', [row.value.endpoint_id]);
  return endpoint ? { endpoint_id: endpoint.id, endpoint_name: endpoint.name, model: row.value.model } : null;
}

export async function setAnalysisSetting(tenantId, value, userId) {
  if (!value) {
    await query('delete from app_settings where key = $1', [settingKey(tenantId)]);
    return;
  }
  await query(
    `insert into app_settings (key, value, updated_by) values ($1, $2, $3)
     on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [settingKey(tenantId), JSON.stringify({ endpoint_id: value.endpoint_id, model: value.model }), userId ?? null],
  );
}

const SYSTEM = `Du bist Testanalyst für eine KI-Plattform (LiteLLM-Gateway und vLLM-Inferenzserver). Du bekommst die Ergebnisse eines Testlaufs als JSON.
Bewerte den Lauf, setze die Ergebnisse in Kontext und fasse sie zusammen. Schreibe auf Deutsch, sachlich und knapp, in Markdown mit genau diesen Abschnitten:
## Bewertung
Ein bis zwei Sätze mit Gesamturteil (gut, mit Einschränkungen oder kritisch).
## Ergebnisse im Kontext
Stichpunkte: was die Zahlen bedeuten (z. B. Score gegenüber Mindestscore, Schwierigkeitsstufen der Qualitätsfragen, Latenz gegenüber Parallelität, Abweichung von der Baseline). Nenne konkrete Werte.
## Auffälligkeiten und Empfehlungen
Stichpunkte; nur das, was die Daten hergeben. Erfinde nichts. Wenn alles unauffällig ist, sage das in einem Satz.
Hinweise: Qualitätsfragen sind von Stufe 1 (leicht) bis 5 (extrem schwer) gewichtet; nur sehr große Modelle lösen Stufe 5. Coding-Tests führen den Code des Modells aus. OCR-Tests lesen Rechnung und Prüfbericht als Bild.`;

// Analyse für einen beendeten Lauf erzeugen und speichern. Gibt den Status zurück.
export async function analyzeRun(runId, log = console) {
  const tenantId = (await one('select tenant_id from runs where id = $1', [runId]))?.tenant_id;
  const setting = tenantId ? await getAnalysisSetting(tenantId) : null;
  if (!setting) {
    await query(`update runs set analysis_status = 'skipped', analysis = null where id = $1`, [runId]);
    return 'skipped';
  }
  await query(`update runs set analysis_status = 'pending' where id = $1`, [runId]);
  try {
    const run = await one('select * from runs where id = $1', [runId]);
    const results = await many('select * from results where run_id = $1 order by started_at', [runId]);
    if (!run || results.length === 0) {
      await query(`update runs set analysis_status = 'skipped', analysis = null where id = $1`, [runId]);
      return 'skipped';
    }
    const endpoint = await one(`${ENDPOINT_SELECT} where e.id = $1`, [setting.endpoint_id]);
    if (!endpoint) throw new Error('Endpoint des Analysemodells existiert nicht mehr');
    const rows = await many('select * from endpoint_models where endpoint_id = $1', [endpoint.id]);
    const model = resolveModel(rows, setting.model).name;
    const payload = {
      lauf: run.label,
      ausgeloest: run.trigger,
      gesamt: { tests: results.length, bestanden: results.filter((r) => r.status === 'passed').length, fehlgeschlagen: results.filter((r) => r.status === 'failed').length, fehler: results.filter((r) => r.status === 'error').length },
      ergebnisse: results.map(briefResult),
    };
    const llm = llmClientFor(endpoint, { timeoutMs: 180_000 });
    const res = await llm.chat({
      model,
      temperature: 0.2,
      max_tokens: 3000,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Testlauf:\n${JSON.stringify(payload).slice(0, 24000)}` },
      ],
    });
    const text = res.content.trim();
    if (!text) throw new Error('Das Analysemodell hat keine Antwort geliefert');
    await query(`update runs set analysis_status = 'done', analysis = $2 where id = $1`, [
      runId,
      JSON.stringify({ text, model: setting.model, endpoint: endpoint.name, generated_at: new Date().toISOString() }),
    ]);
    return 'done';
  } catch (err) {
    log.warn?.(`KI-Analyse für Lauf ${runId} fehlgeschlagen: ${err.message}`);
    await query(`update runs set analysis_status = 'error', analysis = $2 where id = $1`, [
      runId,
      JSON.stringify({ error: err.message.slice(0, 400), model: setting.model, endpoint: setting.endpoint_name, generated_at: new Date().toISOString() }),
    ]);
    return 'error';
  }
}
