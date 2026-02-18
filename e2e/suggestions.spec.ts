import { test, expect } from '@playwright/test';
import { desktopHeaders } from './fixtures/auth';
import {
  createProUser,
  createTestDocument,
  enableSharing,
  inviteUser,
  CollabUser,
} from './fixtures/collab';

/**
 * Suggestions API E2E Tests (QA Section 5)
 *
 * Tests tracked changes: create, list, accept, reject, accept-all.
 */

test.describe('Suggestions - CRUD', () => {
  let owner: CollabUser;
  let docId: string;

  test.beforeEach(async ({ request }) => {
    owner = await createProUser(request, 'Suggestion Owner');
    const doc = await createTestDocument(request, owner.userId);
    docId = doc.id;
  });

  test('create insertion suggestion', async ({ request }) => {
    const res = await request.post(`/api/suggestions/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: {
        type: 'insertion',
        anchorFrom: 10,
        anchorTo: 10,
        suggestedText: 'new text here',
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.suggestion.type).toBe('insertion');
    expect(body.suggestion.status).toBe('pending');
    expect(body.suggestion.suggestedText).toBe('new text here');
  });

  test('create deletion suggestion', async ({ request }) => {
    const res = await request.post(`/api/suggestions/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: {
        type: 'deletion',
        anchorFrom: 5,
        anchorTo: 20,
        originalText: 'text to delete',
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.suggestion.type).toBe('deletion');
  });

  test('create replacement suggestion', async ({ request }) => {
    const res = await request.post(`/api/suggestions/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: {
        type: 'replacement',
        anchorFrom: 5,
        anchorTo: 15,
        originalText: 'old text',
        suggestedText: 'better text',
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.suggestion.type).toBe('replacement');
    expect(body.suggestion.originalText).toBe('old text');
    expect(body.suggestion.suggestedText).toBe('better text');
  });

  test('list suggestions for a document', async ({ request }) => {
    // Create two suggestions
    await request.post(`/api/suggestions/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { type: 'insertion', anchorFrom: 0, anchorTo: 0, suggestedText: 'A' },
    });
    await request.post(`/api/suggestions/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { type: 'insertion', anchorFrom: 5, anchorTo: 5, suggestedText: 'B' },
    });

    const listRes = await request.get(`/api/suggestions/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(listRes.ok()).toBeTruthy();
    const body = await listRes.json();
    expect(body.suggestions.length).toBe(2);
  });
});

test.describe('Suggestions - Accept / Reject', () => {
  let owner: CollabUser;
  let docId: string;

  test.beforeEach(async ({ request }) => {
    owner = await createProUser(request, 'Accept/Reject Owner');
    const doc = await createTestDocument(request, owner.userId);
    docId = doc.id;
  });

  test('accept a pending suggestion', async ({ request }) => {
    const createRes = await request.post(`/api/suggestions/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { type: 'insertion', anchorFrom: 0, anchorTo: 0, suggestedText: 'accepted' },
    });
    const sug = (await createRes.json()).suggestion;

    const acceptRes = await request.post(`/api/suggestions/${docId}/${sug.id}/accept`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(acceptRes.ok()).toBeTruthy();
  });

  test('reject a pending suggestion', async ({ request }) => {
    const createRes = await request.post(`/api/suggestions/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { type: 'deletion', anchorFrom: 0, anchorTo: 5, originalText: 'bye' },
    });
    const sug = (await createRes.json()).suggestion;

    const rejectRes = await request.post(`/api/suggestions/${docId}/${sug.id}/reject`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(rejectRes.ok()).toBeTruthy();
  });

  test('accept already-resolved suggestion returns 400', async ({ request }) => {
    const createRes = await request.post(`/api/suggestions/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { type: 'insertion', anchorFrom: 0, anchorTo: 0, suggestedText: 'once' },
    });
    const sug = (await createRes.json()).suggestion;

    // Accept first
    await request.post(`/api/suggestions/${docId}/${sug.id}/accept`, {
      headers: desktopHeaders(owner.accessToken),
    });

    // Try to accept again
    const res = await request.post(`/api/suggestions/${docId}/${sug.id}/accept`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(res.status()).toBe(400);
  });

  test('accept-all as owner', async ({ request }) => {
    // Create 3 pending suggestions
    for (let i = 0; i < 3; i++) {
      await request.post(`/api/suggestions/${docId}`, {
        headers: desktopHeaders(owner.accessToken),
        data: { type: 'insertion', anchorFrom: i, anchorTo: i, suggestedText: `s${i}` },
      });
    }

    const res = await request.post(`/api/suggestions/${docId}/accept-all`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.accepted).toBe(3);
  });

  test('non-owner cannot accept-all', async ({ request }) => {
    const editor = await createProUser(request, 'Editor');
    await enableSharing(request, owner.accessToken, docId, { linkPermission: 'edit' });
    await inviteUser(request, owner.accessToken, docId, editor.email, 'edit');

    await request.post(`/api/suggestions/${docId}`, {
      headers: desktopHeaders(editor.accessToken),
      data: { type: 'insertion', anchorFrom: 0, anchorTo: 0, suggestedText: 'editor sug' },
    });

    const res = await request.post(`/api/suggestions/${docId}/accept-all`, {
      headers: desktopHeaders(editor.accessToken),
    });
    expect(res.status()).toBe(403);
  });
});

test.describe('Suggestions - Access Control', () => {
  test('view-only user cannot create suggestion', async ({ request }) => {
    const owner = await createProUser(request, 'Owner');
    const viewer = await createProUser(request, 'Viewer');
    const doc = await createTestDocument(request, owner.userId);
    await enableSharing(request, owner.accessToken, doc.id, { linkPermission: 'view' });
    await inviteUser(request, owner.accessToken, doc.id, viewer.email, 'view');

    const res = await request.post(`/api/suggestions/${doc.id}`, {
      headers: desktopHeaders(viewer.accessToken),
      data: { type: 'insertion', anchorFrom: 0, anchorTo: 0, suggestedText: 'nope' },
    });
    expect(res.status()).toBe(403);
  });

  test('invalid suggestion type returns 400', async ({ request }) => {
    const owner = await createProUser(request, 'Owner');
    const doc = await createTestDocument(request, owner.userId);

    const res = await request.post(`/api/suggestions/${doc.id}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { type: 'invalid_type', anchorFrom: 0, anchorTo: 0 },
    });
    expect(res.status()).toBe(400);
  });

  test('missing anchors returns 400', async ({ request }) => {
    const owner = await createProUser(request, 'Owner');
    const doc = await createTestDocument(request, owner.userId);

    const res = await request.post(`/api/suggestions/${doc.id}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { type: 'insertion', suggestedText: 'no anchors' },
    });
    expect(res.status()).toBe(400);
  });
});
