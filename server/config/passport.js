import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { findOrCreateOAuthUser } from '../services/authService.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/api/auth/google/callback';

export function configurePassport() {
  // Google OAuth Strategy
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
      clientID: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackURL: GOOGLE_CALLBACK_URL,
      scope: ['profile', 'email']
    }, (accessToken, refreshToken, profile, done) => {
      try {
        // Only accept verified emails to prevent account takeover via unverified Google emails
        const verifiedEmail = profile.emails?.find(e => e.verified === true || e.verified === 'true');
        if (!verifiedEmail?.value) {
          return done(null, false, { message: 'Google account email must be verified' });
        }
        const email = verifiedEmail.value;

        const result = findOrCreateOAuthUser({
          provider: 'google',
          providerUserId: profile.id,
          email,
          displayName: profile.displayName,
          avatarUrl: profile.photos?.[0]?.value,
          providerData: {
            id: profile.id,
            displayName: profile.displayName,
            emails: profile.emails,
            photos: profile.photos
          }
        });

        // If account exists with password, don't auto-link
        if (result.needsLinking) {
          return done(null, false, { message: 'account_exists', email: result.email });
        }

        return done(null, result);
      } catch (error) {
        return done(error);
      }
    }));
    console.log('Google OAuth strategy configured');
  } else {
    console.warn('Google OAuth not configured - missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
  }

  // Serialize/deserialize for session support (optional, we primarily use JWT)
  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser((id, done) => {
    // We don't need session-based auth since we use JWT
    done(null, { id });
  });
}

export default passport;
