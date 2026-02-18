import { test, expect } from '@playwright/test';
import { desktopHeaders } from './fixtures/auth';
import {
  createProUser,
  createFreeUser,
  createPremiumUser,
  createTestDocument,
  CollabUser,
} from './fixtures/collab';

/**
 * Teams API E2E Tests (QA Section 9)
 *
 * Tests team CRUD, membership, document management, and access control.
 */

test.describe('Teams - Creation', () => {
  test('premium user can create a team', async ({ request }) => {
    const user = await createPremiumUser(request, 'Team Creator');
    const teamName = `QA Team ${Date.now()}`;

    const res = await request.post('/api/teams', {
      headers: desktopHeaders(user.accessToken),
      data: { name: teamName, description: 'Quality assurance' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.team.name).toBe(teamName);
    expect(body.team.myRole).toBe('owner');
    expect(body.team.memberCount).toBe(1);
  });

  test('free user cannot create a team (403)', async ({ request }) => {
    const user = await createFreeUser(request, 'Free Team User');

    const res = await request.post('/api/teams', {
      headers: desktopHeaders(user.accessToken),
      data: { name: 'Blocked Team' },
    });
    expect(res.status()).toBe(403);
  });

  test('pro user cannot create a team (403)', async ({ request }) => {
    const user = await createProUser(request, 'Pro Team User');

    const res = await request.post('/api/teams', {
      headers: desktopHeaders(user.accessToken),
      data: { name: 'Blocked Team' },
    });
    expect(res.status()).toBe(403);
  });

  test('duplicate team name returns 409', async ({ request }) => {
    const user = await createPremiumUser(request, 'Dup Team User');
    const teamName = `Unique Team ${Date.now()}`;

    await request.post('/api/teams', {
      headers: desktopHeaders(user.accessToken),
      data: { name: teamName },
    });

    const res = await request.post('/api/teams', {
      headers: desktopHeaders(user.accessToken),
      data: { name: teamName },
    });
    expect(res.status()).toBe(409);
  });
});

test.describe('Teams - Membership', () => {
  let owner: CollabUser;
  let teamId: string;

  test.beforeEach(async ({ request }) => {
    owner = await createPremiumUser(request, 'Team Owner');
    const res = await request.post('/api/teams', {
      headers: desktopHeaders(owner.accessToken),
      data: { name: `Team-${Date.now()}` },
    });
    teamId = (await res.json()).team.id;
  });

  test('add a member to the team', async ({ request }) => {
    const member = await createProUser(request, 'New Member');

    const res = await request.post(`/api/teams/${teamId}/members`, {
      headers: desktopHeaders(owner.accessToken),
      data: { email: member.email, role: 'member' },
    });
    expect(res.status()).toBe(201);
  });

  test('add a viewer to the team', async ({ request }) => {
    const viewer = await createProUser(request, 'New Viewer');

    const res = await request.post(`/api/teams/${teamId}/members`, {
      headers: desktopHeaders(owner.accessToken),
      data: { email: viewer.email, role: 'viewer' },
    });
    expect(res.status()).toBe(201);
  });

  test('list teams shows the user\'s team', async ({ request }) => {
    const res = await request.get('/api/teams', {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.teams.length).toBeGreaterThanOrEqual(1);
    expect(body.teams.some((t: any) => t.id === teamId)).toBeTruthy();
  });

  test('get team details with members', async ({ request }) => {
    const member = await createProUser(request, 'Detail Member');
    await request.post(`/api/teams/${teamId}/members`, {
      headers: desktopHeaders(owner.accessToken),
      data: { email: member.email, role: 'member' },
    });

    const res = await request.get(`/api/teams/${teamId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.members.length).toBe(2); // owner + member
    expect(body.members.some((m: any) => m.role === 'owner')).toBeTruthy();
    expect(body.members.some((m: any) => m.role === 'member')).toBeTruthy();
  });

  test('member cannot manage team', async ({ request }) => {
    const member = await createProUser(request, 'Restricted Member');
    await request.post(`/api/teams/${teamId}/members`, {
      headers: desktopHeaders(owner.accessToken),
      data: { email: member.email, role: 'member' },
    });

    // Member tries to add another user
    const other = await createProUser(request, 'Another');
    const res = await request.post(`/api/teams/${teamId}/members`, {
      headers: desktopHeaders(member.accessToken),
      data: { email: other.email, role: 'member' },
    });
    expect(res.status()).toBe(403);
  });

  test('remove a member from the team', async ({ request }) => {
    const member = await createProUser(request, 'Removable');
    await request.post(`/api/teams/${teamId}/members`, {
      headers: desktopHeaders(owner.accessToken),
      data: { email: member.email, role: 'member' },
    });

    // Get member ID from team details
    const detailsRes = await request.get(`/api/teams/${teamId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    const details = await detailsRes.json();
    const memberId = details.members.find((m: any) => m.role === 'member').id;

    const res = await request.delete(`/api/teams/${teamId}/members/${memberId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('cannot remove team owner', async ({ request }) => {
    const detailsRes = await request.get(`/api/teams/${teamId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    const details = await detailsRes.json();
    const ownerId = details.members.find((m: any) => m.role === 'owner').id;

    const res = await request.delete(`/api/teams/${teamId}/members/${ownerId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(res.status()).toBe(400);
  });

  test('duplicate member returns 409', async ({ request }) => {
    const member = await createProUser(request, 'Dup Member');
    await request.post(`/api/teams/${teamId}/members`, {
      headers: desktopHeaders(owner.accessToken),
      data: { email: member.email, role: 'member' },
    });

    const res = await request.post(`/api/teams/${teamId}/members`, {
      headers: desktopHeaders(owner.accessToken),
      data: { email: member.email, role: 'member' },
    });
    expect(res.status()).toBe(409);
  });
});

test.describe('Teams - Documents', () => {
  let owner: CollabUser;
  let teamId: string;

  test.beforeEach(async ({ request }) => {
    owner = await createPremiumUser(request, 'Doc Team Owner');
    const res = await request.post('/api/teams', {
      headers: desktopHeaders(owner.accessToken),
      data: { name: `DocTeam-${Date.now()}` },
    });
    teamId = (await res.json()).team.id;
  });

  test('add document to team', async ({ request }) => {
    const doc = await createTestDocument(request, owner.userId);

    const res = await request.post(`/api/teams/${teamId}/documents`, {
      headers: desktopHeaders(owner.accessToken),
      data: { documentId: doc.id },
    });
    expect(res.status()).toBe(201);
  });

  test('remove document from team', async ({ request }) => {
    const doc = await createTestDocument(request, owner.userId);
    await request.post(`/api/teams/${teamId}/documents`, {
      headers: desktopHeaders(owner.accessToken),
      data: { documentId: doc.id },
    });

    const res = await request.delete(`/api/teams/${teamId}/documents/${doc.id}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('duplicate document returns 409', async ({ request }) => {
    const doc = await createTestDocument(request, owner.userId);
    await request.post(`/api/teams/${teamId}/documents`, {
      headers: desktopHeaders(owner.accessToken),
      data: { documentId: doc.id },
    });

    const res = await request.post(`/api/teams/${teamId}/documents`, {
      headers: desktopHeaders(owner.accessToken),
      data: { documentId: doc.id },
    });
    expect(res.status()).toBe(409);
  });
});

test.describe('Teams - Update & Delete', () => {
  let owner: CollabUser;
  let teamId: string;

  test.beforeEach(async ({ request }) => {
    owner = await createPremiumUser(request, 'Update Team Owner');
    const res = await request.post('/api/teams', {
      headers: desktopHeaders(owner.accessToken),
      data: { name: `UpdTeam-${Date.now()}` },
    });
    teamId = (await res.json()).team.id;
  });

  test('update team name and description', async ({ request }) => {
    const res = await request.patch(`/api/teams/${teamId}`, {
      headers: desktopHeaders(owner.accessToken),
      data: { name: 'Renamed Team', description: 'New description' },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('non-admin cannot update team', async ({ request }) => {
    const member = await createProUser(request, 'Member');
    await request.post(`/api/teams/${teamId}/members`, {
      headers: desktopHeaders(owner.accessToken),
      data: { email: member.email, role: 'member' },
    });

    const res = await request.patch(`/api/teams/${teamId}`, {
      headers: desktopHeaders(member.accessToken),
      data: { name: 'Should Fail' },
    });
    expect(res.status()).toBe(403);
  });

  test('delete team as owner', async ({ request }) => {
    const res = await request.delete(`/api/teams/${teamId}`, {
      headers: desktopHeaders(owner.accessToken),
    });
    expect(res.ok()).toBeTruthy();

    // Verify team is gone from listing
    const listRes = await request.get('/api/teams', {
      headers: desktopHeaders(owner.accessToken),
    });
    const body = await listRes.json();
    expect(body.teams.some((t: any) => t.id === teamId)).toBeFalsy();
  });

  test('non-owner cannot delete team', async ({ request }) => {
    const member = await createProUser(request, 'Deleter');
    await request.post(`/api/teams/${teamId}/members`, {
      headers: desktopHeaders(owner.accessToken),
      data: { email: member.email, role: 'admin' },
    });

    const res = await request.delete(`/api/teams/${teamId}`, {
      headers: desktopHeaders(member.accessToken),
    });
    expect(res.status()).toBe(403);
  });
});
