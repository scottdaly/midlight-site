import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import Header from '../components/Header';

// Google icon
const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24">
    <path
      fill="currentColor"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
    />
    <path
      fill="currentColor"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
    />
    <path
      fill="currentColor"
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
    />
    <path
      fill="currentColor"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
    />
  </svg>
);

// Password validation
function validatePassword(password) {
  const errors = [];
  if (password.length < 8) {
    errors.push('At least 8 characters');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('One uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('One lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('One number');
  }
  return errors;
}

export default function Auth() {
  const location = useLocation();
  const initialMode = location.pathname === '/signup' ? 'signup' : 'login';

  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [formErrors, setFormErrors] = useState({});
  const [passwordErrors, setPasswordErrors] = useState([]);

  const { login, signup, loginWithGoogle, isAuthenticated, error, clearError } = useAuth();
  const navigate = useNavigate();

  // Redirect if already authenticated
  useEffect(() => {
    if (isAuthenticated) {
      const from = location.state?.from?.pathname || '/account';
      navigate(from, { replace: true });
    }
  }, [isAuthenticated, navigate, location]);

  // Validate password as user types (signup only)
  useEffect(() => {
    if (mode === 'signup' && password) {
      setPasswordErrors(validatePassword(password));
    } else {
      setPasswordErrors([]);
    }
  }, [password, mode]);

  // Clear errors when inputs change
  useEffect(() => {
    if (formError) setFormError('');
    if (Object.keys(formErrors).length > 0) setFormErrors({});
    if (error) clearError();
  }, [email, password, confirmPassword, displayName, mode]);

  // Reset form when switching modes
  useEffect(() => {
    setPassword('');
    setConfirmPassword('');
    setFormError('');
    setFormErrors({});
  }, [mode]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');
    setFormErrors({});

    if (mode === 'login') {
      // Login validation
      if (!email || !password) {
        setFormError('Please enter your email and password');
        return;
      }

      setIsSubmitting(true);
      const result = await login(email, password);
      setIsSubmitting(false);

      if (result.success) {
        const from = location.state?.from?.pathname || '/account';
        navigate(from, { replace: true });
      }
    } else {
      // Sign up validation
      const errors = {};

      if (!email) {
        errors.email = 'Email is required';
      }
      if (!password) {
        errors.password = 'Password is required';
      } else if (passwordErrors.length > 0) {
        errors.password = 'Password does not meet requirements';
      }
      if (password !== confirmPassword) {
        errors.confirmPassword = 'Passwords do not match';
      }

      if (Object.keys(errors).length > 0) {
        setFormErrors(errors);
        return;
      }

      setIsSubmitting(true);
      const result = await signup(email, password, displayName || undefined);
      setIsSubmitting(false);

      if (result.success) {
        navigate('/account', { replace: true });
      } else if (result.errors) {
        const serverErrors = {};
        result.errors.forEach((err) => {
          serverErrors[err.path] = err.msg;
        });
        setFormErrors(serverErrors);
      }
    }
  };

  const isPasswordValid = password && passwordErrors.length === 0;
  const displayError = formError || error;

  return (
    <div className="app">
      <Header />
      <div className="auth-page">
        <div className="auth-container">
          {/* Segmented Control */}
        <div className="auth-segmented-control">
          <button
            type="button"
            className={`auth-segment ${mode === 'login' ? 'active' : ''}`}
            onClick={() => setMode('login')}
          >
            Log in
          </button>
          <button
            type="button"
            className={`auth-segment ${mode === 'signup' ? 'active' : ''}`}
            onClick={() => setMode('signup')}
          >
            Sign up
          </button>
        </div>

        <button
          type="button"
          onClick={loginWithGoogle}
          className="btn-oauth"
          disabled={isSubmitting}
        >
          <GoogleIcon />
          Continue with Google
        </button>

        <div className="auth-divider">
          <span>or</span>
        </div>

        {displayError && (
          <div className="auth-error">
            {displayError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-form" key={mode}>
          {mode === 'signup' && (
            <div className="form-group">
              <label htmlFor="displayName">Name (optional)</label>
              <input
                type="text"
                id="displayName"
                className="form-input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Jane Doe"
                autoComplete="name"
                disabled={isSubmitting}
              />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              type="email"
              id="email"
              className={`form-input ${formErrors.email ? 'input-error' : ''}`}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              disabled={isSubmitting}
            />
            {formErrors.email && (
              <span className="field-error">{formErrors.email}</span>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              type="password"
              id="password"
              className={`form-input ${formErrors.password ? 'input-error' : ''}`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'login' ? 'Enter your password' : 'Create a strong password'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              disabled={isSubmitting}
            />
            <div className={`password-requirements ${mode === 'signup' && password ? 'visible' : ''}`}>
              {['At least 8 characters', 'One uppercase letter', 'One lowercase letter', 'One number'].map((req) => (
                <span
                  key={req}
                  className={passwordErrors.includes(req) ? 'requirement-unmet' : 'requirement-met'}
                >
                  {passwordErrors.includes(req) ? '○' : '●'} {req}
                </span>
              ))}
            </div>
            {formErrors.password && (
              <span className="field-error">{formErrors.password}</span>
            )}
          </div>

          {mode === 'signup' && (
            <div className="form-group">
              <label htmlFor="confirmPassword">Confirm Password</label>
              <input
                type="password"
                id="confirmPassword"
                className={`form-input ${formErrors.confirmPassword ? 'input-error' : ''}`}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm your password"
                autoComplete="new-password"
                disabled={isSubmitting}
              />
              {formErrors.confirmPassword && (
                <span className="field-error">{formErrors.confirmPassword}</span>
              )}
            </div>
          )}

          <div className="auth-form-footer">
            <button
              type="submit"
              className="btn-primary auth-submit"
              disabled={isSubmitting || (mode === 'signup' && !isPasswordValid)}
            >
              {isSubmitting
                ? (mode === 'login' ? 'Logging in...' : 'Creating account...')
                : (mode === 'login' ? 'Log in' : 'Create account')
              }
            </button>
          </div>
          </form>
        </div>
      </div>
    </div>
  );
}
