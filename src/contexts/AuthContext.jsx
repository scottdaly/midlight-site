import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  api,
  apiPost,
  setAccessToken,
  clearAuth,
  tryRestoreSession,
} from '../utils/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Handle auth on mount - either OAuth callback or session restoration
  useEffect(() => {
    async function initializeAuth() {
      try {
        // Check for OAuth callback first
        const params = new URLSearchParams(window.location.search);
        const token = params.get('accessToken');

        if (token) {
          // OAuth callback - store token and fetch user
          setAccessToken(token);

          // Clean URL
          window.history.replaceState({}, '', window.location.pathname);

          // Fetch user data
          const fetchedUser = await fetchUser();
          if (fetchedUser) {
            setUser(fetchedUser);
          }
        } else {
          // No OAuth callback - try to restore session
          const restoredUser = await tryRestoreSession();
          if (restoredUser) {
            setUser(restoredUser);
          }
        }
      } catch (err) {
        console.error('Failed to initialize auth:', err);
      } finally {
        setLoading(false);
      }
    }

    initializeAuth();
  }, []);

  const fetchUser = useCallback(async () => {
    try {
      const response = await api('/api/user/me');
      if (response.ok) {
        const data = await response.json();
        setUser(data.user);
        return data.user;
      }
      return null;
    } catch (err) {
      console.error('Failed to fetch user:', err);
      return null;
    }
  }, []);

  const login = useCallback(async (email, password) => {
    setError(null);

    try {
      const response = await apiPost('/api/auth/login', { email, password });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Login failed');
        return { success: false, error: data.error };
      }

      setAccessToken(data.accessToken);
      setUser(data.user);
      return { success: true, user: data.user };
    } catch (err) {
      const message = 'Network error. Please try again.';
      setError(message);
      return { success: false, error: message };
    }
  }, []);

  const signup = useCallback(async (email, password, displayName) => {
    setError(null);

    try {
      const response = await apiPost('/api/auth/signup', {
        email,
        password,
        displayName,
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Signup failed');
        return { success: false, error: data.error, errors: data.errors };
      }

      setAccessToken(data.accessToken);
      setUser(data.user);
      return { success: true, user: data.user };
    } catch (err) {
      const message = 'Network error. Please try again.';
      setError(message);
      return { success: false, error: message };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiPost('/api/auth/logout');
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      clearAuth();
      setUser(null);
    }
  }, []);

  const loginWithGoogle = useCallback(() => {
    // Redirect to Google OAuth - server will redirect back with token
    const apiBase = import.meta.env.VITE_API_URL || '';
    window.location.href = `${apiBase}/api/auth/google`;
  }, []);

  const value = {
    user,
    loading,
    error,
    isAuthenticated: !!user,
    login,
    signup,
    logout,
    loginWithGoogle,
    fetchUser,
    clearError: () => setError(null),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
