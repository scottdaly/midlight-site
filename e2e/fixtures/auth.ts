import { APIRequestContext } from '@playwright/test';

/**
 * Auth Test Fixtures
 *
 * Helpers for creating and managing test users during E2E tests.
 */

export interface TestUser {
  email: string;
  password: string;
  displayName: string;
  accessToken?: string;
  refreshToken?: string;
}

/**
 * Generate a unique test email
 */
export function generateTestEmail(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}@e2e-test.local`;
}

/**
 * Create a test user via the signup API
 */
export async function createTestUser(
  request: APIRequestContext,
  baseURL: string,
  overrides: Partial<TestUser> = {}
): Promise<TestUser> {
  const user: TestUser = {
    email: overrides.email || generateTestEmail(),
    password: overrides.password || 'TestPassword123!',
    displayName: overrides.displayName || 'E2E Test User',
  };

  const response = await request.post(`${baseURL}/api/auth/signup`, {
    data: {
      email: user.email,
      password: user.password,
      displayName: user.displayName,
    },
  });

  if (response.ok()) {
    const body = await response.json();
    user.accessToken = body.accessToken;
    user.refreshToken = body.refreshToken;
  }

  return user;
}

/**
 * Login an existing user
 */
export async function loginUser(
  request: APIRequestContext,
  baseURL: string,
  email: string,
  password: string
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const response = await request.post(`${baseURL}/api/auth/login`, {
    data: { email, password },
  });

  if (response.ok()) {
    return response.json();
  }

  return null;
}

/**
 * Get authorization header for authenticated requests
 */
export function authHeader(accessToken: string): { Authorization: string } {
  return { Authorization: `Bearer ${accessToken}` };
}

/**
 * Create request headers for desktop client (bypasses CSRF)
 */
export function desktopHeaders(accessToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Client-Type': 'desktop',
    'Content-Type': 'application/json',
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  return headers;
}
