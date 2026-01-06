import { APIRequestContext } from '@playwright/test';

/**
 * Test Cleanup Utilities
 *
 * Helpers for cleaning up test data after E2E tests.
 */

// Track test users created during tests for cleanup
const createdTestEmails: string[] = [];

/**
 * Register a test email for cleanup
 */
export function trackTestEmail(email: string): void {
  createdTestEmails.push(email);
}

/**
 * Get all tracked test emails
 */
export function getTrackedEmails(): string[] {
  return [...createdTestEmails];
}

/**
 * Clear tracked emails (call after cleanup)
 */
export function clearTrackedEmails(): void {
  createdTestEmails.length = 0;
}

/**
 * Check if an email is a test email (based on pattern)
 */
export function isTestEmail(email: string): boolean {
  return email.includes('@e2e-test.local') || email.startsWith('test-');
}

/**
 * Cleanup test users created during tests
 *
 * Note: This requires an admin endpoint or direct database access.
 * For now, we rely on the test email pattern to identify test users
 * that can be cleaned up in bulk during maintenance.
 */
export async function cleanupTestUsers(
  request: APIRequestContext,
  emails: string[]
): Promise<void> {
  // In a production setup, you would call an admin endpoint here
  // For now, we just log which users would be cleaned up
  if (emails.length > 0) {
    console.log(`[E2E Cleanup] Would clean up ${emails.length} test users:`, emails);
  }
}

/**
 * Clean up all tracked test users
 */
export async function cleanupAllTrackedUsers(
  request: APIRequestContext
): Promise<void> {
  const emails = getTrackedEmails();
  if (emails.length > 0) {
    await cleanupTestUsers(request, emails);
    clearTrackedEmails();
  }
}
