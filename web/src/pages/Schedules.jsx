import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { api, can, Card, describeSchedule, fmt, Modal, ScopePicker, scopeParams, useApi, useUser } from '../lib.jsx';

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MAX_PER_DAY = 3;

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const time = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

// Montag-basierte Monatsansicht: 6 Wochen, beginnend mit der Woche des Monatsersten.
function monthDays(anchor) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

export default function Schedules() {
  const user = useUser();
  const navigate = useNavigate();
  const schedules = useApi('/api/schedules');
  const [anchor, setAnchor] = useState(() => new Date());
  const [scope, setScope] = useState('me');
  const [dayOpen, setDayOpen] = useState(null);
  const days = useMemo(() => monthDays(anchor), [anchor]);
  const range = new URLSearchParams({ from: days[0].toISOString(), to: new Date(days[41].getTime() + 86400_000).toISOString(), ...scopeParams(scope) });
  const calendar = useApi(`/api/calendar?${range}`, { interval: 30000 });

  const byDay = useMemo(() => {
    const map = new Map();
    for (const e of calendar.data ?? []) {
      const k = dayKey(new Date(e.at));
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(e);
    }
    return map;
  }, [calendar.data]);

  const open = (e) => (e.kind === 'run' ? navigate(`/runs/${e.run_id}`) : e.build_id ? navigate(`/test-builder/${e.build_id}`) : null);
  const shift = (n) => setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + n, 1));
  const today = dayKey(new Date());
  const monthLabel = anchor.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

  async function toggle(s) {
    await api(`/api/schedules/${s.id}`, { method: 'PUT', body: { ...s, enabled: !s.enabled } });
    schedules.reload();
    calendar.reload();
  }

  async function remove(s) {
    if (!confirm(`Zeitplan "${s.name}" löschen?`)) return;
    await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
    schedules.reload();
    calendar.reload();
  }

  const target = (s) =>
    s.build_name ? `Test: ${s.build_name}` : s.target_kind === 'all' ? 'Alle Tests' : s.target_kind === 'suite' ? `Suite: ${s.suite_name}` : `Test: ${s.test_name}`;

  const Event = ({ e }) => (
    <button className={`cal-event ${e.kind === 'run' ? e.status : 'planned'}`} onClick={() => open(e)} title={`${time(e.at)} ${e.title}${e.kind === 'run' ? ` (${e.status})` : ' (geplant)'}`}>
      {time(e.at)} {e.title}
    </button>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Zeitpläne</h1>
          <p>
            Wann Tests laufen und gelaufen sind. Geplante Ausführungen sind gestrichelt, bisherige Läufe nach Ergebnis eingefärbt. Zeitpläne legst du
            im <Link to="/test-builder">Test-Builder</Link> an.
          </p>
        </div>
      </div>
      <Card
        title={monthLabel}
        action={
          <span className="btn-row" style={{ flexWrap: 'nowrap' }}>
            <ScopePicker value={scope} onChange={setScope} />
            <button className="btn sm" onClick={() => shift(-1)} aria-label="Voriger Monat">
              <ChevronLeft size={15} />
            </button>
            <button className="btn sm" onClick={() => setAnchor(new Date())}>
              Heute
            </button>
            <button className="btn sm" onClick={() => shift(1)} aria-label="Nächster Monat">
              <ChevronRight size={15} />
            </button>
          </span>
        }
        flush
      >
        <div className="cal-grid">
          {WEEKDAYS.map((d) => (
            <div key={d} className="cal-head">
              {d}
            </div>
          ))}
          {days.map((d) => {
            const events = byDay.get(dayKey(d)) ?? [];
            return (
              <div key={dayKey(d)} className={`cal-day${d.getMonth() !== anchor.getMonth() ? ' other' : ''}${dayKey(d) === today ? ' today' : ''}`}>
                <span className="cal-num">{d.getDate()}</span>
                {events.slice(0, MAX_PER_DAY).map((e, i) => (
                  <Event key={`${e.at}${i}`} e={e} />
                ))}
                {events.length > MAX_PER_DAY && (
                  <button className="cal-more btn ghost sm" style={{ padding: 0 }} onClick={() => setDayOpen({ date: d, events })}>
                    + {events.length - MAX_PER_DAY} weitere
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <h2 style={{ margin: '24px 0 10px', fontSize: 16 }}>Alle Zeitpläne</h2>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Ziel</th>
              <th>Wann</th>
              <th>Besitzer</th>
              <th>Status</th>
              <th className="num">Zuletzt</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(schedules.data ?? []).map((s) => {
              const editable = can(user, 'schedules.manage') && (s.owner_id === user.id || can(user, 'runs.manage_all'));
              return (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{s.name}</td>
                  <td>{s.build_id ? <Link to={`/test-builder/${s.build_id}`}>{target(s)}</Link> : target(s)}</td>
                  <td>
                    {describeSchedule({ schedule_id: s.id, schedule_run_at: s.run_at, schedule_cron: s.cron, schedule_enabled: true })}
                    {s.cron && <div className="sub">{s.timezone}</div>}
                  </td>
                  <td>{s.owner_name ?? '–'}</td>
                  <td>
                    {s.run_at ? (
                      <span className={`badge ${s.enabled ? 'queued' : 'passed'}`}>{s.enabled ? 'Geplant' : '✓ Ausgeführt'}</span>
                    ) : (
                      <button
                        className={`badge ${s.enabled ? 'passed' : 'cancelled'}`}
                        style={{ border: 0, cursor: editable ? 'pointer' : 'default' }}
                        disabled={!editable}
                        onClick={() => toggle(s)}
                      >
                        {s.enabled ? '✓ Aktiv' : '– Pausiert'}
                      </button>
                    )}
                  </td>
                  <td className="num sub">{fmt.ago(s.last_run_at)}</td>
                  <td className="num">
                    {editable && (
                      <button className="btn sm ghost danger" onClick={() => remove(s)} aria-label="Löschen">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {schedules.data?.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  Noch keine Zeitpläne. Lege sie im Test-Builder beim Ausführen eines Tests an.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {dayOpen && (
        <Modal
          title={dayOpen.date.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })}
          onClose={() => setDayOpen(null)}
          footer={
            <button className="btn" onClick={() => setDayOpen(null)}>
              Schließen
            </button>
          }
        >
          {dayOpen.events.map((e, i) => (
            <Event key={`${e.at}${i}`} e={e} />
          ))}
        </Modal>
      )}
    </>
  );
}
