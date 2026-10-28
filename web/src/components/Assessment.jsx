// Einstufung einer Plattform: Prüfpunkte mit Begründung für Sicherheit, Produktionsreife und die Souveränitätsziele.
import { Fragment, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Pencil, TriangleAlert, XCircle } from 'lucide-react';
import { api, Card, ErrorBox, Field, Loading, Modal, useAction, useApi } from '../lib.jsx';

const CHECK = {
  pass: [CheckCircle2, 'var(--ok, #1a9b5f)', 'erfüllt'],
  warn: [TriangleAlert, 'var(--warn, #c77d12)', 'teilweise'],
  fail: [XCircle, 'var(--bad, #dc2626)', 'nicht erfüllt'],
  unknown: [CircleHelp, 'var(--text-2)', 'unbekannt'],
};
const LEVEL = { good: ['passed', 'gut'], warn: ['warn', 'mit Lücken'], bad: ['failed', 'unzureichend'], incomplete: ['queued', 'zu wenig Daten'] };
const SOURCE = { inventory: 'Inventar', topology: 'Topologie', portfolio: 'Modellportfolio', test: 'Tests', status: 'Betriebszustand' };
const GOAL_STATUS = { ok: ['passed', 'erfüllt'], gap: ['failed', 'unter Mindeststufe'], unrated: ['queued', 'nicht bewertet'] };

export function Checks({ checks }) {
  return (
    <table>
      <tbody>
        {checks.map((c) => {
          const [Icon, color, text] = CHECK[c.status];
          return (
            <tr key={c.id}>
              <td style={{ width: 28 }}>
                <Icon size={17} style={{ color }} aria-label={text} />
              </td>
              <td>
                {c.label}
                <div className="sub">{c.detail}</div>
              </td>
              <td className="sub" style={{ whiteSpace: 'nowrap' }}>
                {SOURCE[c.source] ?? c.source} · Gewicht {c.weight}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// Aufklappbarer Bereich; die Kopfzeile zeigt, wie viel erfüllt ist.
function Collapsible({ title, summary, badge, sub, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="card collapsible">
      <button type="button" className="card-head collapsible-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <div>
          <h2>
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />} {title} {badge}
          </h2>
          {sub && <div className="sub">{sub}</div>}
        </div>
        <span className="collapsible-count">{summary}</span>
      </button>
      {open && <div className="card-body flush">{children}</div>}
    </section>
  );
}

function Block({ title, data, sub }) {
  const [cls, text] = LEVEL[data.level];
  const met = data.checks.filter((c) => c.status === 'pass').length;
  return (
    <Collapsible
      title={title}
      badge={<span className={`badge ${cls}`}>{text}</span>}
      summary={`${met}/${data.checks.length} erfüllt`}
      sub={`${sub} ${data.score != null ? `Punktzahl ${data.score} von 100, ` : ''}Abdeckung ${Math.round(data.coverage * 100)} %.`}
    >
      <Checks checks={data.checks} />
    </Collapsible>
  );
}

export function SovereigntyGoals({ data, editable, onChanged, platformId, defaultOpen = false }) {
  const [open, setOpen] = useState(null);
  const [override, setOverride] = useState(null);
  const s = data.sovereignty;
  return (
    <>
      <Collapsible
        title="Souveränitätsziele"
        defaultOpen={defaultOpen}
        summary={`${s.goals.filter((g) => g.status === 'ok').length}/${s.goals.length} erfüllt`}
        sub={`Gesamt: ${s.overall != null ? `SEAL-${s.overall}` : 'nicht bewertet'} · geforderte Mindeststufe SEAL-${s.min_level}. Ein Klick auf ein Ziel zeigt die Begründung.`}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th />
                <th>Ziel</th>
                <th className="num">Abgeleitet</th>
                <th className="num">Wirksam</th>
                <th>Stand</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {s.goals.map((g) => {
                const [cls, text] = GOAL_STATUS[g.status];
                const isOpen = open === g.key;
                return (
                  <Fragment key={g.key}>
                    <tr className="goal-row" onClick={() => setOpen(isOpen ? null : g.key)}>
                      <td style={{ width: 24 }}>{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
                      <td>
                        {g.key} <span className="sub">{g.name}</span>
                        {g.override && <div className="sub">Überschrieben auf SEAL-{g.override.level}: „{g.override.reason}“</div>}
                      </td>
                      <td className="num">{g.derived ?? '–'}</td>
                      <td className="num">
                        <strong>{g.effective ?? '–'}</strong>
                      </td>
                      <td>
                        <span className={`badge ${cls}`}>{text}</span>
                      </td>
                      <td className="num">
                        {editable && (
                          <button
                            className="btn sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOverride(g);
                            }}
                          >
                            <Pencil size={13} /> Überschreiben
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td />
                        <td colSpan={5}>
                          <div className="sub" style={{ marginBottom: 6 }}>
                            Abgeleitet aus {g.checks.length} Prüfpunkten
                            {g.score != null ? `, Punktzahl ${g.score} von 100` : ''}, Abdeckung {Math.round(g.coverage * 100)} %.
                            {g.derived === null && ' Für eine Einstufung liegen zu wenig Belege vor (mindestens 40 % Abdeckung).'}
                            {g.capped_by && ` Auf SEAL-2 begrenzt wegen: ${g.capped_by}.`}
                            {g.override && ` Überschrieben von ${g.override.by ?? 'unbekannt'}.`}
                          </div>
                          <Checks checks={g.checks} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Collapsible>
      <div className="hint">
        Stufen aus der Punktzahl der Prüfpunkte: ab 95 % SEAL-4, ab 80 % SEAL-3, ab 60 % SEAL-2, ab 30 % SEAL-1, darunter SEAL-0. Ein nicht erfüllter Prüfpunkt mit hohem Gewicht begrenzt das Ziel auf SEAL-2.
      </div>
      {override && <OverrideDialog goal={override} platformId={platformId ?? data.platform.id} onClose={() => setOverride(null)} onDone={() => (setOverride(null), onChanged?.())} />}
    </>
  );
}

function OverrideDialog({ goal, platformId, onClose, onDone }) {
  const [level, setLevel] = useState(goal.override?.level ?? goal.effective ?? 0);
  const [reason, setReason] = useState(goal.override?.reason ?? '');
  const [run, error, busy] = useAction();
  const current = useApi(`/api/platforms/${platformId}`);
  const save = (remove) =>
    run(async () => {
      const overrides = { ...(current.data?.sovereignty?.overrides ?? {}) };
      if (remove) delete overrides[goal.key];
      else overrides[goal.key] = { level, reason };
      await api(`/api/platforms/${platformId}/sovereignty`, { method: 'PUT', body: { min_level: current.data?.sovereignty?.min_level, overrides } });
      onDone();
    });
  return (
    <Modal
      title={`${goal.key} überschreiben`}
      onClose={onClose}
      footer={
        <>
          {goal.override && (
            <button className="btn" disabled={busy} onClick={() => save(true)}>
              Überschreibung aufheben
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn primary" disabled={busy || !reason.trim() || !current.data} onClick={() => save(false)}>
            Speichern
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="hint" style={{ marginTop: 0 }}>
        Abgeleitet wurde {goal.derived != null ? `SEAL-${goal.derived}` : 'keine Stufe'}. Die Überschreibung ersetzt die abgeleitete Stufe und wird mit Begründung, Person und Zeitpunkt festgehalten.
      </p>
      <Field label="Stufe">
        <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
          {[0, 1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>
              SEAL-{n}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Begründung (Pflicht)">
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

// Einstufung der Plattform: Sicherheit, Produktionsreife und Souveränitätsziele.
export function AssessmentView({ platformId, editable }) {
  const data = useApi(`/api/platforms/${platformId}/assessment`);
  return (
    <Loading state={data}>
      {(d) => (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            Die Einstufung entsteht aus Inventar, Topologie, Modellportfolio, Betriebszustand und den neuesten Prüfergebnissen. Fehlende Belege zählen nicht als bestanden; sie senken nur die Abdeckung.
          </p>
          <Block title="Sicherheit" data={d.security} sub="Verschlüsselung, Zugriffskontrolle, Sicherheitstests, Isolation und offene Findings." />
          <Block title="Produktionsreife" data={d.production} sub="Betrieb, Redundanz, Überwachung, Tests und Zeitplan." />
          <SovereigntyGoals data={d} editable={editable} onChanged={data.reload} platformId={platformId} />
        </>
      )}
    </Loading>
  );
}
