import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { api, apiPost, apiDelete } from '../utils/api';
import Header from '../components/Header';
import Footer from '../components/Footer';

// Icons
const SparkleIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275Z" />
  </svg>
);

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5"/>
  </svg>
);

const AlertIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" x2="12" y1="8" y2="12"/>
    <line x1="12" x2="12.01" y1="16" y2="16"/>
  </svg>
);

export default function Account() {
  const { user, fetchUser } = useAuth();
  const [subscription, setSubscription] = useState(null);
  const [usage, setUsage] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Fetch account data
  useEffect(() => {
    async function fetchData() {
      try {
        const [subRes, usageRes, sessionsRes] = await Promise.all([
          api('/api/user/subscription'),
          api('/api/user/usage'),
          api('/api/user/sessions'),
        ]);

        if (subRes.ok) {
          const data = await subRes.json();
          setSubscription(data.subscription);
        }

        if (usageRes.ok) {
          const data = await usageRes.json();
          setUsage(data);
        }

        if (sessionsRes.ok) {
          const data = await sessionsRes.json();
          setSessions(data.sessions || []);
        }
      } catch (err) {
        console.error('Failed to fetch account data:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  // Handle Stripe checkout
  const handleUpgrade = async (priceType) => {
    setActionLoading('upgrade');
    try {
      const response = await apiPost('/api/subscription/checkout', {
        priceType,
        successUrl: `${window.location.origin}/account?upgraded=true`,
        cancelUrl: `${window.location.origin}/account`,
      });

      if (response.ok) {
        const data = await response.json();
        window.location.href = data.url;
      }
    } catch (err) {
      console.error('Checkout error:', err);
    } finally {
      setActionLoading(null);
    }
  };

  // Handle Stripe portal
  const handleManageBilling = async () => {
    setActionLoading('portal');
    try {
      const response = await apiPost('/api/subscription/portal', {
        returnUrl: `${window.location.origin}/account`,
      });

      if (response.ok) {
        const data = await response.json();
        window.location.href = data.url;
      }
    } catch (err) {
      console.error('Portal error:', err);
    } finally {
      setActionLoading(null);
    }
  };

  // Logout all sessions
  const handleLogoutAll = async () => {
    setActionLoading('sessions');
    try {
      const response = await apiDelete('/api/user/sessions');
      if (response.ok) {
        // Will be logged out, redirect to login
        window.location.href = '/login';
      }
    } catch (err) {
      console.error('Logout all error:', err);
    } finally {
      setActionLoading(null);
    }
  };

  // Delete account
  const handleDeleteAccount = async () => {
    setActionLoading('delete');
    try {
      const response = await apiDelete('/api/user/me');
      if (response.ok) {
        window.location.href = '/';
      }
    } catch (err) {
      console.error('Delete account error:', err);
    } finally {
      setActionLoading(null);
      setShowDeleteConfirm(false);
    }
  };

  const isPremium = subscription?.tier === 'premium' && subscription?.status === 'active';
  const usagePercent = usage?.quota?.limit
    ? Math.min((usage.quota.used / usage.quota.limit) * 100, 100)
    : 0;

  return (
    <div className="app">
      <Header />

      <main className="account-page">
        <div className="container">
          <h1>Account Settings</h1>

          {loading ? (
            <div className="account-loading">
              <div className="auth-loading-spinner" />
            </div>
          ) : (
            <div className="account-sections">
              {/* Profile Section */}
              <section className="account-section">
                <h2>Profile</h2>
                <div className="account-card">
                  <div className="profile-info">
                    {user?.avatarUrl ? (
                      <img
                        src={user.avatarUrl}
                        alt={user.displayName || 'Profile'}
                        className="profile-avatar"
                      />
                    ) : (
                      <div className="profile-avatar-fallback">
                        {(user?.displayName || user?.email || 'U').charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="profile-details">
                      <h3>{user?.displayName || 'Midlight User'}</h3>
                      <p>{user?.email}</p>
                    </div>
                  </div>
                </div>
              </section>

              {/* Subscription Section */}
              <section className="account-section">
                <h2>Subscription</h2>
                {subscription?.status === 'cancelled' && (
                  <p className="subscription-cancelled-note">
                    Your Premium subscription will end on {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
                  </p>
                )}
                <div className="plan-cards">
                  {/* Free Plan Card */}
                  <div className={`plan-card ${!isPremium ? 'current' : ''}`}>
                    <div className="plan-header">
                      <h3>Free</h3>
                      <div className="plan-price">
                        <span className="price-amount">$0</span>
                        <span className="price-period">/month</span>
                      </div>
                    </div>
                    <ul className="plan-features">
                      <li><CheckIcon /> 100 AI queries per month</li>
                      <li><CheckIcon /> Basic AI models</li>
                      <li><CheckIcon /> Cloud sync</li>
                      <li><CheckIcon /> All editor features</li>
                    </ul>
                    <div className="plan-action">
                      {!isPremium ? (
                        <span className="plan-current-label">Current Plan</span>
                      ) : (
                        <span className="plan-downgrade-note">Downgrade via billing portal</span>
                      )}
                    </div>
                  </div>

                  {/* Premium Plan Card */}
                  <div className={`plan-card premium ${isPremium ? 'current' : ''}`}>
                    <div className="plan-badge">Most Popular</div>
                    <div className="plan-header">
                      <h3><SparkleIcon /> Premium</h3>
                      <div className="plan-price">
                        <span className="price-amount">$20</span>
                        <span className="price-period">/month</span>
                      </div>
                      <div className="plan-price-alt">or $180/year (save 25%)</div>
                    </div>
                    <ul className="plan-features">
                      <li><CheckIcon /> Unlimited AI queries</li>
                      <li><CheckIcon /> Advanced AI models</li>
                      <li><CheckIcon /> Priority support</li>
                      <li><CheckIcon /> Early access to new features</li>
                    </ul>
                    <div className="plan-action">
                      {isPremium ? (
                        <>
                          <span className="plan-current-label">Current Plan</span>
                          {subscription?.billingInterval && (
                            <p className="plan-billing-info">
                              Billed {subscription.billingInterval}
                              {subscription.currentPeriodEnd && (
                                <> &middot; Renews {new Date(subscription.currentPeriodEnd).toLocaleDateString()}</>
                              )}
                            </p>
                          )}
                          <button
                            onClick={handleManageBilling}
                            className="btn-secondary plan-btn"
                            disabled={actionLoading === 'portal'}
                          >
                            {actionLoading === 'portal' ? 'Loading...' : 'Manage Billing'}
                          </button>
                        </>
                      ) : (
                        <div className="plan-upgrade-buttons">
                          <button
                            onClick={() => handleUpgrade('monthly')}
                            className="btn-primary plan-btn"
                            disabled={actionLoading === 'upgrade'}
                          >
                            {actionLoading === 'upgrade' ? 'Loading...' : 'Upgrade Monthly'}
                          </button>
                          <button
                            onClick={() => handleUpgrade('yearly')}
                            className="btn-secondary plan-btn"
                            disabled={actionLoading === 'upgrade'}
                          >
                            Upgrade Yearly
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </section>

              {/* Usage Section */}
              <section className="account-section">
                <h2>Usage This Month</h2>
                <div className="account-card">
                  {isPremium ? (
                    <div className="usage-unlimited">
                      <CheckIcon />
                      <span>Unlimited queries with Premium</span>
                    </div>
                  ) : (
                    <>
                      <div className="usage-stats">
                        <div className="usage-number">
                          <span className="usage-current">{usage?.quota?.used || 0}</span>
                          <span className="usage-limit">/ {usage?.quota?.limit || 100} queries</span>
                        </div>
                        <div className="usage-bar">
                          <div
                            className="usage-bar-fill"
                            style={{ width: `${usagePercent}%` }}
                            data-critical={usagePercent >= 90}
                            data-warning={usagePercent >= 75 && usagePercent < 90}
                          />
                        </div>
                        <p className="usage-note">
                          {usage?.quota?.remaining || 0} queries remaining &middot; Resets on the 1st of each month
                        </p>
                      </div>
                    </>
                  )}

                  {usage?.byProvider && Object.keys(usage.byProvider).length > 0 && (
                    <div className="usage-breakdown">
                      <h4>By Provider</h4>
                      <div className="usage-providers">
                        {Object.entries(usage.byProvider).map(([provider, data]) => (
                          <div key={provider} className="usage-provider">
                            <span className="provider-name">{provider}</span>
                            <span className="provider-count">{data.requests} requests</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* Sessions Section */}
              <section className="account-section">
                <h2>Active Sessions</h2>
                <div className="account-card">
                  <div className="sessions-list">
                    {sessions.length === 0 ? (
                      <p className="sessions-empty">No active sessions</p>
                    ) : (
                      sessions.map((session, index) => (
                        <div key={index} className="session-item">
                          <div className="session-info">
                            <span className="session-device">
                              {session.userAgent?.includes('Electron')
                                ? 'Midlight Desktop'
                                : session.userAgent?.includes('Mobile')
                                ? 'Mobile Browser'
                                : 'Web Browser'}
                            </span>
                            <span className="session-date">
                              Expires {new Date(session.expiresAt).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  {sessions.length > 0 && (
                    <button
                      onClick={handleLogoutAll}
                      className="btn-secondary btn-danger-outline"
                      disabled={actionLoading === 'sessions'}
                    >
                      {actionLoading === 'sessions' ? 'Signing out...' : 'Sign out of all devices'}
                    </button>
                  )}
                </div>
              </section>

              {/* Danger Zone */}
              <section className="account-section danger-zone">
                <h2>Danger Zone</h2>
                <div className="account-card danger-card">
                  <div className="danger-info">
                    <AlertIcon />
                    <div>
                      <h4>Delete Account</h4>
                      <p>Permanently delete your account and all associated data. This action cannot be undone.</p>
                    </div>
                  </div>
                  {!showDeleteConfirm ? (
                    <button
                      onClick={() => setShowDeleteConfirm(true)}
                      className="btn-danger"
                    >
                      Delete Account
                    </button>
                  ) : (
                    <div className="delete-confirm">
                      <p>Are you sure? This will permanently delete your account.</p>
                      <div className="delete-actions">
                        <button
                          onClick={() => setShowDeleteConfirm(false)}
                          className="btn-secondary"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleDeleteAccount}
                          className="btn-danger"
                          disabled={actionLoading === 'delete'}
                        >
                          {actionLoading === 'delete' ? 'Deleting...' : 'Yes, Delete My Account'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
