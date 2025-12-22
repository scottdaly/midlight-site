import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

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
    <div className="auth-page">
      <div className="auth-container">
        <div className="auth-header">
          <Link to="/" className="auth-logo">
            <svg width="30px" height="30px" viewBox="0 0 1188 1186" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="1188" height="1185.94" rx="55.6875" fill="url(#paint0_linear_auth)"/>
              <path d="M635.043 331.497C635.983 333.431 638.282 334.276 640.25 333.411L794.69 265.537C796.647 264.677 798.934 265.508 799.883 267.424L833.973 336.253C834.033 336.373 834.206 336.368 834.257 336.245C834.273 336.208 834.301 336.178 834.338 336.162L987.043 268.077C990.342 266.606 993.747 269.916 992.369 273.256L906.263 481.997C906.232 482.071 906.235 482.154 906.271 482.226L906.323 482.331C906.39 482.466 906.292 482.625 906.141 482.625C906.059 482.625 905.984 482.675 905.953 482.751L724.958 921.525C724.341 923.023 722.881 924 721.261 924H593.827C590.969 924 589.033 921.089 590.138 918.453L771.921 484.912C772.527 483.464 772.232 481.796 771.165 480.645L732.266 438.689C730.282 436.549 726.748 437.185 725.635 439.883L708.265 481.992C708.234 482.066 708.237 482.15 708.272 482.222L708.325 482.331C708.392 482.467 708.293 482.625 708.142 482.625C708.059 482.625 707.984 482.675 707.953 482.751L526.958 921.525C526.341 923.023 524.881 924 523.261 924H395.823C392.966 924 391.03 921.091 392.133 918.456L573.901 484.188C574.349 483.117 574.31 481.905 573.794 480.865L543.268 419.381C541.74 416.303 537.298 416.458 535.988 419.634L328.958 921.525C328.341 923.023 326.881 924 325.261 924H197.789C194.941 924 193.006 921.108 194.092 918.475L463.042 266.475C463.659 264.977 465.119 264 466.739 264H599.746C601.278 264 602.675 264.874 603.344 266.252L635.043 331.497Z" fill="#D9D9D9"/>
              <defs>
                <linearGradient id="paint0_linear_auth" x1="239" y1="-2.1796e-05" x2="1067.5" y2="1186" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#333333"/>
                  <stop offset="1" stopColor="#1F1F1F"/>
                </linearGradient>
              </defs>
            </svg>
            <span>Midlight</span>
          </Link>
        </div>

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
                placeholder="How should we call you?"
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

        <div className="auth-divider">
          <span>or</span>
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
      </div>
    </div>
  );
}
