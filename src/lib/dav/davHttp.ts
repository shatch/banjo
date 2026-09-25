/**
 * The small slice of WebDAV HTTP that the CalDAV calendar and the CardDAV
 * contacts sync need: an authenticated request, and a parser for the 207
 * Multi-Status XML that PROPFIND and REPORT answer with. No app config
 * here, so scripts can use it before Banjo's env is complete.
 */

import { XMLParser } from 'fast-xml-parser';

// Bounds one request. The tool-level TOOL_TIMEOUT_MS already stops a live
// call from waiting on the calendar; this stops the request itself from
// hanging around afterwards.
const REQUEST_TIMEOUT_MS = 10_000;

export interface DavCredentials {
  username: string;
  password: string;
}

export class DavHttpError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
  ) {
    // No response body in the message: it can quote calendar content.
    super(`DAV ${method} ${url} failed with HTTP ${status}`);
    this.name = 'DavHttpError';
  }
}

export interface DavRequest {
  method: string;
  url: string;
  credentials: DavCredentials;
  headers?: Record<string, string>;
  body?: string;
  /** Statuses to hand back rather than throw on, beyond 2xx (e.g. 404, 412). */
  allowStatuses?: number[];
}

export async function davRequest({ method, url, credentials, headers, body, allowStatuses = [] }: DavRequest): Promise<Response> {
  const auth = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Basic ${auth}`, ...headers },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok && !allowStatuses.includes(response.status)) {
    // Drain the body so the connection can be reused.
    await response.body?.cancel();
    throw new DavHttpError(method, url, response.status);
  }
  return response;
}

export interface DavPropstat {
  status: string; // e.g. "HTTP/1.1 200 OK"
  prop: Record<string, unknown>;
}

export interface DavResponse {
  href: string;
  /** Present when the server reports a status for the whole resource (e.g. 404, 507). */
  status?: string;
  propstats: DavPropstat[];
}

const parser = new XMLParser({
  // Servers pick their own namespace prefixes (d:, D:, none) — match on local names.
  removeNSPrefix: true,
  // Keep every value a string: calendar data and hrefs must never be number-coerced.
  parseTagValue: false,
  // Needed for <c:comp name="VEVENT"/> in supported-calendar-component-set.
  ignoreAttributes: false,
  // Decode numeric character references. Servers commonly send the CR of
  // each iCalendar/vCard CRLF as "&#13;", which the parser otherwise leaves
  // in place — every line would then end in "&#13;", no "BEGIN:VEVENT"
  // would match, and a busy calendar would read as entirely free.
  htmlEntities: true,
  parseAttributeValue: false,
  isArray: (name) => name === 'response' || name === 'propstat' || name === 'href',
});

/** Parses a 207 Multi-Status body. */
export function parseMultistatus(xml: string): DavResponse[] {
  return parseMultistatusWithToken(xml).responses;
}

/** Parses a 207 Multi-Status body, including the top-level sync-token a sync-collection REPORT (RFC 6578) returns. */
export function parseMultistatusWithToken(xml: string): { responses: DavResponse[]; syncToken: string | undefined } {
  const doc = parser.parse(xml) as { multistatus?: { response?: Array<Record<string, unknown>>; 'sync-token'?: unknown } };
  return { responses: parseResponses(doc.multistatus?.response ?? []), syncToken: textOf(doc.multistatus?.['sync-token']) };
}

function parseResponses(responses: Array<Record<string, unknown>>): DavResponse[] {
  return responses.map((r) => ({
    href: textOf((r.href as unknown[] | undefined)?.[0]) ?? '',
    status: textOf(r.status),
    propstats: ((r.propstat as Array<Record<string, unknown>> | undefined) ?? []).map((ps) => ({
      status: textOf(ps.status) ?? '',
      prop: (ps.prop as Record<string, unknown> | undefined) ?? {},
    })),
  }));
}

/** Text content of a parsed element, whether it parsed as a bare string or an object with attributes. */
export function textOf(node: unknown): string | undefined {
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object' && '#text' in node) return String((node as { '#text': unknown })['#text']);
  return undefined;
}

export function isOkStatus(status: string | undefined): boolean {
  return !!status && /\s2\d\d(\s|$)/.test(status);
}

/** The props from a response's successful propstat(s), merged. */
export function okProps(response: DavResponse): Record<string, unknown> {
  return Object.assign({}, ...response.propstats.filter((ps) => isOkStatus(ps.status)).map((ps) => ps.prop));
}
