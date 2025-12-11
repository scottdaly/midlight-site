import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

const AdminErrors = () => {
  const [creds, setCreds] = useState({ username: '', password: '' });
  const [token, setToken] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [expandedRow, setExpandedRow] = useState(null);

  useEffect(() => {
    if (token) {
      fetchData();
    }
  }, [token]);

  const toggleRow = (id) => {
    setExpandedRow(expandedRow === id ? null : id);
  };

  const fetchData = async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch('/api/admin/errors', {
        headers: {
          'Authorization': `Basic ${token}`
        }
      });
      
      if (res.status === 401) {
        setToken(null); // Reset if invalid
        setFetchError('Invalid credentials');
        return;
      }
      
      if (!res.ok) throw new Error('Failed to fetch');
      
      const json = await res.json();
      setData(json);
    } catch (err) {
      setFetchError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = (e) => {
    e.preventDefault();
    const t = btoa(`${creds.username}:${creds.password}`);
    setToken(t);
  };

  if (!token) {
    return (
      <div className="container" style={{ padding: '4rem 0', maxWidth: '400px' }}>
        <h2>Admin Login</h2>
        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '2rem' }}>
          <input
            type="text"
            className="form-input"
            placeholder="Username"
            value={creds.username}
            onChange={e => setCreds({...creds, username: e.target.value})}
          />
          <input
            type="password"
            className="form-input"
            placeholder="Password"
            value={creds.password}
            onChange={e => setCreds({...creds, password: e.target.value})}
          />
          <button type="submit" className="btn-primary">Login</button>
        </form>
        {fetchError && <p style={{ color: 'red', marginTop: '1rem' }}>{fetchError}</p>}
      </div>
    );
  }

  return (
    <div className="container" style={{ padding: '2rem 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1>Error Reports</h1>
        <button onClick={() => setToken(null)} style={{ background: 'transparent', border: '1px solid currentColor', padding: '0.5rem 1rem', cursor: 'pointer' }}>Logout</button>
      </div>

      {loading && <p>Loading...</p>}
      
      {data && (
        <>
          <div className="admin-stats-grid">
            {data.stats.map(s => (
              <div key={s.category} className="admin-stat-card">
                <h3>{s.category}</h3>
                <p style={{ fontSize: '2rem', fontWeight: 'bold', color: 'var(--text-main)' }}>{s.count}</p>
              </div>
            ))}
          </div>

          <table className="admin-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Category</th>
                <th>Type</th>
                <th>Message</th>
                <th>Platform</th>
                <th>Version</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.reports.map(report => (
                <React.Fragment key={report.id}>
                  <tr 
                    className={`admin-row ${expandedRow === report.id ? 'expanded' : ''}`}
                    onClick={() => toggleRow(report.id)}
                  >
                    <td>{new Date(report.received_at).toLocaleString()}</td>
                    <td>
                      <span className={`admin-badge ${report.category === 'crash' ? 'crash' : ''}`}>
                        {report.category}
                      </span>
                    </td>
                    <td>{report.error_type}</td>
                    <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {report.message}
                    </td>
                    <td>{report.platform} / {report.os_version}</td>
                    <td>{report.app_version}</td>
                    <td style={{ textAlign: 'right' }}>
                      {expandedRow === report.id ? '▼' : '▶'}
                    </td>
                  </tr>
                  {expandedRow === report.id && (
                    <tr className="admin-details-row">
                      <td colSpan="7" style={{ padding: '1rem' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                          <div>
                            <strong>Full Message:</strong>
                            <pre className="admin-pre">
                              {report.message}
                            </pre>
                          </div>
                          <div>
                            <strong>Context:</strong>
                            {Object.keys(report.context).length > 0 ? (
                              <pre className="admin-pre">
                                {JSON.stringify(report.context, null, 2)}
                              </pre>
                            ) : (
                              <p style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>No additional context</p>
                            )}
                          </div>
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                            <strong>Session ID:</strong> {report.session_id} | <strong>Arch:</strong> {report.arch}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
};

export default AdminErrors;
