import React, { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext();

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    // Check localStorage for saved preference
    const saved = localStorage.getItem('theme');
    return saved || 'system';
  });

  useEffect(() => {
    const root = document.documentElement;

    if (theme === 'system') {
      // Remove data-theme to let CSS media query handle it
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }

    // Save to localStorage
    localStorage.setItem('theme', theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
