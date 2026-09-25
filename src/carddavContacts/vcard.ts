/**
 * Just enough vCard (RFC 6350, and the vCard 3.0 that Apple and Fastmail
 * still write) to fill the local contacts cache: name, phone numbers, email,
 * relations, and group membership. No app config here — phone numbers stay
 * raw, and src/carddavContacts/sync.ts normalizes them.
 *
 * Group membership comes in two shapes, and both are read:
 * - CATEGORIES on the contact's own card (Nextcloud, Google exports);
 * - a separate group card (KIND:group, or Apple's X-ADDRESSBOOKSERVER-KIND:group)
 *   listing its members' UIDs (MEMBER / X-ADDRESSBOOKSERVER-MEMBER) — what
 *   iCloud and Fastmail write.
 */

export interface VCardProperty {
  /** Apple groups related lines with a prefix: "item1.TEL" and "item1.X-ABLABEL". */
  group?: string;
  name: string; // upper-cased
  params: Record<string, string[]>; // upper-cased keys; "TYPE=cell,voice;TYPE=pref" → TYPE: [cell, voice, pref]
  value: string; // raw, still escaped
}

export interface RawPhone {
  value: string;
  type?: string; // 'mobile' | 'home' | 'work' | a custom label — informational, like Google's
}

export interface ParsedCard {
  uid: string | undefined;
  kind: 'individual' | 'group';
  displayName: string | undefined;
  phones: RawPhone[];
  email: string | undefined;
  relationLabels: string[];
  categories: string[];
  /** For a group card: its members' UIDs. */
  memberUids: string[];
}

/** Unescapes a vCard TEXT value. */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Splits a TEXT list on unescaped commas (CATEGORIES:Family,Friends). */
function splitList(value: string): string[] {
  return value
    .split(/(?<!\\),/)
    .map((part) => unescapeText(part).trim())
    .filter(Boolean);
}

function parseLine(line: string): VCardProperty | undefined {
  const nameEnd = line.search(/[;:]/);
  if (nameEnd <= 0) return undefined;
  const fullName = line.slice(0, nameEnd);
  const dot = fullName.lastIndexOf('.');
  const group = dot === -1 ? undefined : fullName.slice(0, dot).toLowerCase();
  const name = (dot === -1 ? fullName : fullName.slice(dot + 1)).toUpperCase();
  const params: Record<string, string[]> = {};

  let i = nameEnd;
  while (line[i] === ';') {
    i++;
    // A param runs to the next unquoted ';' or ':'.
    let raw = '';
    let quoted = false;
    for (; i < line.length; i++) {
      const c = line[i]!;
      if (c === '"') quoted = !quoted;
      else if (!quoted && (c === ';' || c === ':')) break;
      raw += c;
    }
    const eq = raw.indexOf('=');
    // vCard 3.0 allows a bare type ("TEL;CELL:..."), which means TYPE=CELL.
    const key = eq === -1 ? 'TYPE' : raw.slice(0, eq).toUpperCase();
    const values = (eq === -1 ? raw : raw.slice(eq + 1))
      .split(',')
      .map((v) => v.replace(/^"|"$/g, ''))
      .filter(Boolean);
    params[key] = [...(params[key] ?? []), ...values];
  }

  if (line[i] !== ':') return undefined;
  return { group, name, params, value: line.slice(i + 1) };
}

/** Parses every VCARD in `text` into its properties. */
export function parseVCards(text: string): VCardProperty[][] {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const cards: VCardProperty[][] = [];
  let current: VCardProperty[] | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN' && prop.value.toUpperCase() === 'VCARD') current = [];
    else if (prop.name === 'END' && prop.value.toUpperCase() === 'VCARD') {
      if (current) cards.push(current);
      current = undefined;
    } else current?.push(prop);
  }
  return cards;
}

/** Apple writes built-in labels as "_$!<Spouse>!$_"; custom labels are plain text. */
function cleanLabel(label: string): string {
  const builtIn = /^_\$!<(.+)>!\$_$/.exec(label);
  return (builtIn ? builtIn[1]! : label).trim().toLowerCase();
}

function labelFor(props: VCardProperty[], group: string | undefined): string | undefined {
  if (!group) return undefined;
  const label = props.find((p) => p.group === group && p.name === 'X-ABLABEL');
  return label ? cleanLabel(unescapeText(label.value)) : undefined;
}

const PHONE_TYPES: Record<string, string> = { cell: 'mobile', mobile: 'mobile', iphone: 'mobile', home: 'home', work: 'work', main: 'main' };

function phoneType(props: VCardProperty[], tel: VCardProperty): string | undefined {
  const label = labelFor(props, tel.group);
  if (label) return PHONE_TYPES[label] ?? label;
  for (const type of tel.params.TYPE ?? []) {
    const mapped = PHONE_TYPES[type.toLowerCase()];
    if (mapped) return mapped;
  }
  return undefined;
}

function stripUrn(value: string): string {
  return value.trim().replace(/^urn:uuid:/i, '');
}

/** The fields Banjo uses from one card's properties. */
export function readCard(props: VCardProperty[]): ParsedCard {
  const get = (name: string) => props.find((p) => p.name === name);

  const kindValue = (get('KIND') ?? get('X-ADDRESSBOOKSERVER-KIND'))?.value.trim().toLowerCase();

  let displayName = get('FN') ? unescapeText(get('FN')!.value).trim() : '';
  if (!displayName && get('N')) {
    // N is Family;Given;Additional;Prefix;Suffix.
    const [family = '', given = ''] = get('N')!.value.split(/(?<!\\);/).map(unescapeText);
    displayName = [given, family].filter(Boolean).join(' ').trim();
  }
  if (!displayName && get('ORG')) displayName = unescapeText(get('ORG')!.value.split(/(?<!\\);/)[0] ?? '').trim();

  const phones = props
    .filter((p) => p.name === 'TEL')
    .map((tel): RawPhone => {
      // vCard 4 may write "tel:+1-555-..." as a URI.
      const value = unescapeText(tel.value).replace(/^tel:/i, '').trim();
      const type = phoneType(props, tel);
      return type ? { value, type } : { value };
    })
    .filter((p) => p.value);

  const relationLabels: string[] = [];
  for (const p of props) {
    if (p.name === 'RELATED') relationLabels.push(...(p.params.TYPE ?? []).map((t) => t.toLowerCase()));
    if (p.name === 'X-ABRELATEDNAMES') {
      const label = labelFor(props, p.group);
      if (label) relationLabels.push(label);
    }
  }

  return {
    uid: get('UID') ? stripUrn(unescapeText(get('UID')!.value)) : undefined,
    kind: kindValue === 'group' ? 'group' : 'individual',
    displayName: displayName || undefined,
    phones,
    email: get('EMAIL') ? unescapeText(get('EMAIL')!.value).trim() : undefined,
    relationLabels: [...new Set(relationLabels)],
    categories: props.filter((p) => p.name === 'CATEGORIES').flatMap((p) => splitList(p.value)),
    memberUids: props.filter((p) => p.name === 'MEMBER' || p.name === 'X-ADDRESSBOOKSERVER-MEMBER').map((p) => stripUrn(p.value)),
  };
}

/** Parses the single card a CardDAV resource holds, or undefined if there isn't one. */
export function parseCard(text: string): ParsedCard | undefined {
  const [first] = parseVCards(text);
  return first ? readCard(first) : undefined;
}
