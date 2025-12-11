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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
            {data.stats.map(s => (
              <div key={s.category} style={{ padding: '1rem', border: '1px solid #ccc', borderRadius: '8px' }}>
                <h3>{s.category}</h3>
                <p style={{ fontSize: '2rem', fontWeight: 'bold' }}>{s.count}</p>
              </div>
            ))}
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #333', textAlign: 'left' }}>
                <th style={{ padding: '0.5rem' }}>Time</th>
                <th style={{ padding: '0.5rem' }}>Category</th>
                <th style={{ padding: '0.5rem' }}>Type</th>
                <th style={{ padding: '0.5rem' }}>Message</th>
                <th style={{ padding: '0.5rem' }}>Platform</th>
                <th style={{ padding: '0.5rem' }}>Version</th>
                <th style={{ padding: '0.5rem' }}></th>
              </tr>
            </thead>
            <tbody>
              {data.reports.map(report => (
                <React.Fragment key={report.id}>
                  <tr 
                    style={{ borderBottom: expandedRow === report.id ? 'none' : '1px solid #eee', cursor: 'pointer', background: expandedRow === report.id ? '#f9f9f9' : 'transparent' }}
                    onClick={() => toggleRow(report.id)}
                  >
                    <td style={{ padding: '0.5rem' }}>{new Date(report.received_at).toLocaleString()}</td>
                    <td style={{ padding: '0.5rem' }}>
                      <span style={{ 
                        padding: '0.2rem 0.5rem', 
                        borderRadius: '4px', 
                        background: report.category === 'crash' ? '#ffcccc' : '#e0e0e0',
                        color: report.category === 'crash' ? '#990000' : '#333'
                      }}>
                        {report.category}
                      </span>
                    </td>
                    <td style={{ padding: '0.5rem' }}>{report.error_type}</td>
                    <td style={{ padding: '0.5rem', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {report.message}
                    </td>
                    <td style={{ padding: '0.5rem' }}>{report.platform} / {report.os_version}</td>
                    <td style={{ padding: '0.5rem' }}>{report.app_version}</td>
                    <td style={{ padding: '0.5rem', textAlign: 'right' }}>
                      {expandedRow === report.id ? '▼' : '▶'}
                    </td>
                  </tr>
                  {expandedRow === report.id && (
                    <tr style={{ borderBottom: '1px solid #eee', background: '#f9f9f9' }}>
                      <td colSpan="7" style={{ padding: '1rem' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                          <div>
                            <strong>Full Message:</strong>
                            <pre style={{ whiteSpace: 'pre-wrap', marginTop: '0.5rem', background: '#fff', padding: '0.5rem', border: '1px solid #ddd', borderRadius: '4px' }}>
                              {report.message}
                            </pre>
                          </div>
                          <div>
                            <strong>Context:</strong>
                            {Object.keys(report.context).length > 0 ? (
                              <pre style={{ whiteSpace: 'pre-wrap', marginTop: '0.5rem', background: '#fff', padding: '0.5rem', border: '1px solid #ddd', borderRadius: '4px', overflowX: 'auto' }}>
                                {JSON.stringify(report.context, null, 2)}
                              </pre>
                            ) : (
                              <p style={{ fontStyle: 'italic', color: '#666' }}>No additional context</p>
                            )}
                          </div>
                          <div style={{ fontSize: '0.8rem', color: '#666' }}>
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
