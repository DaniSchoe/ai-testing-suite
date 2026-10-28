import { useApi } from '../lib.jsx';

// Copyright-Hinweis mit Firmenlogo am Seitenende. Logo: /company-logo.png (ersetzbar), Text über COPYRIGHT_HOLDER.
export default function Footer() {
  const info = useApi('/api/info');
  const year = new Date().getFullYear();
  return (
    <footer className="app-footer">
      <img src="/company-logo.png" alt="" className="footer-logo" onError={(e) => (e.currentTarget.style.display = 'none')} />
      <div>
        © {year} {info.data?.copyright ?? 'ORCA'}. Alle Rechte vorbehalten.
      </div>
    </footer>
  );
}
