import React from 'react';
import { useTheme } from '../ThemeContext';

const SunIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </svg>
);

const MoonIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </svg>
);

const MonitorIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <line x1="8" x2="16" y1="21" y2="21" />
    <line x1="12" x2="12" y1="17" y2="21" />
  </svg>
);

function Footer() {
  const { theme, setTheme } = useTheme();

  return (
    <footer className="footer">
      <div className="container">
        <p>&copy; 2025 Midlight Inc. All rights reserved.</p>
        <div className="theme-switcher">
          <button
            className={`theme-btn ${theme === 'light' ? 'active' : ''}`}
            onClick={() => setTheme('light')}
            aria-label="Light mode"
            title="Light mode"
          >
            <SunIcon />
          </button>
          <button
            className={`theme-btn ${theme === 'system' ? 'active' : ''}`}
            onClick={() => setTheme('system')}
            aria-label="System preference"
            title="System preference"
          >
            <MonitorIcon />
          </button>
          <button
            className={`theme-btn ${theme === 'dark' ? 'active' : ''}`}
            onClick={() => setTheme('dark')}
            aria-label="Dark mode"
            title="Dark mode"
          >
            <MoonIcon />
          </button>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
