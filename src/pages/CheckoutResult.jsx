import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import Header from '../components/Header';
import Footer from '../components/Footer';

function CheckoutResult() {
  const location = useLocation();
  const isSuccess = location.pathname.includes('success');

  return (
    <div className="app">
      <Header />

      <section style={{
        minHeight: 'calc(100vh - 200px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '4rem 1rem'
      }}>
        <div style={{ textAlign: 'center', maxWidth: '500px' }}>
          {isSuccess ? (
            <>
              <div style={{
                fontSize: '4rem',
                marginBottom: '1.5rem'
              }}>
                🎉
              </div>
              <h1 style={{ marginBottom: '1rem' }}>You're all set!</h1>
              <p style={{
                color: 'var(--text-muted)',
                marginBottom: '2rem',
                lineHeight: '1.6'
              }}>
                Your subscription is now active. You can close this tab and return to Midlight to start using your new features.
              </p>
            </>
          ) : (
            <>
              <div style={{
                fontSize: '4rem',
                marginBottom: '1.5rem'
              }}>
                👋
              </div>
              <h1 style={{ marginBottom: '1rem' }}>Checkout Cancelled</h1>
              <p style={{
                color: 'var(--text-muted)',
                marginBottom: '2rem',
                lineHeight: '1.6'
              }}>
                No worries! Your checkout was cancelled and you haven't been charged. You can upgrade anytime from the Midlight app.
              </p>
            </>
          )}

          <Link to="/" className="btn-primary">
            Back to Home
          </Link>
        </div>
      </section>

      <Footer />
    </div>
  );
}

export default CheckoutResult;
