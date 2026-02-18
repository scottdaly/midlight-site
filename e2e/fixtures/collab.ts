import { APIRequestContext } from '@playwright/test';
import { generateTestEmail, desktopHeaders } from './auth';
import { trackTestEmail } from './cleanup';

/**
 * Collab Test Fixtures
 *
 * Shared helpers for collaboration E2E tests.
 * All helpers use Playwright's `request` fixture and the configured baseURL.
 */

// ---------------------------------------------------------------------------
// Admin helpers
// ---------------------------------------------------------------------------

/** Basic Auth header for admin endpoints (dev defaults) */
export function adminHeaders(): Record<string, string> {
  const creds = Buffer.from('admin:midlight_secret').toString('base64');
  return {
    Authorization: `Basic ${creds}`,
    'Content-Type': 'application/json',
  };
}

/** Set a user's subscription tier via admin endpoint */
export async function setSubscription(
  request: APIRequestContext,
  userId: number,
  tier: 'free' | 'pro' | 'premium',
) {
  const res = await request.patch(`/api/admin/users/${userId}/subscription`, {
    headers: adminHeaders(),
    data: { tier, status: 'active' },
  });
  if (!res.ok()) throw new Error(`setSubscription failed: ${res.status()}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// User helpers
// ---------------------------------------------------------------------------

export interface CollabUser {
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  userId: number;
}

/** Create a user via admin endpoint (bypasses signup rate limiting) */
async function createUser(request: APIRequestContext, name?: string): Promise<CollabUser> {
  const email = generateTestEmail();
  trackTestEmail(email);
  const password = 'TestPassword123!';

  const res = await request.post('/api/admin/test/users', {
    headers: adminHeaders(),
    data: { email, password, displayName: name || 'E2E Collab User' },
  });
  if (!res.ok()) throw new Error(`createUser failed: ${res.status()} ${await res.text()}`);
  const body = await res.json();

  return {
    email: body.user.email,
    password,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.user.id,
  };
}

/** Get the user ID from /api/user/me */
export async function getUserId(request: APIRequestContext, token: string): Promise<number> {
  const res = await request.get('/api/user/me', { headers: desktopHeaders(token) });
  if (!res.ok()) throw new Error(`getUserId failed: ${res.status()}`);
  const body = await res.json();
  return body.id;
}

/** Create a user with Pro subscription */
export async function createProUser(request: APIRequestContext, name?: string): Promise<CollabUser> {
  const user = await createUser(request, name);
  await setSubscription(request, user.userId, 'pro');
  return user;
}

/** Create a user with Premium subscription */
export async function createPremiumUser(request: APIRequestContext, name?: string): Promise<CollabUser> {
  const user = await createUser(request, name);
  await setSubscription(request, user.userId, 'premium');
  return user;
}

/** Create a free-tier user */
export async function createFreeUser(request: APIRequestContext, name?: string): Promise<CollabUser> {
  return createUser(request, name);
}

// ---------------------------------------------------------------------------
// Document helpers
// ---------------------------------------------------------------------------

/** Create a test document via admin endpoint (bypasses R2 storage) */
export async function createTestDocument(
  request: APIRequestContext,
  userId: number,
  path = '/test-doc.midlight',
  content = '# Test Document',
): Promise<{ id: string; path: string }> {
  const res = await request.post('/api/admin/test/documents', {
    headers: adminHeaders(),
    data: { userId, path, content },
  });
  if (!res.ok()) throw new Error(`createTestDocument failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Sharing helpers
// ---------------------------------------------------------------------------

/** Enable sharing on a document and return share settings (incl. linkToken) */
export async function enableSharing(
  request: APIRequestContext,
  token: string,
  docId: string,
  opts: { linkPermission?: 'view' | 'edit'; expiresAt?: string } = {},
): Promise<{
  id: string;
  linkToken: string;
  linkPermission: string;
  linkEnabled: boolean;
  accessList: any[];
}> {
  const res = await request.post(`/api/share/${docId}`, {
    headers: desktopHeaders(token),
    data: {
      linkPermission: opts.linkPermission || 'view',
      linkEnabled: true,
      allowCopy: true,
      expiresAt: opts.expiresAt || null,
    },
  });
  if (!res.ok()) throw new Error(`enableSharing failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

/** Invite a user by email to a shared document */
export async function inviteUser(
  request: APIRequestContext,
  ownerToken: string,
  docId: string,
  email: string,
  permission: 'view' | 'edit' = 'view',
) {
  const res = await request.post(`/api/share/${docId}/invite`, {
    headers: desktopHeaders(ownerToken),
    data: { email, permission },
  });
  if (!res.ok()) throw new Error(`inviteUser failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

/** Create a guest session for a share link (needs a token to bypass CSRF) */
export async function createGuestSession(
  request: APIRequestContext,
  linkToken: string,
  displayName = 'Test Guest',
  authToken?: string,
) {
  // The guest endpoint is public but CSRF is enforced on POST.
  // Use desktop headers with any valid Bearer token to bypass CSRF.
  const headers = authToken
    ? desktopHeaders(authToken)
    : { 'Content-Type': 'application/json', 'X-Client-Type': 'desktop' } as Record<string, string>;
  const res = await request.post(`/api/share/link/${linkToken}/guest`, {
    headers,
    data: { displayName },
  });
  if (!res.ok()) throw new Error(`createGuestSession failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Seeding helpers (admin test endpoints)
// ---------------------------------------------------------------------------

/** Seed a notification via admin test endpoint */
export async function seedNotification(
  request: APIRequestContext,
  userId: number,
  opts: { type?: string; title?: string; body?: string; documentId?: string; actorId?: number } = {},
): Promise<{ id: string }> {
  const res = await request.post('/api/admin/test/notifications', {
    headers: adminHeaders(),
    data: { userId, ...opts },
  });
  if (!res.ok()) throw new Error(`seedNotification failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

/** Seed branch content via admin test endpoint */
export async function seedBranchContent(
  request: APIRequestContext,
  branchId: string,
  content = '# Branch Content',
) {
  const res = await request.post('/api/admin/test/branch-content', {
    headers: adminHeaders(),
    data: { branchId, content },
  });
  if (!res.ok()) throw new Error(`seedBranchContent failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

/** Seed an activity entry via admin test endpoint */
export async function seedActivity(
  request: APIRequestContext,
  documentId: string,
  userId: number,
  eventType = 'edit',
  metadata: Record<string, any> = {},
): Promise<{ id: number }> {
  const res = await request.post('/api/admin/test/activity', {
    headers: adminHeaders(),
    data: { documentId, userId, eventType, metadata },
  });
  if (!res.ok()) throw new Error(`seedActivity failed: ${res.status()} ${await res.text()}`);
  return res.json();
}
