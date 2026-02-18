import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildShareInvitationEmailContent } from '../services/emailService.js';

describe('buildShareInvitationEmailContent', () => {
  it('includes native deep link when provided', () => {
    const content = buildShareInvitationEmailContent({
      fromName: 'Owner User',
      documentTitle: 'Plan',
      shareUrl: 'https://midlight.ai/s/abc123',
      nativeShareUrl: 'midlight://s/abc123',
    });

    assert.match(content.subject, /Owner User shared "Plan" with you/);
    assert.match(content.html, /https:\/\/midlight\.ai\/s\/abc123/);
    assert.match(content.html, /midlight:\/\/s\/abc123/);
    assert.match(content.text, /Open in the Midlight app: midlight:\/\/s\/abc123/);
  });

  it('omits native deep-link copy when not provided', () => {
    const content = buildShareInvitationEmailContent({
      fromName: 'Owner User',
      documentTitle: 'Plan',
      shareUrl: 'https://midlight.ai/s/abc123',
    });

    assert.ok(!content.html.includes('Open in the Midlight app'));
    assert.ok(!content.text.includes('Open in the Midlight app:'));
  });

  it('escapes untrusted html content', () => {
    const content = buildShareInvitationEmailContent({
      fromName: '<img src=x onerror=alert(1)>',
      documentTitle: '<script>alert("x")</script>',
      shareUrl: 'https://midlight.ai/s/abc123?x=<script>',
      nativeShareUrl: 'midlight://s/abc123?x=<script>',
    });

    assert.ok(!content.html.includes('<img src=x onerror=alert(1)>'));
    assert.ok(!content.html.includes('<script>alert("x")</script>'));
    assert.match(content.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(content.html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  });
});
