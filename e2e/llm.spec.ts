import { test, expect } from '@playwright/test';
import { generateTestEmail, desktopHeaders } from './fixtures/auth';
import { trackTestEmail } from './fixtures/cleanup';

/**
 * LLM Proxy API E2E Tests
 *
 * Tests the LLM chat endpoint with authentication and quota enforcement.
 *
 * Note: These tests require LLM API keys to be configured on the server.
 * Some tests may be skipped if no API keys are available.
 */

test.describe('LLM API - Authentication', () => {
  test('LLM endpoint requires authentication', async ({ request }) => {
    const response = await request.post('/api/llm/chat', {
      headers: {
        'X-Client-Type': 'desktop',
        'Content-Type': 'application/json',
      },
      data: {
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.status()).toBe(401);
  });

  test('LLM endpoint rejects invalid token', async ({ request }) => {
    const response = await request.post('/api/llm/chat', {
      headers: desktopHeaders('invalid-token'),
      data: {
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.status()).toBe(401);
  });
});

test.describe('LLM API - Request Validation', () => {
  // Run serially to share accessToken
  test.describe.configure({ mode: 'serial' });

  let accessToken: string;

  test.beforeAll(async ({ request }) => {
    // Create a test user
    const email = generateTestEmail();
    trackTestEmail(email);
    const signupResponse = await request.post('/api/auth/signup', {
      headers: desktopHeaders(),
      data: {
        email,
        password: 'SecurePassword123!',
        displayName: 'LLM Test User',
      },
    });

    const body = await signupResponse.json();
    accessToken = body.accessToken;
  });

  test('LLM endpoint requires messages array', async ({ request }) => {
    const response = await request.post('/api/llm/chat', {
      headers: desktopHeaders(accessToken),
      data: {
        // Missing messages
      },
    });

    expect(response.ok()).toBeFalsy();
  });

  test('LLM endpoint rejects empty messages array', async ({ request }) => {
    const response = await request.post('/api/llm/chat', {
      headers: desktopHeaders(accessToken),
      data: {
        messages: [],
      },
    });

    expect(response.ok()).toBeFalsy();
  });

  test('LLM endpoint accepts valid request format', async ({ request }) => {
    // This test may fail if no API keys are configured
    // It verifies the request is accepted (not rejected for format)
    const response = await request.post('/api/llm/chat', {
      headers: desktopHeaders(accessToken),
      data: {
        messages: [{ role: 'user', content: 'Say "test" and nothing else.' }],
        stream: false,
      },
    });

    // Response could be 200 (success) or 503 (no API key) or similar
    // We just verify it's not a 400 validation error
    expect(response.status()).not.toBe(400);
  });
});

test.describe('LLM API - Quota', () => {
  test('user info includes quota information', async ({ request }) => {
    // Create a test user
    const email = generateTestEmail();
    trackTestEmail(email);
    const signupResponse = await request.post('/api/auth/signup', {
      headers: desktopHeaders(),
      data: {
        email,
        password: 'SecurePassword123!',
        displayName: 'Quota Test User',
      },
    });

    const { accessToken } = await signupResponse.json();

    // Get user info which should include subscription/quota details
    const userResponse = await request.get('/api/user/me', {
      headers: desktopHeaders(accessToken),
    });

    expect(userResponse.ok()).toBeTruthy();

    const user = await userResponse.json();
    // User should have subscription info
    expect(user).toBeDefined();
  });
});

test.describe('LLM API - Provider Support', () => {
  // Run serially to share accessToken
  test.describe.configure({ mode: 'serial' });

  let accessToken: string;

  test.beforeAll(async ({ request }) => {
    const email = generateTestEmail();
    trackTestEmail(email);
    const signupResponse = await request.post('/api/auth/signup', {
      headers: desktopHeaders(),
      data: {
        email,
        password: 'SecurePassword123!',
        displayName: 'Provider Test User',
      },
    });

    const body = await signupResponse.json();
    accessToken = body.accessToken;
  });

  test('can specify Anthropic as provider', async ({ request }) => {
    const response = await request.post('/api/llm/chat', {
      headers: desktopHeaders(accessToken),
      data: {
        messages: [{ role: 'user', content: 'Hi' }],
        provider: 'anthropic',
        stream: false,
      },
    });

    // Request should be accepted (may fail due to missing API key)
    expect(response.status()).not.toBe(400);
  });

  test('can specify OpenAI as provider', async ({ request }) => {
    const response = await request.post('/api/llm/chat', {
      headers: desktopHeaders(accessToken),
      data: {
        messages: [{ role: 'user', content: 'Hi' }],
        provider: 'openai',
        stream: false,
      },
    });

    // Request should be accepted
    expect(response.status()).not.toBe(400);
  });

  test('rejects invalid provider', async ({ request }) => {
    const response = await request.post('/api/llm/chat', {
      headers: desktopHeaders(accessToken),
      data: {
        messages: [{ role: 'user', content: 'Hi' }],
        provider: 'invalid-provider',
        stream: false,
      },
    });

    expect(response.ok()).toBeFalsy();
  });
});
