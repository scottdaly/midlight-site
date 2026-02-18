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
 * Comments API E2E Tests (QA Section 4)
 *
 * Tests document comment CRUD, threading, resolution, and access control.
 */

test.describe('Comments - CRUD', () => {
  let owner: CollabUser;
  let docId: string;

  test.beforeEach(async ({ request }) => {
    owner = await createProUser(request, 'Comment Owner');
    const doc = await createTestDocument(request, owner.userId);
    docId = doc.id;
  });

  test('create a comment with anchors', async ({ request }) => {
    const res = await request.post(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: {
        content: 'This needs revision',
        anchorFrom: 10,
        anchorTo: 25,
        anchorText: 'some selected text',
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.comment.id).toBeDefined();
    expect(body.comment.content).toBe('This needs revision');
    expect(body.comment.anchorFrom).toBe(10);
    expect(body.comment.anchorTo).toBe(25);
  });

  test('list comments returns threads with replies', async ({ request }) => {
    // Create a thread
    const createRes = await request.post(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'Thread starter' },
    });
    const thread = (await createRes.json()).comment;

    // Add a reply
    await request.post(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'A reply', parentId: thread.id },
    });

    // List
    const listRes = await request.get(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(listRes.ok()).toBeTruthy();
    const body = await listRes.json();
    expect(body.comments.length).toBe(1); // 1 thread
    expect(body.comments[0].replies.length).toBe(1);
    expect(body.comments[0].replies[0].content).toBe('A reply');
  });

  test('reply to a comment', async ({ request }) => {
    const createRes = await request.post(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'Root comment' },
    });
    const parent = (await createRes.json()).comment;

    const replyRes = await request.post(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'My reply', parentId: parent.id },
    });
    expect(replyRes.status()).toBe(201);
    const reply = (await replyRes.json()).comment;
    expect(reply.parentId).toBe(parent.id);
  });

  test('author can edit their comment', async ({ request }) => {
    const createRes = await request.post(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'Original text' },
    });
    const comment = (await createRes.json()).comment;

    const editRes = await request.patch(`/api/comments/${docId}/${comment.id}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'Updated text' },
    });
    expect(editRes.ok()).toBeTruthy();
  });

  test('non-author cannot edit comment', async ({ request }) => {
    const other = await createProUser(request, 'Other User');
    await enableSharing(request, owner.accessToken, docId, { linkPermission: 'edit' });
    await inviteUser(request, owner.accessToken, docId, other.email, 'edit');

    // Owner creates a comment
    const createRes = await request.post(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'Owner comment' },
    });
    const comment = (await createRes.json()).comment;

    // Other tries to edit
    const editRes = await request.patch(`/api/comments/${docId}/${comment.id}`, {
      headers: desktopHeaders(other.accessToken),
      data: { content: 'Hacked text' },
    });
    expect(editRes.status()).toBe(403);
  });

  test('author can delete their comment', async ({ request }) => {
    const createRes = await request.post(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'Doomed comment' },
    });
    const comment = (await createRes.json()).comment;

    const delRes = await request.delete(`/api/comments/${docId}/${comment.id}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(delRes.ok()).toBeTruthy();
  });

  test('deleting a thread parent cascades to replies', async ({ request }) => {
    const parentRes = await request.post(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'Parent' },
    });
    const parent = (await parentRes.json()).comment;

    await request.post(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'Reply 1', parentId: parent.id },
    });
    await request.post(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'Reply 2', parentId: parent.id },
    });

    // Delete parent
    await request.delete(`/api/comments/${docId}/${parent.id}`, {
      headers: desktopHeaders(owner.accessToken),
    });

    // Verify all gone
    const listRes = await request.get(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    const body = await listRes.json();
    expect(body.comments.length).toBe(0);
  });

  test('owner can delete others comments', async ({ request }) => {
    const other = await createProUser(request, 'Commenter');
    await enableSharing(request, owner.accessToken, docId, { linkPermission: 'edit' });
    await inviteUser(request, owner.accessToken, docId, other.email, 'edit');

    // Other creates a comment
    const createRes = await request.post(`/api/comments/${docId}`, {
      headers: desktopHeaders(other.accessToken),
      data: { content: 'Other comment' },
    });
    const comment = (await createRes.json()).comment;

    // Owner deletes it
    const delRes = await request.delete(`/api/comments/${docId}/${comment.id}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(delRes.ok()).toBeTruthy();
  });
});

test.describe('Comments - Resolution', () => {
  let owner: CollabUser;
  let docId: string;

  test.beforeEach(async ({ request }) => {
    owner = await createProUser(request, 'Resolve Owner');
    const doc = await createTestDocument(request, owner.userId);
    docId = doc.id;
  });

  test('resolve a comment thread', async ({ request }) => {
    const createRes = await request.post(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'Resolvable thread' },
    });
    const comment = (await createRes.json()).comment;

    const resolveRes = await request.post(`/api/comments/${docId}/${comment.id}/resolve`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(resolveRes.ok()).toBeTruthy();

    // Verify resolved in listing
    const listRes = await request.get(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    const body = await listRes.json();
    const resolved = body.comments.find((c: any) => c.id === comment.id);
    expect(resolved.resolvedAt).toBeDefined();
  });

  test('reopen a resolved thread', async ({ request }) => {
    const createRes = await request.post(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'Reopenable thread' },
    });
    const comment = (await createRes.json()).comment;

    await request.post(`/api/comments/${docId}/${comment.id}/resolve`, {
      headers: desktopHeaders(owner.accessToken),
    });

    const reopenRes = await request.post(`/api/comments/${docId}/${comment.id}/reopen`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(reopenRes.ok()).toBeTruthy();
  });

  test('reopen a non-resolved comment returns 400', async ({ request }) => {
    const createRes = await request.post(`/api/comments/${docId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'Not resolved yet' },
    });
    const comment = (await createRes.json()).comment;

    const reopenRes = await request.post(`/api/comments/${docId}/${comment.id}/reopen`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(reopenRes.status()).toBe(400);
  });
});

test.describe('Comments - Access Control', () => {
  test('view-only user cannot create comment', async ({ request }) => {
    const owner = await createProUser(request, 'Owner');
    const viewer = await createProUser(request, 'Viewer');
    const doc = await createTestDocument(request, owner.userId);
    await enableSharing(request, owner.accessToken, doc.id, { linkPermission: 'view' });
    await inviteUser(request, owner.accessToken, doc.id, viewer.email, 'view');

    const res = await request.post(`/api/comments/${doc.id}`, {
      headers: desktopHeaders(viewer.accessToken),
      data: { content: 'Should fail' },
    });
    expect(res.status()).toBe(403);
  });

  test('comment content max length enforced', async ({ request }) => {
    const owner = await createProUser(request, 'Owner');
    const doc = await createTestDocument(request, owner.userId);

    const res = await request.post(`/api/comments/${doc.id}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'x'.repeat(10001) },
    });
    expect(res.status()).toBe(400);
  });

  test('nested reply rejected (reply to a reply)', async ({ request }) => {
    const owner = await createProUser(request, 'Owner');
    const doc = await createTestDocument(request, owner.userId);

    // Create thread
    const threadRes = await request.post(`/api/comments/${doc.id}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'Thread' },
    });
    const thread = (await threadRes.json()).comment;

    // Create reply
    const replyRes = await request.post(`/api/comments/${doc.id}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'Reply', parentId: thread.id },
    });
    const reply = (await replyRes.json()).comment;

    // Try to reply to the reply
    const nestedRes = await request.post(`/api/comments/${doc.id}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { content: 'Nested reply', parentId: reply.id },
    });
    expect(nestedRes.status()).toBe(400);
  });
});
