import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Bookmark, BookmarkCheck, Pencil, Play } from 'lucide-react';
import { api, can, Card, EnvBadge, fmt, KindBadge, Modal, StatusBadge, TYPE_LABELS, useApi, useUser, VisibilityBadge } from '../lib.jsx';
import { TypeIcons } from './TestBuilder.jsx';

const Row = ({ label, children }) => (
  <div className="meta-row">
    <div className="sub">{label}</div>
    <div>{children}</div>
  </div>
);

export default function MarketplaceDetail() {
  const { id } = useParams();
  const user = useUser();
  const navigate = useNavigate();
  const t = useApi(`/api/marketplace/${id}`);
  const [running, setRunning] = useState(false);
  const b = t.data;
  if (t.error) return <div className="empty">Test nicht gefunden</div>;
  if (!b) return null;

  async function toggleWatch() {
    await api(`/api/builds/${id}/watch`, { method: b.watched ? 'DELETE' : 'POST' });
    t.reload();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{b.name}</h1>
          <p>{b.description || 'Keine Beschreibung'}</p>
        </div>
        <div className="btn-row">
          <Link className="btn" to="/marketplace">
            <ArrowLeft size={15} /> Marketplace
          </Link>
          <button className="btn" onClick={toggleWatch}>
            {b.watched ? <BookmarkCheck size={15} /> : <Bookmark size={15} />} {b.watched ? 'Gemerkt' : 'Merken'}
          </button>
          {b.can_edit && can(user, 'tests.manage') && (
            <Link className="btn" to={`/test-builder/${b.id}`}>
              <Pencil size={15} /> Bearbeiten
            </Link>
          )}
          {can(user, 'runs.start') && (
            <button className="btn primary" onClick={() => setRunning(true)}>
              <Play size={15} /> Ausführen
            </button>
          )}
        </div>
      </div>
      <div className="two-col">
        <Card title="Details">
          <Row label="Herausgeber">{b.creator_name ?? '–'}</Row>
          <Row label="Maintainer">{b.maintainer_name ?? '–'}</Row>
          <Row label="Veröffentlicht">{b.published_at ? fmt.date(b.published_at) : `Privat, erstellt ${fmt.date(b.created_at)}`}</Row>
          <Row label="Sichtbar für">
            <VisibilityBadge visibility={b.visibility === 'private' ? 'user' : b.visibility} teamNames={(b.teams ?? []).map((x) => x.name)} />
          </Row>
          <Row label="Ausführungen">{b.run_count}</Row>
          <Row label="Auf Merklisten">{b.watch_count}</Row>
          <Row label="API-Key">{b.requires_api_key ? 'Eigener Key erforderlich' : (b.api_key_name ?? 'Key des Endpoints')}</Row>
          <Row label="Tags">
            <span className="tags">
              {(b.tags ?? []).map((x) => (
                <span className="tag" key={x}>
                  {x}
                </span>
              ))}
              {(b.tags ?? []).length === 0 && '–'}
            </span>
          </Row>
        </Card>
        <Card title="Was wird getestet?">
          <Row label="Endpoint">
            {b.endpoint ? (
              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {b.endpoint.name} <KindBadge kind={b.endpoint.kind} flavor={b.endpoint.llm_flavor} /> <EnvBadge env={b.endpoint.environment} />
              </span>
            ) : (
              '–'
            )}
          </Row>
          <Row label="Modelle">
            <span className="tags">
              {b.models.length ? b.models.map((m) => <span key={m} className="tag">{m}</span>) : 'Standardmodell des Endpoints'}
            </span>
          </Row>
          <Row label="Testarten">
            <TypeIcons types={b.types} link />
          </Row>
        </Card>
      </div>
      <Card title="Letzte Ausführungen" flush>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Von</th>
                <th>Status</th>
                <th className="num">Einzeltests</th>
              </tr>
            </thead>
            <tbody>
              {b.runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/runs/${r.id}`}>{fmt.date(r.created_at)}</Link>
                  </td>
                  <td>{r.user_name ?? '–'}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="num">
                    {r.passed}/{r.total}
                  </td>
                </tr>
              ))}
              {b.runs.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    Noch nicht ausgeführt
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      {running && <RunDialog build={b} onClose={() => setRunning(false)} onStarted={(run) => navigate(`/runs/${run.id}`)} />}
    </>
  );
}

function RunDialog({ build, onClose, onStarted }) {
  const keys = useApi('/api/api-keys');
  const [keyId, setKeyId] = useState('');
  const [error, setError] = useState(null);
  const needsKey = build.requires_api_key && !build.can_edit;

  async function start() {
    try {
      onStarted(await api(`/api/builds/${build.id}/run`, { method: 'POST', body: { api_key_id: keyId || null } }));
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Modal
      title={`„${build.name}“ ausführen`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" onClick={start} disabled={needsKey && !keyId}>
            <Play size={14} /> Starten
          </button>
        </>
      }
    >
      {error && <div className="error-box">{error}</div>}
      {build.requires_api_key ? (
        <label className="field">
          <span>Dein API-Key{needsKey ? '' : ' (optional)'}</span>
          <select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
            <option value="">{needsKey ? 'Bitte wählen…' : `Hinterlegter Key${build.api_key_name ? ` (${build.api_key_name})` : ''}`}</option>
            {(keys.data ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
          <div className="hint">Der Herausgeber hat festgelegt, dass der Test mit deinem Key läuft. So prüfst du deine eigenen Berechtigungen.</div>
        </label>
      ) : (
        <p>Der Test läuft mit dem vom Herausgeber hinterlegten Key{build.api_key_name ? ` „${build.api_key_name}“` : ' (Key des Endpoints)'}.</p>
      )}
    </Modal>
  );
}
