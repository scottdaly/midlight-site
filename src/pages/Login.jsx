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

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const { login, loginWithGoogle, isAuthenticated, error, clearError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Redirect if already authenticated
  useEffect(() => {
    if (isAuthenticated) {
      const from = location.state?.from?.pathname || '/account';
      navigate(from, { replace: true });
    }
  }, [isAuthenticated, navigate, location]);

  // Clear errors when inputs change
  useEffect(() => {
    if (formError) setFormError('');
    if (error) clearError();
  }, [email, password]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');

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
  };

  const displayError = formError || error;

  return (
    <div className="auth-page">
      <div className="auth-container">
        <div className="auth-header">
          <Link to="/" className="auth-logo">
            <svg width="30px" height="30px" viewBox="0 0 1188 1186" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="1188" height="1185.94" rx="55.6875" fill="url(#paint0_linear_login)"/>
              <path d="M635.043 331.497C635.983 333.431 638.282 334.276 640.25 333.411L794.69 265.537C796.647 264.677 798.934 265.508 799.883 267.424L833.973 336.253C834.033 336.373 834.206 336.368 834.257 336.245C834.273 336.208 834.301 336.178 834.338 336.162L987.043 268.077C990.342 266.606 993.747 269.916 992.369 273.256L906.263 481.997C906.232 482.071 906.235 482.154 906.271 482.226L906.323 482.331C906.39 482.466 906.292 482.625 906.141 482.625C906.059 482.625 905.984 482.675 905.953 482.751L724.958 921.525C724.341 923.023 722.881 924 721.261 924H593.827C590.969 924 589.033 921.089 590.138 918.453L771.921 484.912C772.527 483.464 772.232 481.796 771.165 480.645L732.266 438.689C730.282 436.549 726.748 437.185 725.635 439.883L708.265 481.992C708.234 482.066 708.237 482.15 708.272 482.222L708.325 482.331C708.392 482.467 708.293 482.625 708.142 482.625C708.059 482.625 707.984 482.675 707.953 482.751L526.958 921.525C526.341 923.023 524.881 924 523.261 924H395.823C392.966 924 391.03 921.091 392.133 918.456L573.901 484.188C574.349 483.117 574.31 481.905 573.794 480.865L543.268 419.381C541.74 416.303 537.298 416.458 535.988 419.634L328.958 921.525C328.341 923.023 326.881 924 325.261 924H197.789C194.941 924 193.006 921.108 194.092 918.475L463.042 266.475C463.659 264.977 465.119 264 466.739 264H599.746C601.278 264 602.675 264.874 603.344 266.252L635.043 331.497Z" fill="#D9D9D9"/>
              <defs>
                <linearGradient id="paint0_linear_login" x1="239" y1="-2.1796e-05" x2="1067.5" y2="1186" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#333333"/>
                  <stop offset="1" stopColor="#1F1F1F"/>
                </linearGradient>
              </defs>
            </svg>
            <span>Midlight</span>
          </Link>
          <h1>Welcome back</h1>
          <p>Sign in to your account to continue</p>
        </div>

        {displayError && (
          <div className="auth-error">
            {displayError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              type="email"
              id="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              disabled={isSubmitting}
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              type="password"
              id="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoComplete="current-password"
              disabled={isSubmitting}
            />
          </div>

          <button
            type="submit"
            className="btn-primary auth-submit"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Signing in...' : 'Sign in'}
          </button>
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

        <p className="auth-footer">
          Don't have an account?{' '}
          <Link to="/signup">Sign up</Link>
        </p>
      </div>
    </div>
  );
}
