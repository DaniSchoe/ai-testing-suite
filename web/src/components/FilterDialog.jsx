import { useState } from 'react';
import { EnvBadge, KindBadge, Modal } from '../lib.jsx';

// Auswahl von Modellen und ganzen Endpoints; mehrere Einträge werden im Dashboard summiert.
export default function FilterDialog({ filters, selection, canDev, onClose, onApply }) {
  const [models, setModels] = useState(new Set(selection.models));
  const [endpoints, setEndpoints] = useState(new Set(selection.endpoints));
  const [text, setText] = useState('');
  const toggle = (set, setter, key) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    setter(next);
  };
  const match = (v) => v.toLowerCase().includes(text.toLowerCase());
  const list = filters.filter((f) => match(f.name) || f.models.some((m) => match(m.alias)));
  return (
    <Modal
      title="Modelle und Endpoints"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => onApply({ models: [], endpoints: [] })}>
            Zurücksetzen
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={() => onApply({ models: [...models], endpoints: [...endpoints] })}>
            Übernehmen
          </button>
        </>
      }
    >
      <div className="hint" style={{ marginBottom: 10 }}>
        Ohne Auswahl werden alle produktiven Modelle und Endpoints berücksichtigt{canDev ? ' (Dev lässt sich hier gezielt dazuwählen)' : ''}. Mit Auswahl werden die
        gewählten Modelle und Endpoints zusammengefasst.
      </div>
      <input type="search" placeholder="Filtern…" value={text} onChange={(e) => setText(e.target.value)} style={{ marginBottom: 10 }} />
      <div className="pick-list" style={{ maxHeight: 380 }}>
        {list.map((f) => (
          <div key={f.id}>
            <label>
              <input type="checkbox" checked={endpoints.has(f.id)} onChange={() => toggle(endpoints, setEndpoints, f.id)} />
              <span style={{ fontWeight: 600 }}>
                {f.name} <KindBadge kind={f.kind} flavor={f.llm_flavor} /> <EnvBadge env={f.environment} />
              </span>
            </label>
            {f.models
              .filter((m) => !text || match(m.alias) || match(f.name))
              .map((m) => (
                <label key={m.name} style={{ paddingLeft: 34 }}>
                  <input type="checkbox" checked={models.has(m.alias)} onChange={() => toggle(models, setModels, m.alias)} />
                  <span>
                    {m.alias} {m.environment === 'dev' && <EnvBadge env="dev" />}
                  </span>
                </label>
              ))}
          </div>
        ))}
        {list.length === 0 && <div className="empty">Nichts gefunden</div>}
      </div>
    </Modal>
  );
}
