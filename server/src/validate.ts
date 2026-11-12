// Pure checks for a "Request a call" submission. No I/O here, so every rule is
// unit-tested against the junk the form has actually received.

export const MIN_ELAPSED_MS = 3000;
export const MAX_NAME_LENGTH = 100;

export interface Submission {
  name: string;
  email: string;
  company: string;
  message: string;
  website: string;
  elapsedMs: number | undefined;
  turnstileToken: string;
}

export type RejectReason =
  | 'honeypot'
  | 'too-fast'
  | 'name-blank'
  | 'name-too-long'
  | 'email-invalid'
  | 'email-example-domain'
  | 'email-test-local'
  | 'email-gmail-dots'
  | 'company-llc-and-gibberish-name'
  | 'name-gibberish'
  | 'message-gibberish';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Coerce an untrusted JSON body into a Submission without throwing. */
export function parseSubmission(body: unknown): Submission {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const elapsed = b.elapsedMs;
  return {
    name: str(b.name),
    email: str(b.email),
    company: str(b.company),
    message: str(b.message),
    website: str(b.website),
    elapsedMs: typeof elapsed === 'number' && Number.isFinite(elapsed) ? elapsed : undefined,
    turnstileToken: str(b.turnstileToken),
  };
}

// Joined words where every capital starts a lowercase run: "SharePointPowerAutomate".
const CLEAN_CAMEL_CASE = /^\p{Ll}*(?:\p{Lu}\p{Ll}+)+$/u;

/**
 * A single word of 12+ letters with 3+ lowercase-to-uppercase switches inside
 * it, e.g. "FPPJCvVEeBHLvgWjqZ" (4 switches). Clean CamelCase such as
 * "SharePointPowerAutomate" also has 3 switches, so it is exempt: the random
 * tokens always contain runs of capitals ("FPPJC", "HL").
 */
export function isGibberishToken(value: string): boolean {
  const v = value.trim();
  if (!/^\p{L}{12,}$/u.test(v)) return false;
  if (CLEAN_CAMEL_CASE.test(v)) return false;
  const switches = v.match(/\p{Ll}(?=\p{Lu})/gu);
  return (switches ? switches.length : 0) >= 3;
}

const EXAMPLE_DOMAINS = /(^|\.)example\.(com|net|org)$/;
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const LLC_COMPANY = /^[A-Z][a-z]{4,}\s+LLC$/;

function checkEmail(email: string): RejectReason | null {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1 || at === e.length - 1 || /\s/.test(e)) return 'email-invalid';
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (!domain.includes('.')) return 'email-invalid';
  if (EXAMPLE_DOMAINS.test(domain)) return 'email-example-domain';
  if (local.startsWith('test') || local.startsWith('victim')) return 'email-test-local';
  if (GMAIL_DOMAINS.has(domain) && (local.match(/\./g) || []).length >= 4) return 'email-gmail-dots';
  return null;
}

/**
 * Content and behaviour checks (everything except Turnstile, which needs a
 * network call). Returns the first reason to reject, or null if it looks real.
 */
export function validateSubmission(s: Submission): RejectReason | null {
  if (s.website.trim() !== '') return 'honeypot';
  if (s.elapsedMs === undefined || s.elapsedMs < MIN_ELAPSED_MS) return 'too-fast';

  const name = s.name.trim();
  if (name === '') return 'name-blank';
  if (name.length > MAX_NAME_LENGTH) return 'name-too-long';

  const emailReason = checkEmail(s.email);
  if (emailReason) return emailReason;

  const nameGibberish = isGibberishToken(name);
  if (nameGibberish && LLC_COMPANY.test(s.company.trim())) return 'company-llc-and-gibberish-name';
  if (nameGibberish) return 'name-gibberish';
  if (isGibberishToken(s.message)) return 'message-gibberish';
  return null;
}
