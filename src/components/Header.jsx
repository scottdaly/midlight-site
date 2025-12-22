import React, { useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

// Logo icon (same as in App.jsx)
const LogoIcon = () => (
  <svg width="30px" height="30px" viewBox="0 0 1188 1186" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="1188" height="1185.94" rx="55.6875" fill="url(#paint0_linear_header)"/>
    <path d="M635.043 331.497C635.983 333.431 638.282 334.276 640.25 333.411L794.69 265.537C796.647 264.677 798.934 265.508 799.883 267.424L833.973 336.253C834.033 336.373 834.206 336.368 834.257 336.245C834.273 336.208 834.301 336.178 834.338 336.162L987.043 268.077C990.342 266.606 993.747 269.916 992.369 273.256L906.263 481.997C906.232 482.071 906.235 482.154 906.271 482.226L906.323 482.331C906.39 482.466 906.292 482.625 906.141 482.625C906.059 482.625 905.984 482.675 905.953 482.751L724.958 921.525C724.341 923.023 722.881 924 721.261 924H593.827C590.969 924 589.033 921.089 590.138 918.453L771.921 484.912C772.527 483.464 772.232 481.796 771.165 480.645L732.266 438.689C730.282 436.549 726.748 437.185 725.635 439.883L708.265 481.992C708.234 482.066 708.237 482.15 708.272 482.222L708.325 482.331C708.392 482.467 708.293 482.625 708.142 482.625C708.059 482.625 707.984 482.675 707.953 482.751L526.958 921.525C526.341 923.023 524.881 924 523.261 924H395.823C392.966 924 391.03 921.091 392.133 918.456L573.901 484.188C574.349 483.117 574.31 481.905 573.794 480.865L543.268 419.381C541.74 416.303 537.298 416.458 535.988 419.634L328.958 921.525C328.341 923.023 326.881 924 325.261 924H197.789C194.941 924 193.006 921.108 194.092 918.475L463.042 266.475C463.659 264.977 465.119 264 466.739 264H599.746C601.278 264 602.675 264.874 603.344 266.252L635.043 331.497Z" fill="#D9D9D9"/>
    <defs>
      <linearGradient id="paint0_linear_header" x1="239" y1="-2.1796e-05" x2="1067.5" y2="1186" gradientUnits="userSpaceOnUse">
        <stop stopColor="#333333"/>
        <stop offset="1" stopColor="#1F1F1F"/>
      </linearGradient>
    </defs>
  </svg>
);

// User icon for avatar fallback
const UserIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

// Chevron icon
const ChevronDownIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 9 6 6 6-6"/>
  </svg>
);

export default function Header() {
  const { user, isAuthenticated, logout, loading } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const location = useLocation();

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close menu on route change
  useEffect(() => {
    setMenuOpen(false);
  }, [location]);

  const handleLogout = async () => {
    setMenuOpen(false);
    await logout();
  };

  // Get display name or email
  const displayName = user?.displayName || user?.email?.split('@')[0] || 'User';
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <header className="site-header">
      <div className="container header-container">
        <Link to="/" className="logo">
          <LogoIcon /> Midlight
        </Link>

        <nav className="header-nav">
          <Link to="/download" className="nav-link">Download</Link>
        </nav>

        <div className="header-actions">
          {loading ? (
            <div className="header-loading" />
          ) : isAuthenticated ? (
            <div className="user-menu-container" ref={menuRef}>
              <button
                className="user-menu-trigger"
                onClick={() => setMenuOpen(!menuOpen)}
                aria-expanded={menuOpen}
                aria-haspopup="true"
              >
                {user?.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt={displayName}
                    className="user-avatar"
                  />
                ) : (
                  <div className="user-avatar-fallback">
                    {initials}
                  </div>
                )}
                <span className="user-name">{displayName}</span>
                <ChevronDownIcon />
              </button>

              {menuOpen && (
                <div className="user-menu">
                  <div className="user-menu-header">
                    <span className="user-menu-email">{user?.email}</span>
                  </div>
                  <div className="user-menu-divider" />
                  <Link to="/account" className="user-menu-item">
                    Account Settings
                  </Link>
                  <button onClick={handleLogout} className="user-menu-item user-menu-logout">
                    Sign out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              <Link to="/login" className="nav-link">Sign in</Link>
              <Link to="/signup" className="btn-primary header-cta">Get Started</Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
