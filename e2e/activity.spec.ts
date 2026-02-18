import { test, expect } from '@playwright/test';
import { desktopHeaders } from './fixtures/auth';
import {
  createProUser,
  createFreeUser,
  createTestDocument,
  enableSharing,
  inviteUser,
  seedActivity,
  CollabUser,
} from './fixtures/collab';

/**
 * Activity API E2E Tests (QA Section 7)
 *
 * Tests document activity feed, personal feed, and access control.
 */

test.describe('Activity - Document Feed', () => {
  let owner: CollabUser;
  let docId: string;

  test.beforeEach(async ({ request }) => {
    owner = await createProUser(request, 'Activity Owner');
    const doc = await createTestDocument(request, owner.userId);
    docId = doc.id;
  });

  test('document activity with seeded entries', async ({ request }) => {
    await seedActivity(request, docId, owner.userId, 'edit');
    await seedActivity(request, docId, owner.userId, 'comment');

    const res = await request.get(`/api/activity/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.activity.length).toBe(2);
    expect(body.activity.some((a: any) => a.eventType === 'edit')).toBeTruthy();
    expect(body.activity.some((a: any) => a.eventType === 'comment')).toBeTruthy();
  });

  test('multi-actor activity feed', async ({ request }) => {
    const editor = await createProUser(request, 'Editor');
    await enableSharing(request, owner.accessToken, docId, { linkPermission: 'edit' });
    await inviteUser(request, owner.accessToken, docId, editor.email, 'edit');

    await seedActivity(request, docId, owner.userId, 'edit');
    await seedActivity(request, docId, editor.userId, 'comment');

    const res = await request.get(`/api/activity/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    const body = await res.json();
    expect(body.activity.length).toBe(2);
    const userIds = body.activity.map((a: any) => a.userId);
    expect(userIds).toContain(owner.userId);
    expect(userIds).toContain(editor.userId);
  });

  test('pagination works', async ({ request }) => {
    // Seed 5 entries
    for (let i = 0; i < 5; i++) {
      await seedActivity(request, docId, owner.userId, 'edit');
    }

    const res = await request.get(`/api/activity/${docId}?limit=2&offset=0`, {
      headers: desktopHeaders(owner.accessToken),
    });
    const body = await res.json();
    expect(body.activity.length).toBe(2);
    expect(body.total).toBe(5);
  });
});

test.describe('Activity - Personal Feed', () => {
  test('personal feed across all documents', async ({ request }) => {
    const user = await createProUser(request, 'Feed User');
    const doc1 = await createTestDocument(request, user.userId, '/doc1.midlight');
    const doc2 = await createTestDocument(request, user.userId, '/doc2.midlight');

    await seedActivity(request, doc1.id, user.userId, 'edit');
    await seedActivity(request, doc2.id, user.userId, 'share');

    const res = await request.get('/api/activity/me', {
      headers: desktopHeaders(user.accessToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.activity.length).toBe(2);
  });
});

test.describe('Activity - Access Control', () => {
  test('non-authorized user gets 403 for document activity', async ({ request }) => {
    const owner = await createProUser(request, 'Owner');
    const stranger = await createProUser(request, 'Stranger');
    const doc = await createTestDocument(request, owner.userId);
    await seedActivity(request, doc.id, owner.userId, 'edit');

    const res = await request.get(`/api/activity/${doc.id}`, {
      headers: desktopHeaders(stranger.accessToken),
    });
    expect(res.status()).toBe(403);
  });
});
