import { google, type people_v1 } from 'googleapis';
import { config } from '../config/index.js';

/**
 * Thin googleapis People API client for the principal's own Google Contacts,
 * same OAuth2 user-consent construction as GoogleCalendarProvider
 * (src/calendar/googleCalendarProvider.ts), reused here with a broader
 * granted scope (contacts.readonly, in addition to calendar) on the same
 * refresh token. See docs/RUNBOOKS.md's Google OAuth consent entry (added in
 * Task 9 of this plan) for how to mint a token carrying both scopes.
 */
export function createPeopleClient(): people_v1.People {
  const oauth2Client = new google.auth.OAuth2(config.GOOGLE_OAUTH_CLIENT_ID, config.GOOGLE_OAUTH_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: config.GOOGLE_OAUTH_REFRESH_TOKEN });
  return google.people({ version: 'v1', auth: oauth2Client });
}
