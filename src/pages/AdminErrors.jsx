import React, { useState, useEffect, useCallback } from 'react';

// Simple line chart component for trends
const TrendChart = ({ data, height = 60 }) => {
  if (!data || data.length === 0) return null;

  const max = Math.max(...data.map(d => d.count), 1);
  const points = data.map((d, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * 100;
    const y = 100 - (d.count / max) * 100;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg viewBox="0 0 100 100" style={{ width: '100%', height }} preserveAspectRatio="none">
      <polyline
        fill="none"
        stroke="var(--primary)"
        strokeWidth="2"
        points={points}
      />
    </svg>
  );
};

// Tabs component
const Tabs = ({ tabs, active, onChange }) => (
  <div className="admin-tabs">
    {tabs.map(tab => (
      <button
        key={tab.id}
        className={`admin-tab ${active === tab.id ? 'active' : ''}`}
        onClick={() => onChange(tab.id)}
      >
        {tab.label}
        {tab.count !== undefined && (
          <span className="admin-tab-badge">{tab.count}</span>
        )}
      </button>
    ))}
  </div>
);

// Dashboard Stats View
const DashboardView = ({ token }) => {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/admin/stats', {
        headers: { 'Authorization': `Basic ${token}` }
      });
      if (res.ok) {
        setStats(await res.json());
      }
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <p>Loading stats...</p>;
  if (!stats) return <p>Failed to load stats</p>;

  return (
    <div className="admin-dashboard">
      <div className="admin-stats-grid">
        <div className="admin-stat-card">
          <h3>Last 24 Hours</h3>
          <p className="admin-stat-value">{stats.last24h || 0}</p>
          <span className="admin-stat-label">errors</span>
        </div>
        <div className="admin-stat-card">
          <h3>Last 7 Days</h3>
          <p className="admin-stat-value">{stats.last7d || 0}</p>
          <span className="admin-stat-label">errors</span>
        </div>
        <div className="admin-stat-card">
          <h3>Open Issues</h3>
          <p className="admin-stat-value">{stats.open || 0}</p>
          <span className="admin-stat-label">issues</span>
        </div>
        <div className="admin-stat-card">
          <h3>Resolved</h3>
          <p className="admin-stat-value">{stats.resolved || 0}</p>
          <span className="admin-stat-label">issues</span>
        </div>
      </div>

      <div className="admin-section">
        <h3>14-Day Trend</h3>
        <div style={{ background: 'var(--bg-secondary)', padding: '1rem', borderRadius: '8px' }}>
          <TrendChart data={stats.dailyTrend} height={100} />
          {stats.dailyTrend && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
              {stats.dailyTrend.slice(0, 1).map(d => <span key={d.date}>{d.date}</span>)}
              <span>Today</span>
            </div>
          )}
        </div>
      </div>

      <div className="admin-grid-2col">
        <div className="admin-section">
          <h3>Errors by Category</h3>
          <div className="admin-list">
            {(stats.byCategory || []).map(c => (
              <div key={c.category} className="admin-list-item">
                <span className={`admin-badge ${c.category}`}>{c.category}</span>
                <span className="admin-list-value">{c.count}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="admin-section">
          <h3>Top App Versions</h3>
          <div className="admin-list">
            {(stats.byVersion || []).map(v => (
              <div key={v.app_version} className="admin-list-item">
                <span>{v.app_version || 'Unknown'}</span>
                <span className="admin-list-value">{v.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="admin-section">
        <h3>Top Open Issues</h3>
        {(stats.topIssues || []).length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>No open issues</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Type</th>
                <th>Pattern</th>
                <th>Count</th>
                <th>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {stats.topIssues.map(issue => (
                <tr key={issue.id}>
                  <td><span className={`admin-badge ${issue.category}`}>{issue.category}</span></td>
                  <td>{issue.error_type}</td>
                  <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {issue.message_pattern}
                  </td>
                  <td><strong>{issue.occurrence_count}</strong></td>
                  <td>{new Date(issue.last_seen_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

// Issues List View
const IssuesView = ({ token }) => {
  const [issues, setIssues] = useState([]);
  const [pagination, setPagination] = useState({ total: 0 });
  const [loading, setLoading] = useState(true);
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [filters, setFilters] = useState({ status: '', category: '' });
  const [selectedIds, setSelectedIds] = useState([]);

  const fetchIssues = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.status) params.append('status', filters.status);
      if (filters.category) params.append('category', filters.category);

      const res = await fetch(`/api/admin/issues?${params}`, {
        headers: { 'Authorization': `Basic ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setIssues(data.issues);
        setPagination(data.pagination);
      }
    } catch (err) {
      console.error('Failed to fetch issues:', err);
    } finally {
      setLoading(false);
    }
  }, [token, filters]);

  useEffect(() => {
    fetchIssues();
  }, [fetchIssues]);

  const handleStatusChange = async (issueId, newStatus) => {
    try {
      const res = await fetch(`/api/admin/issues/${issueId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Basic ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: newStatus })
      });
      if (res.ok) {
        fetchIssues();
      }
    } catch (err) {
      console.error('Failed to update issue:', err);
    }
  };

  const handleBulkAction = async (status) => {
    if (selectedIds.length === 0) return;
    try {
      const res = await fetch('/api/admin/issues/bulk', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ids: selectedIds, status })
      });
      if (res.ok) {
        setSelectedIds([]);
        fetchIssues();
      }
    } catch (err) {
      console.error('Failed to bulk update:', err);
    }
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === issues.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(issues.map(i => i.id));
    }
  };

  if (selectedIssue) {
    return (
      <IssueDetail
        token={token}
        issueId={selectedIssue}
        onBack={() => { setSelectedIssue(null); fetchIssues(); }}
      />
    );
  }

  return (
    <div className="admin-issues">
      <div className="admin-filters">
        <select
          value={filters.status}
          onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}
          className="form-input"
        >
          <option value="">All Statuses</option>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="ignored">Ignored</option>
        </select>
        <select
          value={filters.category}
          onChange={e => setFilters(f => ({ ...f, category: e.target.value }))}
          className="form-input"
        >
          <option value="">All Categories</option>
          <option value="crash">Crash</option>
          <option value="uncaught">Uncaught</option>
          <option value="update">Update</option>
          <option value="import">Import</option>
          <option value="file_system">File System</option>
        </select>
        {selectedIds.length > 0 && (
          <div className="admin-bulk-actions">
            <span>{selectedIds.length} selected</span>
            <button onClick={() => handleBulkAction('resolved')} className="btn-small">Resolve</button>
            <button onClick={() => handleBulkAction('ignored')} className="btn-small">Ignore</button>
          </div>
        )}
      </div>

      {loading ? (
        <p>Loading issues...</p>
      ) : issues.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '2rem' }}>No issues found</p>
      ) : (
        <>
          <table className="admin-table">
            <thead>
              <tr>
                <th style={{ width: '30px' }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.length === issues.length}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th>Status</th>
                <th>Category</th>
                <th>Type</th>
                <th>Pattern</th>
                <th>Count</th>
                <th>Last Seen</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {issues.map(issue => (
                <tr key={issue.id} className="admin-row">
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(issue.id)}
                      onChange={() => toggleSelect(issue.id)}
                    />
                  </td>
                  <td>
                    <span className={`admin-status ${issue.status}`}>{issue.status}</span>
                  </td>
                  <td><span className={`admin-badge ${issue.category}`}>{issue.category}</span></td>
                  <td>{issue.error_type}</td>
                  <td
                    style={{ maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                    onClick={() => setSelectedIssue(issue.id)}
                    title="Click to view details"
                  >
                    {issue.message_pattern}
                  </td>
                  <td><strong>{issue.occurrence_count}</strong></td>
                  <td>{new Date(issue.last_seen_at).toLocaleDateString()}</td>
                  <td>
                    <select
                      value={issue.status}
                      onChange={(e) => handleStatusChange(issue.id, e.target.value)}
                      className="form-input-small"
                    >
                      <option value="open">Open</option>
                      <option value="resolved">Resolved</option>
                      <option value="ignored">Ignored</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: '1rem', color: 'var(--text-muted)' }}>
            Showing {issues.length} of {pagination.total} issues
          </div>
        </>
      )}
    </div>
  );
};

// Issue Detail View
const IssueDetail = ({ token, issueId, onBack }) => {
  const [issue, setIssue] = useState(null);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState('');
  const [expandedReport, setExpandedReport] = useState(null);

  useEffect(() => {
    Promise.all([
      fetch(`/api/admin/issues/${issueId}`, {
        headers: { 'Authorization': `Basic ${token}` }
      }).then(r => r.json()),
      fetch(`/api/admin/issues/${issueId}/reports?limit=20`, {
        headers: { 'Authorization': `Basic ${token}` }
      }).then(r => r.json())
    ]).then(([issueData, reportsData]) => {
      setIssue(issueData);
      setReports(reportsData.reports || []);
      setNotes(issueData.issue?.notes || '');
      setLoading(false);
    }).catch(err => {
      console.error('Failed to load issue:', err);
      setLoading(false);
    });
  }, [token, issueId]);

  const saveNotes = async () => {
    try {
      await fetch(`/api/admin/issues/${issueId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Basic ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ notes })
      });
    } catch (err) {
      console.error('Failed to save notes:', err);
    }
  };

  if (loading) return <p>Loading...</p>;
  if (!issue?.issue) return <p>Issue not found</p>;

  const { issue: i, versionDistribution, platformDistribution, recentTrend } = issue;

  return (
    <div className="admin-issue-detail">
      <button onClick={onBack} className="btn-back">&larr; Back to Issues</button>

      <div className="admin-issue-header">
        <div>
          <span className={`admin-badge ${i.category}`}>{i.category}</span>
          <span className={`admin-status ${i.status}`}>{i.status}</span>
        </div>
        <h2>{i.error_type}</h2>
        <pre className="admin-pre">{i.message_pattern}</pre>
      </div>

      <div className="admin-grid-3col">
        <div className="admin-stat-card-small">
          <h4>Occurrences</h4>
          <p className="admin-stat-value">{i.occurrence_count}</p>
        </div>
        <div className="admin-stat-card-small">
          <h4>First Seen</h4>
          <p>{new Date(i.first_seen_at).toLocaleDateString()}</p>
        </div>
        <div className="admin-stat-card-small">
          <h4>Last Seen</h4>
          <p>{new Date(i.last_seen_at).toLocaleDateString()}</p>
        </div>
      </div>

      <div className="admin-grid-2col">
        <div className="admin-section">
          <h3>Version Distribution</h3>
          <div className="admin-list">
            {(versionDistribution || []).map(v => (
              <div key={v.app_version} className="admin-list-item">
                <span>{v.app_version || 'Unknown'}</span>
                <span className="admin-list-value">{v.count}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="admin-section">
          <h3>Platform Distribution</h3>
          <div className="admin-list">
            {(platformDistribution || []).map(p => (
              <div key={p.platform} className="admin-list-item">
                <span>{p.platform || 'Unknown'}</span>
                <span className="admin-list-value">{p.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="admin-section">
        <h3>7-Day Trend</h3>
        <TrendChart data={recentTrend} height={80} />
      </div>

      <div className="admin-section">
        <h3>Notes</h3>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add notes about this issue..."
          className="form-textarea"
          rows={3}
        />
        <button onClick={saveNotes} className="btn-primary" style={{ marginTop: '0.5rem' }}>Save Notes</button>
      </div>

      <div className="admin-section">
        <h3>Recent Reports ({reports.length})</h3>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Message</th>
              <th>Version</th>
              <th>Platform</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {reports.map(report => (
              <React.Fragment key={report.id}>
                <tr onClick={() => setExpandedReport(expandedReport === report.id ? null : report.id)} style={{ cursor: 'pointer' }}>
                  <td>{new Date(report.received_at).toLocaleString()}</td>
                  <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {report.message}
                  </td>
                  <td>{report.app_version}</td>
                  <td>{report.platform}</td>
                  <td>{expandedReport === report.id ? '▼' : '▶'}</td>
                </tr>
                {expandedReport === report.id && (
                  <tr className="admin-details-row">
                    <td colSpan="5">
                      <div style={{ padding: '1rem' }}>
                        <p><strong>Full Message:</strong></p>
                        <pre className="admin-pre">{report.message}</pre>
                        <p style={{ marginTop: '1rem' }}><strong>Context:</strong></p>
                        <pre className="admin-pre">{JSON.stringify(report.context, null, 2)}</pre>
                        <p style={{ marginTop: '1rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                          Session: {report.session_id} | Arch: {report.arch} | OS: {report.os_version}
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// Alerts View
const AlertsView = ({ token }) => {
  const [rules, setRules] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: '',
    rule_type: 'new_issue',
    category_filter: '',
    threshold_count: 10,
    threshold_window_minutes: 60,
    email: ''
  });

  const fetchData = useCallback(async () => {
    try {
      const [rulesRes, historyRes] = await Promise.all([
        fetch('/api/admin/alerts', { headers: { 'Authorization': `Basic ${token}` } }),
        fetch('/api/admin/alerts/history', { headers: { 'Authorization': `Basic ${token}` } })
      ]);
      if (rulesRes.ok) setRules((await rulesRes.json()).rules);
      if (historyRes.ok) setHistory((await historyRes.json()).history);
    } catch (err) {
      console.error('Failed to fetch alerts:', err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/admin/alerts', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(form)
      });
      if (res.ok) {
        setShowForm(false);
        setForm({ name: '', rule_type: 'new_issue', category_filter: '', threshold_count: 10, threshold_window_minutes: 60, email: '' });
        fetchData();
      }
    } catch (err) {
      console.error('Failed to create alert:', err);
    }
  };

  const toggleEnabled = async (id, enabled) => {
    try {
      await fetch(`/api/admin/alerts/${id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Basic ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ enabled: !enabled })
      });
      fetchData();
    } catch (err) {
      console.error('Failed to toggle alert:', err);
    }
  };

  const deleteRule = async (id) => {
    if (!confirm('Delete this alert rule?')) return;
    try {
      await fetch(`/api/admin/alerts/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Basic ${token}` }
      });
      fetchData();
    } catch (err) {
      console.error('Failed to delete alert:', err);
    }
  };

  if (loading) return <p>Loading alerts...</p>;

  return (
    <div className="admin-alerts">
      <div className="admin-section-header">
        <h3>Alert Rules</h3>
        <button onClick={() => setShowForm(!showForm)} className="btn-primary">
          {showForm ? 'Cancel' : '+ New Rule'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="admin-form">
          <div className="admin-form-grid">
            <div>
              <label>Name</label>
              <input
                type="text"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="form-input"
                required
              />
            </div>
            <div>
              <label>Rule Type</label>
              <select
                value={form.rule_type}
                onChange={e => setForm(f => ({ ...f, rule_type: e.target.value }))}
                className="form-input"
              >
                <option value="new_issue">New Issue</option>
                <option value="threshold">Threshold</option>
                <option value="spike">Spike Detection</option>
              </select>
            </div>
            <div>
              <label>Email</label>
              <input
                type="email"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                className="form-input"
                required
              />
            </div>
            <div>
              <label>Category Filter (optional)</label>
              <select
                value={form.category_filter}
                onChange={e => setForm(f => ({ ...f, category_filter: e.target.value }))}
                className="form-input"
              >
                <option value="">All Categories</option>
                <option value="crash">Crash</option>
                <option value="uncaught">Uncaught</option>
                <option value="update">Update</option>
                <option value="import">Import</option>
              </select>
            </div>
            {form.rule_type === 'threshold' && (
              <>
                <div>
                  <label>Threshold Count</label>
                  <input
                    type="number"
                    value={form.threshold_count}
                    onChange={e => setForm(f => ({ ...f, threshold_count: parseInt(e.target.value) }))}
                    className="form-input"
                    min="1"
                  />
                </div>
                <div>
                  <label>Window (minutes)</label>
                  <input
                    type="number"
                    value={form.threshold_window_minutes}
                    onChange={e => setForm(f => ({ ...f, threshold_window_minutes: parseInt(e.target.value) }))}
                    className="form-input"
                    min="1"
                  />
                </div>
              </>
            )}
          </div>
          <button type="submit" className="btn-primary" style={{ marginTop: '1rem' }}>Create Rule</button>
        </form>
      )}

      {rules.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', padding: '1rem' }}>No alert rules configured</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Category</th>
              <th>Email</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rules.map(rule => (
              <tr key={rule.id}>
                <td>{rule.name}</td>
                <td>{rule.rule_type}</td>
                <td>{rule.category_filter || 'All'}</td>
                <td>{rule.email}</td>
                <td>
                  <span className={`admin-status ${rule.enabled ? 'open' : 'ignored'}`}>
                    {rule.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </td>
                <td>
                  <button
                    onClick={() => toggleEnabled(rule.id, rule.enabled)}
                    className="btn-small"
                  >
                    {rule.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => deleteRule(rule.id)}
                    className="btn-small btn-danger"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="admin-section" style={{ marginTop: '2rem' }}>
        <h3>Alert History</h3>
        {history.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>No alerts triggered yet</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Rule</th>
                <th>Category</th>
                <th>Issue</th>
                <th>Sent</th>
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h.id}>
                  <td>{new Date(h.triggered_at).toLocaleString()}</td>
                  <td>{h.rule_name}</td>
                  <td>{h.category}</td>
                  <td>{h.message_pattern?.slice(0, 50) || '-'}</td>
                  <td>{h.notification_sent ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

// Main Admin Component
const AdminErrors = () => {
  const [creds, setCreds] = useState({ username: '', password: '' });
  const [token, setToken] = useState(() => sessionStorage.getItem('adminToken'));
  const [fetchError, setFetchError] = useState(null);
  const [activeTab, setActiveTab] = useState('dashboard');

  const handleLogin = async (e) => {
    e.preventDefault();
    const t = btoa(`${creds.username}:${creds.password}`);

    // Verify credentials
    try {
      const res = await fetch('/api/admin/stats', {
        headers: { 'Authorization': `Basic ${t}` }
      });
      if (res.status === 401) {
        setFetchError('Invalid credentials');
        return;
      }
      if (!res.ok) throw new Error('Server error');

      setToken(t);
      sessionStorage.setItem('adminToken', t);
      setFetchError(null);
    } catch (err) {
      setFetchError('Failed to connect');
    }
  };

  const handleLogout = () => {
    setToken(null);
    sessionStorage.removeItem('adminToken');
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
        {fetchError && <p style={{ color: 'var(--error)', marginTop: '1rem' }}>{fetchError}</p>}
      </div>
    );
  }

  const tabs = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'issues', label: 'Issues' },
    { id: 'alerts', label: 'Alerts' }
  ];

  return (
    <div className="container" style={{ padding: '2rem 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h1>Error Monitoring</h1>
        <button onClick={handleLogout} className="btn-outline">Logout</button>
      </div>

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      <div className="admin-content">
        {activeTab === 'dashboard' && <DashboardView token={token} />}
        {activeTab === 'issues' && <IssuesView token={token} />}
        {activeTab === 'alerts' && <AlertsView token={token} />}
      </div>
    </div>
  );
};

export default AdminErrors;
