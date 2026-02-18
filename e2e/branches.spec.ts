import { test, expect } from '@playwright/test';
import { desktopHeaders } from './fixtures/auth';
import {
  createProUser,
  createTestDocument,
  enableSharing,
  inviteUser,
  seedBranchContent,
  CollabUser,
} from './fixtures/collab';

/**
 * Branches API E2E Tests (QA Section 8)
 *
 * Tests document branching: create, list, get, diff, merge, abandon, access control.
 */

test.describe('Branches - CRUD', () => {
  let owner: CollabUser;
  let docId: string;

  test.beforeEach(async ({ request }) => {
    owner = await createProUser(request, 'Branch Owner');
    const doc = await createTestDocument(request, owner.userId);
    docId = doc.id;
  });

  test('create a branch', async ({ request }) => {
    const res = await request.post(`/api/branches/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: {
        name: 'Rewrite intro',
        baseVersionId: 'v1',
        baseContentHash: 'abc123',
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.branch.name).toBe('Rewrite intro');
    expect(body.branch.status).toBe('active');
    expect(body.branch.documentId).toBe(docId);
  });

  test('list branches for a document', async ({ request }) => {
    await request.post(`/api/branches/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { name: 'Branch A', baseVersionId: 'v1', baseContentHash: 'abc' },
    });
    await request.post(`/api/branches/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { name: 'Branch B', baseVersionId: 'v1', baseContentHash: 'def' },
    });

    const res = await request.get(`/api/branches/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.branches.length).toBe(2);
  });

  test('get branch with content', async ({ request }) => {
    const createRes = await request.post(`/api/branches/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { name: 'Detail Branch', baseVersionId: 'v1', baseContentHash: 'abc' },
    });
    const branch = (await createRes.json()).branch;

    const res = await request.get(`/api/branches/${docId}/${branch.id}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.branch.id).toBe(branch.id);
    expect(body.branch.name).toBe('Detail Branch');
  });

  test('get diff between branch and main', async ({ request }) => {
    const createRes = await request.post(`/api/branches/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { name: 'Diff Branch', baseVersionId: 'v1', baseContentHash: 'abc' },
    });
    const branch = (await createRes.json()).branch;

    const res = await request.get(`/api/branches/${docId}/${branch.id}/diff`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // Diff endpoint returns branch and main content
    expect(body).toHaveProperty('branch');
    expect(body).toHaveProperty('main');
  });

  test('duplicate branch name returns 409', async ({ request }) => {
    await request.post(`/api/branches/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { name: 'Unique Name', baseVersionId: 'v1', baseContentHash: 'abc' },
    });

    const res = await request.post(`/api/branches/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { name: 'Unique Name', baseVersionId: 'v1', baseContentHash: 'def' },
    });
    expect(res.status()).toBe(409);
  });
});

test.describe('Branches - Merge & Abandon', () => {
  let owner: CollabUser;
  let docId: string;

  test.beforeEach(async ({ request }) => {
    owner = await createProUser(request, 'Merge Owner');
    const doc = await createTestDocument(request, owner.userId);
    docId = doc.id;
  });

  test('merge an active branch', async ({ request }) => {
    const createRes = await request.post(`/api/branches/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { name: 'Merge Me', baseVersionId: 'v1', baseContentHash: 'abc' },
    });
    const branch = (await createRes.json()).branch;

    // Seed branch content (required for merge)
    await seedBranchContent(request, branch.id, '# Merged content');

    const mergeRes = await request.post(`/api/branches/${docId}/${branch.id}/merge`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(mergeRes.ok()).toBeTruthy();

    // Verify branch status is now merged
    const getRes = await request.get(`/api/branches/${docId}/${branch.id}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    const body = await getRes.json();
    expect(body.branch.status).toBe('merged');
  });

  test('abandon an active branch', async ({ request }) => {
    const createRes = await request.post(`/api/branches/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { name: 'Abandon Me', baseVersionId: 'v1', baseContentHash: 'abc' },
    });
    const branch = (await createRes.json()).branch;

    const abandonRes = await request.delete(`/api/branches/${docId}/${branch.id}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(abandonRes.ok()).toBeTruthy();

    // Verify branch status is abandoned
    const getRes = await request.get(`/api/branches/${docId}/${branch.id}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    const body = await getRes.json();
    expect(body.branch.status).toBe('abandoned');
  });

  test('merge a non-active branch returns 400', async ({ request }) => {
    const createRes = await request.post(`/api/branches/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { name: 'Already Done', baseVersionId: 'v1', baseContentHash: 'abc' },
    });
    const branch = (await createRes.json()).branch;

    // Abandon first
    await request.delete(`/api/branches/${docId}/${branch.id}`, {
      headers: desktopHeaders(owner.accessToken),
    });

    // Try to merge
    const mergeRes = await request.post(`/api/branches/${docId}/${branch.id}/merge`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(mergeRes.status()).toBe(400);
  });

  test('abandon a non-active branch returns 400', async ({ request }) => {
    const createRes = await request.post(`/api/branches/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { name: 'Already Merged', baseVersionId: 'v1', baseContentHash: 'abc' },
    });
    const branch = (await createRes.json()).branch;

    // Seed content and merge first
    await seedBranchContent(request, branch.id, '# Merged');
    await request.post(`/api/branches/${docId}/${branch.id}/merge`, {
      headers: desktopHeaders(owner.accessToken),
    });

    // Try to abandon
    const abandonRes = await request.delete(`/api/branches/${docId}/${branch.id}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(abandonRes.status()).toBe(400);
  });
});

test.describe('Branches - Access Control', () => {
  test('view-only user cannot create branch', async ({ request }) => {
    const owner = await createProUser(request, 'Owner');
    const viewer = await createProUser(request, 'Viewer');
    const doc = await createTestDocument(request, owner.userId);
    await enableSharing(request, owner.accessToken, doc.id, { linkPermission: 'view' });
    await inviteUser(request, owner.accessToken, doc.id, viewer.email, 'view');

    const res = await request.post(`/api/branches/${doc.id}`, {
      headers: desktopHeaders(viewer.accessToken),
      data: { name: 'Blocked', baseVersionId: 'v1', baseContentHash: 'abc' },
    });
    expect(res.status()).toBe(403);
  });
});
