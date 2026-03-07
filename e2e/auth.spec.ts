import { test, expect } from '@playwright/test';
import { generateTestEmail, desktopHeaders } from './fixtures/auth';
import { createFreeUser } from './fixtures/collab';
import { trackTestEmail } from './fixtures/cleanup';

/**
 * Auth API E2E Tests
 *
 * Tests authentication endpoints: signup, login, refresh, logout.
 *
 * Note: Server is automatically started by playwright.config.ts webServer setting.
 */

test.describe('Auth API - Signup', () => {
  test('signup with valid credentials returns an access token and refresh cookie', async ({ request }) => {
    const email = generateTestEmail();
    trackTestEmail(email);
    const password = 'SecurePassword123!';

    const response = await request.post('/api/auth/signup', {
      headers: desktopHeaders(),
      data: {
        email,
        password,
        displayName: 'Test User',
      },
    });

    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeUndefined();
    expect(body.user).toBeDefined();
    expect(body.user.email).toBe(email.toLowerCase());
    expect(response.headers()['set-cookie']).toContain('refreshToken=');
  });

  test('signup with duplicate email fails', async ({ request }) => {
    const email = generateTestEmail();
    trackTestEmail(email);
    const password = 'SecurePassword123!';

    // First signup
    await request.post('/api/auth/signup', {
      headers: desktopHeaders(),
      data: { email, password, displayName: 'User 1' },
    });

    // Second signup with same email
    const response = await request.post('/api/auth/signup', {
      headers: desktopHeaders(),
      data: { email, password, displayName: 'User 2' },
    });

    expect(response.status()).toBe(409);
    const body = await response.json();
    expect(body.error).toBeDefined();
  });

  test('signup with weak password fails validation', async ({ request }) => {
    const response = await request.post('/api/auth/signup', {
      headers: desktopHeaders(),
      data: {
        email: generateTestEmail(),
        password: '123', // Too short/weak
        displayName: 'Test User',
      },
    });

    expect(response.ok()).toBeFalsy();
  });

  test('signup with invalid email fails validation', async ({ request }) => {
    const response = await request.post('/api/auth/signup', {
      headers: desktopHeaders(),
      data: {
        email: 'not-an-email',
        password: 'SecurePassword123!',
        displayName: 'Test User',
      },
    });

    expect(response.ok()).toBeFalsy();
  });
});

test.describe('Auth API - Login', () => {
  // Run this describe block serially to avoid race conditions with shared state
  test.describe.configure({ mode: 'serial' });

  let testEmail: string;
  let testPassword: string;

  test.beforeAll(async ({ request }) => {
    const user = await createFreeUser(request, 'Login Test User');
    testEmail = user.email;
    testPassword = user.password;
  });

  test('login with valid credentials returns an access token and refresh cookie', async ({ request }) => {
    const response = await request.post('/api/auth/login', {
      headers: desktopHeaders(),
      data: {
        email: testEmail,
        password: testPassword,
      },
    });

    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeUndefined();
    expect(response.headers()['set-cookie']).toContain('refreshToken=');
  });

  test('login with wrong password fails', async ({ request }) => {
    const response = await request.post('/api/auth/login', {
      headers: desktopHeaders(),
      data: {
        email: testEmail,
        password: 'WrongPassword123!',
      },
    });

    expect(response.status()).toBe(401);
  });

  test('login with non-existent user fails', async ({ request }) => {
    const response = await request.post('/api/auth/login', {
      headers: desktopHeaders(),
      data: {
        email: 'nonexistent@example.com',
        password: testPassword,
      },
    });

    expect(response.status()).toBe(401);
  });
});

test.describe('Auth API - Token Refresh', () => {
  test('refresh token returns new access token', async ({ request }) => {
    const user = await createFreeUser(request, 'Refresh Test User');

    // Use refresh token to get new access token
    const refreshResponse = await request.post('/api/auth/refresh', {
      headers: desktopHeaders(),
      data: { refreshToken: user.refreshToken },
    });

    expect(refreshResponse.ok()).toBeTruthy();

    const body = await refreshResponse.json();
    expect(body.accessToken).toBeDefined();
  });

  test('invalid refresh token fails', async ({ request }) => {
    const response = await request.post('/api/auth/refresh', {
      headers: desktopHeaders(),
      data: { refreshToken: 'invalid-token' },
    });

    expect(response.ok()).toBeFalsy();
  });
});

test.describe('Auth API - Protected Routes', () => {
  test('accessing protected route without token fails', async ({ request }) => {
    const response = await request.get('/api/user/me', {
      headers: desktopHeaders(),
    });

    expect(response.status()).toBe(401);
  });

  test('accessing protected route with valid token succeeds', async ({ request }) => {
    const user = await createFreeUser(request, 'Protected Route User');

    // Access protected route
    const response = await request.get('/api/user/me', {
      headers: desktopHeaders(user.accessToken),
    });

    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.user.email).toBe(user.email.toLowerCase());
  });
});
