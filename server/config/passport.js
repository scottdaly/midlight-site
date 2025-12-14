import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as GitHubStrategy } from 'passport-github2';
import { findOrCreateOAuthUser } from '../services/authService.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/api/auth/google/callback';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || 'http://localhost:3001/api/auth/github/callback';

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
        const email = profile.emails?.[0]?.value;
        if (!email) {
          return done(new Error('No email provided by Google'));
        }

        const user = findOrCreateOAuthUser({
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

        return done(null, user);
      } catch (error) {
        return done(error);
      }
    }));
    console.log('Google OAuth strategy configured');
  } else {
    console.warn('Google OAuth not configured - missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
  }

  // GitHub OAuth Strategy
  if (GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET) {
    passport.use(new GitHubStrategy({
      clientID: GITHUB_CLIENT_ID,
      clientSecret: GITHUB_CLIENT_SECRET,
      callbackURL: GITHUB_CALLBACK_URL,
      scope: ['user:email']
    }, (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        if (!email) {
          return done(new Error('No email provided by GitHub'));
        }

        const user = findOrCreateOAuthUser({
          provider: 'github',
          providerUserId: profile.id,
          email,
          displayName: profile.displayName || profile.username,
          avatarUrl: profile.photos?.[0]?.value,
          providerData: {
            id: profile.id,
            username: profile.username,
            displayName: profile.displayName,
            profileUrl: profile.profileUrl,
            emails: profile.emails,
            photos: profile.photos
          }
        });

        return done(null, user);
      } catch (error) {
        return done(error);
      }
    }));
    console.log('GitHub OAuth strategy configured');
  } else {
    console.warn('GitHub OAuth not configured - missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET');
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
