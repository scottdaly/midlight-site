import { test, expect } from '@playwright/test';
import { desktopHeaders } from './fixtures/auth';
import {
  createProUser,
  createTestDocument,
  enableSharing,
  createGuestSession,
  CollabUser,
} from './fixtures/collab';

/**
 * Guest Access API E2E Tests (QA Section 2)
 *
 * Tests guest session creation, token refresh, and permission enforcement.
 * Note: Guest POST endpoints need desktop headers with a valid token to bypass CSRF.
 */

test.describe('Guest Access', () => {
  let owner: CollabUser;
  let docId: string;
  let linkToken: string;

  test.beforeEach(async ({ request }) => {
    owner = await createProUser(request, 'Guest Test Owner');
    const doc = await createTestDocument(request, owner.userId);
    docId = doc.id;
    const share = await enableSharing(request, owner.accessToken, docId, {
      linkPermission: 'edit',
    });
    linkToken = share.linkToken;
  });

  test('create guest session with edit permission', async ({ request }) => {
    const guest = await createGuestSession(request, linkToken, 'Guest Editor', owner.accessToken);

    expect(guest.sessionId).toBeDefined();
    expect(guest.token).toBeDefined();
    expect(guest.displayName).toBe('Guest Editor');
    expect(guest.permission).toBe('edit');
    expect(guest.expiresAt).toBeDefined();
  });

  test('refresh guest token returns new JWT', async ({ request }) => {
    const guest = await createGuestSession(request, linkToken, 'Test Guest', owner.accessToken);

    const res = await request.post(`/api/share/link/${linkToken}/guest/refresh`, {
      headers: desktopHeaders(guest.token),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.token).toBeDefined();
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(20);
  });

  test('guest on view-only link gets view permission', async ({ request }) => {
    // Re-enable sharing with view-only
    const share = await enableSharing(request, owner.accessToken, docId, {
      linkPermission: 'view',
    });

    const guest = await createGuestSession(request, share.linkToken, 'View Guest', owner.accessToken);
    expect(guest.permission).toBe('view');
  });

  test('new guest session creates separate session', async ({ request }) => {
    const guest1 = await createGuestSession(request, linkToken, 'Guest A', owner.accessToken);
    const guest2 = await createGuestSession(request, linkToken, 'Guest B', owner.accessToken);

    expect(guest1.sessionId).not.toBe(guest2.sessionId);
    expect(guest1.token).not.toBe(guest2.token);
  });

  test('disabled link rejects guest session', async ({ request }) => {
    // Disable sharing
    await request.post(`/api/share/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { linkEnabled: false, linkPermission: 'edit' },
    });

    const res = await request.post(`/api/share/link/${linkToken}/guest`, {
      headers: desktopHeaders(owner.accessToken),
      data: { displayName: 'Rejected Guest' },
    });
    expect(res.ok()).toBeFalsy();
  });

  test('empty display name is rejected', async ({ request }) => {
    const res = await request.post(`/api/share/link/${linkToken}/guest`, {
      headers: desktopHeaders(owner.accessToken),
      data: { displayName: '' },
    });
    expect(res.ok()).toBeFalsy();
  });

  test('expired link rejects guest session', async ({ request }) => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const share = await enableSharing(request, owner.accessToken, docId, {
      expiresAt: pastDate,
    });

    const res = await request.post(`/api/share/link/${share.linkToken}/guest`, {
      headers: desktopHeaders(owner.accessToken),
      data: { displayName: 'Late Guest' },
    });
    expect(res.status()).toBe(410);
  });
});
