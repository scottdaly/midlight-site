/**
 * Email Service
 *
 * Handles sending transactional emails via Resend.
 * Falls back to console logging in development if no API key is set.
 */

import { logger } from '../utils/logger.js';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Midlight <noreply@midlight.ai>';
const WEB_REDIRECT_BASE = process.env.WEB_REDIRECT_BASE || 'http://localhost:5173';

/**
 * Escape HTML special characters to prevent injection in email templates.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Send an email via Resend API
 * @param {object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML body
 * @param {string} [options.text] - Plain text body (optional)
 */
async function sendEmail({ to, subject, html, text }) {
  // In development without API key, just log the email
  if (!RESEND_API_KEY) {
    logger.info({ to, subject }, '[Email] Would send email (no RESEND_API_KEY set):');
    logger.info({ html }, '[Email] HTML content:');
    return { success: true, id: 'dev-mode' };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to],
        subject,
        html,
        text
      })
    });

    if (!response.ok) {
      const error = await response.json();
      logger.error({ error, to, subject }, '[Email] Failed to send email');
      throw new Error(error.message || 'Failed to send email');
    }

    const result = await response.json();
    logger.info({ id: result.id, to, subject }, '[Email] Email sent successfully');
    return { success: true, id: result.id };
  } catch (error) {
    logger.error({ error: error.message, to, subject }, '[Email] Error sending email');
    throw error;
  }
}

/**
 * Send password reset email
 * @param {string} email - Recipient email
 * @param {string} token - Reset token
 * @param {string} [displayName] - User's display name (optional)
 */
export async function sendPasswordResetEmail(email, token, displayName) {
  const resetUrl = `${WEB_REDIRECT_BASE}/reset-password?token=${token}`;
  const greeting = displayName ? `Hi ${displayName}` : 'Hi';

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Reset Your Password</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
          <tr>
            <td align="center">
              <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 500px; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
                <tr>
                  <td style="padding: 40px;">
                    <h1 style="margin: 0 0 24px 0; font-size: 24px; font-weight: 600; color: #111111;">Reset Your Password</h1>
                    <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #333333;">
                      ${greeting},
                    </p>
                    <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.6; color: #333333;">
                      We received a request to reset your password for your Midlight account. Click the button below to create a new password.
                    </p>
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td align="center" style="padding: 8px 0 32px 0;">
                          <a href="${resetUrl}" style="display: inline-block; padding: 14px 32px; background-color: #111111; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 500;">
                            Reset Password
                          </a>
                        </td>
                      </tr>
                    </table>
                    <p style="margin: 0 0 8px 0; font-size: 14px; line-height: 1.6; color: #666666;">
                      This link will expire in 1 hour.
                    </p>
                    <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #666666;">
                      If you didn't request a password reset, you can safely ignore this email.
                    </p>
                    <hr style="border: none; border-top: 1px solid #eeeeee; margin: 24px 0;">
                    <p style="margin: 0; font-size: 12px; color: #999999;">
                      If the button doesn't work, copy and paste this link into your browser:
                    </p>
                    <p style="margin: 8px 0 0 0; font-size: 12px; color: #999999; word-break: break-all;">
                      ${resetUrl}
                    </p>
                  </td>
                </tr>
              </table>
              <p style="margin: 24px 0 0 0; font-size: 12px; color: #999999;">
                Midlight - AI-Native Document Editor
              </p>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  const text = `
${greeting},

We received a request to reset your password for your Midlight account.

Click here to reset your password: ${resetUrl}

This link will expire in 1 hour.

If you didn't request a password reset, you can safely ignore this email.

---
Midlight - AI-Native Document Editor
  `.trim();

  return sendEmail({
    to: email,
    subject: 'Reset Your Password - Midlight',
    html,
    text
  });
}

/**
 * Send email verification email
 * @param {string} email - Recipient email
 * @param {string} token - Verification token
 * @param {string} [displayName] - User's display name (optional)
 */
export async function sendEmailVerificationEmail(email, token, displayName) {
  const verifyUrl = `${WEB_REDIRECT_BASE}/verify-email?token=${token}`;
  const greeting = displayName ? `Hi ${displayName}` : 'Hi';

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Verify Your Email</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
          <tr>
            <td align="center">
              <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 500px; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
                <tr>
                  <td style="padding: 40px;">
                    <h1 style="margin: 0 0 24px 0; font-size: 24px; font-weight: 600; color: #111111;">Verify Your Email</h1>
                    <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #333333;">
                      ${greeting},
                    </p>
                    <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.6; color: #333333;">
                      Thanks for signing up for Midlight! Please verify your email address by clicking the button below.
                    </p>
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td align="center" style="padding: 8px 0 32px 0;">
                          <a href="${verifyUrl}" style="display: inline-block; padding: 14px 32px; background-color: #111111; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 500;">
                            Verify Email
                          </a>
                        </td>
                      </tr>
                    </table>
                    <p style="margin: 0 0 8px 0; font-size: 14px; line-height: 1.6; color: #666666;">
                      This link will expire in 24 hours.
                    </p>
                    <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #666666;">
                      If you didn't create a Midlight account, you can safely ignore this email.
                    </p>
                    <hr style="border: none; border-top: 1px solid #eeeeee; margin: 24px 0;">
                    <p style="margin: 0; font-size: 12px; color: #999999;">
                      If the button doesn't work, copy and paste this link into your browser:
                    </p>
                    <p style="margin: 8px 0 0 0; font-size: 12px; color: #999999; word-break: break-all;">
                      ${verifyUrl}
                    </p>
                  </td>
                </tr>
              </table>
              <p style="margin: 24px 0 0 0; font-size: 12px; color: #999999;">
                Midlight - AI-Native Document Editor
              </p>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  const text = `
${greeting},

Thanks for signing up for Midlight! Please verify your email address by clicking the link below:

${verifyUrl}

This link will expire in 24 hours.

If you didn't create a Midlight account, you can safely ignore this email.

---
Midlight - AI-Native Document Editor
  `.trim();

  return sendEmail({
    to: email,
    subject: 'Verify Your Email - Midlight',
    html,
    text
  });
}

/**
 * Send share invitation email
 * @param {string} fromName - Sharer's display name or email
 * @param {string} documentTitle - Document title
 * @param {string} shareUrl - URL to access the shared document
 * @param {string|null} nativeShareUrl - Optional native-app deep link
 */
export function buildShareInvitationEmailContent({ fromName, documentTitle, shareUrl, nativeShareUrl = null }) {
  const normalizedFromName = (fromName || 'Someone').trim() || 'Someone';
  const normalizedDocumentTitle = (documentTitle || 'Untitled').trim() || 'Untitled';
  const normalizedShareUrl = (shareUrl || '').trim();
  const normalizedNativeShareUrl = nativeShareUrl ? nativeShareUrl.trim() : null;

  const safeFromName = escapeHtml(normalizedFromName);
  const safeDocumentTitle = escapeHtml(normalizedDocumentTitle);
  const safeShareUrl = escapeHtml(normalizedShareUrl);
  const safeNativeShareUrl = normalizedNativeShareUrl ? escapeHtml(normalizedNativeShareUrl) : null;

  const subject = `${normalizedFromName} shared "${normalizedDocumentTitle}" with you`;
  const nativeHtml = safeNativeShareUrl
    ? `
                    <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #666666;">
                      Prefer mobile? <a href="${safeNativeShareUrl}" style="color: #111111; text-decoration: underline;">Open in the Midlight app</a>
                    </p>
`
    : '';
  const nativeText = normalizedNativeShareUrl
    ? `
Open in the Midlight app: ${normalizedNativeShareUrl}
`
    : '';

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Document Shared With You</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
          <tr>
            <td align="center">
              <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 500px; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
                <tr>
                  <td style="padding: 40px;">
                    <h1 style="margin: 0 0 24px 0; font-size: 24px; font-weight: 600; color: #111111;">Document Shared With You</h1>
                    <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #333333;">
                      Hi,
                    </p>
                    <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.6; color: #333333;">
                      <strong>${safeFromName}</strong> shared "${safeDocumentTitle}" with you on Midlight.
                    </p>
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td align="center" style="padding: 8px 0 32px 0;">
                          <a href="${safeShareUrl}" style="display: inline-block; padding: 14px 32px; background-color: #111111; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 500;">
                            Open Document
                          </a>
                        </td>
                      </tr>
                    </table>
${nativeHtml}
                    <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #666666;">
                      If you don't have a Midlight account yet, you'll be able to sign up and access the document.
                    </p>
                    <hr style="border: none; border-top: 1px solid #eeeeee; margin: 24px 0;">
                    <p style="margin: 0; font-size: 12px; color: #999999;">
                      If the button doesn't work, copy and paste this link into your browser:
                    </p>
                    <p style="margin: 8px 0 0 0; font-size: 12px; color: #999999; word-break: break-all;">
                      ${safeShareUrl}
                    </p>
                  </td>
                </tr>
              </table>
              <p style="margin: 24px 0 0 0; font-size: 12px; color: #999999;">
                Midlight - AI-Native Document Editor
              </p>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;

  const text = `
Hi,

${normalizedFromName} shared "${normalizedDocumentTitle}" with you on Midlight.

Open the document: ${normalizedShareUrl}
${nativeText}

If you don't have a Midlight account yet, you'll be able to sign up and access the document.

---
Midlight - AI-Native Document Editor
  `.trim();

  return {
    subject,
    html,
    text,
  };
}

/**
 * Send share invitation email
 * @param {string} toEmail - Recipient email
 * @param {string} fromName - Sharer's display name or email
 * @param {string} documentTitle - Document title
 * @param {string} shareUrl - URL to access the shared document
 * @param {string|null} nativeShareUrl - Optional native-app deep link
 */
export async function sendShareInvitationEmail(toEmail, fromName, documentTitle, shareUrl, nativeShareUrl = null) {
  const content = buildShareInvitationEmailContent({ fromName, documentTitle, shareUrl, nativeShareUrl });
  return sendEmail({
    to: toEmail,
    subject: content.subject,
    html: content.html,
    text: content.text
  });
}

/**
 * Send comment notification email
 * @param {string} toEmail - Recipient email
 * @param {string} commenterName - Commenter's display name
 * @param {string} documentTitle - Document title
 * @param {string} commentPreview - Preview of the comment text
 * @param {string} url - URL to the document
 */
export async function sendCommentNotificationEmail(toEmail, commenterName, documentTitle, commentPreview, url) {
  const rawPreview = commentPreview.length > 200 ? commentPreview.slice(0, 200) + '...' : commentPreview;
  const safeName = escapeHtml(commenterName);
  const safeTitle = escapeHtml(documentTitle);
  const safePreview = escapeHtml(rawPreview);

  const html = `
    <!DOCTYPE html>
    <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
          <tr><td align="center">
            <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 500px; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
              <tr><td style="padding: 40px;">
                <h1 style="margin: 0 0 24px 0; font-size: 24px; font-weight: 600; color: #111111;">New Comment</h1>
                <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #333333;">
                  <strong>${safeName}</strong> commented on "${safeTitle}":
                </p>
                <div style="margin: 0 0 24px 0; padding: 12px 16px; background: #f5f5f5; border-radius: 6px; border-left: 3px solid #3b82f6;">
                  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #555555; font-style: italic;">"${safePreview}"</p>
                </div>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr><td align="center" style="padding: 8px 0 24px 0;">
                    <a href="${url}" style="display: inline-block; padding: 14px 32px; background-color: #111111; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 500;">View Comment</a>
                  </td></tr>
                </table>
                <hr style="border: none; border-top: 1px solid #eeeeee; margin: 24px 0;">
                <p style="margin: 0; font-size: 12px; color: #999999;">You can manage notification preferences in your Midlight settings.</p>
              </td></tr>
            </table>
            <p style="margin: 24px 0 0 0; font-size: 12px; color: #999999;">Midlight - AI-Native Document Editor</p>
          </td></tr>
        </table>
      </body>
    </html>
  `;

  const text = `${commenterName} commented on "${documentTitle}":\n\n"${rawPreview}"\n\nView: ${url}\n\n---\nMidlight - AI-Native Document Editor`;

  return sendEmail({ to: toEmail, subject: `${commenterName} commented on "${documentTitle}"`, html, text });
}

/**
 * Send mention notification email
 * @param {string} toEmail - Recipient email
 * @param {string} mentionerName - Person who mentioned you
 * @param {string} documentTitle - Document title
 * @param {string} url - URL to the document
 */
export async function sendMentionNotificationEmail(toEmail, mentionerName, documentTitle, url) {
  const safeName = escapeHtml(mentionerName);
  const safeTitle = escapeHtml(documentTitle);

  const html = `
    <!DOCTYPE html>
    <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
          <tr><td align="center">
            <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 500px; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
              <tr><td style="padding: 40px;">
                <h1 style="margin: 0 0 24px 0; font-size: 24px; font-weight: 600; color: #111111;">You Were Mentioned</h1>
                <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.6; color: #333333;">
                  <strong>${safeName}</strong> mentioned you in "${safeTitle}".
                </p>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr><td align="center" style="padding: 8px 0 24px 0;">
                    <a href="${url}" style="display: inline-block; padding: 14px 32px; background-color: #111111; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 500;">View Document</a>
                  </td></tr>
                </table>
                <hr style="border: none; border-top: 1px solid #eeeeee; margin: 24px 0;">
                <p style="margin: 0; font-size: 12px; color: #999999;">You can manage notification preferences in your Midlight settings.</p>
              </td></tr>
            </table>
            <p style="margin: 24px 0 0 0; font-size: 12px; color: #999999;">Midlight - AI-Native Document Editor</p>
          </td></tr>
        </table>
      </body>
    </html>
  `;

  const text = `${mentionerName} mentioned you in "${documentTitle}".\n\nView: ${url}\n\n---\nMidlight - AI-Native Document Editor`;

  return sendEmail({ to: toEmail, subject: `${mentionerName} mentioned you in "${documentTitle}"`, html, text });
}
