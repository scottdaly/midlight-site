import { test, expect } from '@playwright/test';
import { desktopHeaders } from './fixtures/auth';
import {
  createProUser,
  createFreeUser,
  createTestDocument,
  enableSharing,
  inviteUser,
  CollabUser,
} from './fixtures/collab';

/**
 * Sharing API E2E Tests (QA Section 1)
 *
 * Tests document sharing endpoints: enable/disable link sharing,
 * permission levels, invitations, and access control.
 */

test.describe('Sharing - Link Sharing', () => {
  let owner: CollabUser;
  let docId: string;

  test.beforeEach(async ({ request }) => {
    owner = await createProUser(request, 'Share Owner');
    const doc = await createTestDocument(request, owner.userId);
    docId = doc.id;
  });

  test('enable link sharing returns share settings with linkToken', async ({ request }) => {
    const share = await enableSharing(request, owner.accessToken, docId);

    expect(share.linkToken).toBeDefined();
    expect(share.linkToken.length).toBeGreaterThan(10);
    expect(share.linkPermission).toBe('view');
    expect(share.linkEnabled).toBe(true);
  });

  test('GET share settings returns existing config', async ({ request }) => {
    await enableSharing(request, owner.accessToken, docId);

    const res = await request.get(`/api/share/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.linkToken).toBeDefined();
    expect(body.linkEnabled).toBeTruthy();
  });

  test('GET share settings for unshared doc returns exists:false', async ({ request }) => {
    const res = await request.get(`/api/share/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.exists).toBe(false);
  });

  test('resolve share link returns document metadata', async ({ request }) => {
    const share = await enableSharing(request, owner.accessToken, docId);

    const res = await request.get(`/api/share/link/${share.linkToken}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.documentId).toBe(docId);
    expect(body.permission).toBe('view');
  });

  test('set link permission to edit', async ({ request }) => {
    const share = await enableSharing(request, owner.accessToken, docId, {
      linkPermission: 'edit',
    });

    expect(share.linkPermission).toBe('edit');

    // Verify via link resolution
    const res = await request.get(`/api/share/link/${share.linkToken}`);
    const body = await res.json();
    expect(body.permission).toBe('edit');
  });

  test('disable link sharing makes link return 404', async ({ request }) => {
    const share = await enableSharing(request, owner.accessToken, docId);

    // Disable sharing
    await request.post(`/api/share/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { linkEnabled: false, linkPermission: 'view' },
    });

    const res = await request.get(`/api/share/link/${share.linkToken}`);
    expect(res.status()).toBe(404);
  });

  test('expired link returns 410', async ({ request }) => {
    const pastDate = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
    const share = await enableSharing(request, owner.accessToken, docId, {
      expiresAt: pastDate,
    });

    const res = await request.get(`/api/share/link/${share.linkToken}`);
    expect(res.status()).toBe(410);
  });

  test('delete all sharing removes share settings', async ({ request }) => {
    await enableSharing(request, owner.accessToken, docId);

    const delRes = await request.delete(`/api/share/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(delRes.ok()).toBeTruthy();

    // Verify share is gone
    const res = await request.get(`/api/share/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    const body = await res.json();
    expect(body.exists).toBe(false);
  });
});

test.describe('Sharing - Invitations', () => {
  let owner: CollabUser;
  let invitee: CollabUser;
  let docId: string;

  test.beforeEach(async ({ request }) => {
    owner = await createProUser(request, 'Invite Owner');
    invitee = await createProUser(request, 'Invite Target');
    const doc = await createTestDocument(request, owner.userId);
    docId = doc.id;
    await enableSharing(request, owner.accessToken, docId);
  });

  test('invite user by email', async ({ request }) => {
    const invite = await inviteUser(request, owner.accessToken, docId, invitee.email, 'edit');

    expect(invite.id).toBeDefined();
    expect(invite.email).toBe(invitee.email.toLowerCase());
    expect(invite.permission).toBe('edit');
  });

  test('invited user sees doc in shared-with-me list', async ({ request }) => {
    await inviteUser(request, owner.accessToken, docId, invitee.email);

    const res = await request.get('/api/share/shared', {
      headers: desktopHeaders(invitee.accessToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.documents.length).toBeGreaterThanOrEqual(1);
    expect(body.documents.some((d: any) => d.documentId === docId)).toBeTruthy();
  });

  test('change invited user permission', async ({ request }) => {
    const invite = await inviteUser(request, owner.accessToken, docId, invitee.email, 'view');

    const res = await request.patch(`/api/share/${docId}/access/${invite.id}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { permission: 'edit' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.permission).toBe('edit');
  });

  test('revoke access removes invitation', async ({ request }) => {
    const invite = await inviteUser(request, owner.accessToken, docId, invitee.email);

    const res = await request.delete(`/api/share/${docId}/access/${invite.id}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(res.ok()).toBeTruthy();

    // Verify no longer in shared-with-me
    const sharedRes = await request.get('/api/share/shared', {
      headers: desktopHeaders(invitee.accessToken),
    });
    const body = await sharedRes.json();
    expect(body.documents.some((d: any) => d.documentId === docId)).toBeFalsy();
  });

  test('self-invite returns 400', async ({ request }) => {
    const res = await request.post(`/api/share/${docId}/invite`, {
      headers: desktopHeaders(owner.accessToken),
      data: { email: owner.email, permission: 'view' },
    });
    expect(res.status()).toBe(400);
  });

  test('duplicate invite returns 409', async ({ request }) => {
    await inviteUser(request, owner.accessToken, docId, invitee.email);

    const res = await request.post(`/api/share/${docId}/invite`, {
      headers: desktopHeaders(owner.accessToken),
      data: { email: invitee.email, permission: 'view' },
    });
    expect(res.status()).toBe(409);
  });
});

test.describe('Sharing - Access Control', () => {
  test('free tier user cannot enable sharing (403)', async ({ request }) => {
    const freeUser = await createFreeUser(request, 'Free User');
    const doc = await createTestDocument(request, freeUser.userId);

    const res = await request.post(`/api/share/${doc.id}`, {
      headers: desktopHeaders(freeUser.accessToken),
      data: { linkPermission: 'view', linkEnabled: true },
    });
    expect(res.status()).toBe(403);
  });

  test('non-owner cannot manage sharing', async ({ request }) => {
    const owner = await createProUser(request, 'Owner');
    const other = await createProUser(request, 'Other');
    const doc = await createTestDocument(request, owner.userId);

    const res = await request.post(`/api/share/${doc.id}`, {
      headers: desktopHeaders(other.accessToken),
      data: { linkPermission: 'view', linkEnabled: true },
    });
    expect(res.status()).toBe(403);
  });
});
