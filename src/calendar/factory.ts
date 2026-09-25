import { config } from '../config/index.js';
import { CaldavCalendarProvider } from './caldavCalendarProvider.js';
import { GoogleCalendarProvider } from './googleCalendarProvider.js';
import type { CalendarProvider } from './types.js';

/**
 * Picks the calendar backend from CALENDAR_PROVIDER. Application code should
 * program against CalendarProvider and get an instance from here, never
 * construct a provider class directly — same pattern as voice/factory.ts.
 */
export function createCalendarProvider(): CalendarProvider {
  switch (config.CALENDAR_PROVIDER) {
    case 'google':
      return new GoogleCalendarProvider();
    case 'caldav':
      return new CaldavCalendarProvider();
    default: {
      // Unreachable: CALENDAR_PROVIDER is a Zod enum. Guards a future enum
      // value that forgets to add its provider here.
      const exhaustiveCheck: never = config.CALENDAR_PROVIDER;
      throw new Error(`Unrecognized CALENDAR_PROVIDER: ${String(exhaustiveCheck)}`);
    }
  }
}
