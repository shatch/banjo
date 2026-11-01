import { z } from 'zod';

export const MAX_PRONUNCIATION_CHARS = 60;

/**
 * How a contact's name is said, for when the spelling misleads the voice model.
 * A live call (2026-10-31) to a contact saved as "Gema" said it the way it's
 * spelled, though her notes said "pronounced Gemma": the name sits at the top
 * of the prompt and in the task, the notes further down. One short line, no
 * double quotes: it goes into every call's prompt, inside quotes.
 */
export const pronunciationSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PRONUNCIATION_CHARS)
  .regex(/^[^\r\n\u0085\u2028\u2029"]*$/, 'one line, with no double quotes');

export const PRONUNCIATION_DESCRIPTION =
  `How to say the contact's name when its spelling misleads, written the way it sounds, e.g. "Gemma" for a ` +
  `contact saved as "Gema", or "JEM-uh". One line, at most ${MAX_PRONUNCIATION_CHARS} characters. Every call to ` +
  `them is told to say the name this way. Only the owner's key can set it.`;

/** The prompt sentence for a contact with a pronunciation; '' without one. */
export function spokenNameRule(displayName: string, pronunciation: string | null | undefined): string {
  const said = pronunciation?.trim();
  if (!said) return '';
  return ` ${displayName} is said "${said}": every time you say their name, say it that way, never the way the spelling reads.`;
}
