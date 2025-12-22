/**
 * API Client for Midlight
 * Handles authentication, token refresh, and CSRF protection
 */

const API_BASE = import.meta.env.VITE_API_URL || '';

// Token storage
let accessToken = localStorage.getItem('accessToken');
let csrfToken = null;

// Token refresh promise to avoid multiple simultaneous refreshes
let refreshPromise = null;

/**
 * Set the access token (called after login/signup)
 */
export function setAccessToken(token) {
  accessToken = token;
  if (token) {
    localStorage.setItem('accessToken', token);
  } else {
    localStorage.removeItem('accessToken');
  }
}

/**
 * Get the current access token
 */
export function getAccessToken() {
  return accessToken;
}

/**
 * Clear auth state (called on logout)
 */
export function clearAuth() {
  accessToken = null;
  csrfToken = null;
  localStorage.removeItem('accessToken');
}

/**
 * Fetch CSRF token for state-changing requests
 */
async function fetchCsrfToken() {
  if (csrfToken) return csrfToken;

  const response = await fetch(`${API_BASE}/api/csrf-token`, {
    credentials: 'include',
  });

  if (response.ok) {
    const data = await response.json();
    csrfToken = data.csrfToken;
    return csrfToken;
  }

  return null;
}

/**
 * Refresh the access token using the httpOnly refresh token cookie
 */
async function refreshAccessToken() {
  // If already refreshing, return the existing promise
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        setAccessToken(data.accessToken);
        return data;
      }

      // Refresh failed - clear auth state
      clearAuth();
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Main API request function with automatic token handling
 */
export async function api(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const method = options.method || 'GET';

  // Build headers
  const headers = {
    ...options.headers,
  };

  // Add Content-Type for JSON bodies
  if (options.body && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
  }

  // Add auth header if we have a token
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  // Add CSRF token for state-changing requests
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
    const csrf = await fetchCsrfToken();
    if (csrf) {
      headers['X-CSRF-Token'] = csrf;
    }
  }

  // Make the request
  let response = await fetch(url, {
    ...options,
    method,
    headers,
    credentials: 'include',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  // If 401, try to refresh token and retry once
  if (response.status === 401 && accessToken) {
    const refreshed = await refreshAccessToken();

    if (refreshed) {
      // Retry the request with new token
      headers['Authorization'] = `Bearer ${refreshed.accessToken}`;
      response = await fetch(url, {
        ...options,
        method,
        headers,
        credentials: 'include',
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    }
  }

  return response;
}

/**
 * Convenience methods for common HTTP methods
 */
export const apiGet = (endpoint, options = {}) =>
  api(endpoint, { ...options, method: 'GET' });

export const apiPost = (endpoint, body, options = {}) =>
  api(endpoint, { ...options, method: 'POST', body });

export const apiPatch = (endpoint, body, options = {}) =>
  api(endpoint, { ...options, method: 'PATCH', body });

export const apiDelete = (endpoint, options = {}) =>
  api(endpoint, { ...options, method: 'DELETE' });

/**
 * Try to restore session on page load
 */
export async function tryRestoreSession() {
  // If we have a stored token, try to refresh it
  if (accessToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return refreshed.user;
    }
  }

  // Try refresh even without stored token (cookie might still be valid)
  const refreshed = await refreshAccessToken();
  return refreshed?.user || null;
}
