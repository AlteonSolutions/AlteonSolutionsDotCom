// Host-independent request handling: rate limit, validate, verify Turnstile,
// forward. The Azure Function and the local dev server are thin wrappers.

import { parseSubmission, validateSubmission, Submission } from './validate';
import { RateLimiter } from './rateLimit';

export const MAX_BODY_BYTES = 32 * 1024;
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const UPSTREAM_TIMEOUT_MS = 10_000;

// Rejected requests get the same 200 and body as accepted ones, so a bot
// cannot tell which check stopped it.
export const OK_BODY = JSON.stringify({ ok: true });
const ERROR_BODY = JSON.stringify({ ok: false });

export interface Config {
  flowUrl: string;
  flowSharedKey: string;
  turnstileEnabled: boolean;
  turnstileSecret: string;
  rateLimitPerHour: number;
  siteverifyUrl: string;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const limit = Number.parseInt(env.RATE_LIMIT_PER_HOUR ?? '5', 10);
  return {
    flowUrl: env.FLOW_URL ?? '',
    flowSharedKey: env.FLOW_SHARED_KEY ?? '',
    turnstileEnabled: (env.TURNSTILE_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    turnstileSecret: env.TURNSTILE_SECRET_KEY ?? '',
    rateLimitPerHour: Number.isFinite(limit) && limit >= 0 ? limit : 5,
    // Only overridden by the local end-to-end test, which runs a mock Cloudflare.
    siteverifyUrl: env.TURNSTILE_SITEVERIFY_URL || SITEVERIFY_URL,
  };
}

export interface LogEntry {
  event: 'rejected' | 'forwarded' | 'error';
  reason: string;
  ip: string;
  emailDomain?: string;
}

export interface Deps {
  fetch: typeof fetch;
  log: (entry: LogEntry) => void;
  limiter: RateLimiter;
}

export interface Result {
  status: number;
  body: string;
}

/** First address in X-Forwarded-For, without a port ("1.2.3.4:5678", "[::1]:80"). */
export function clientIp(forwardedFor: string | null | undefined, fallback = ''): string {
  const first = (forwardedFor ?? '').split(',')[0].trim();
  if (!first) return fallback;
  const bracketed = first.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  const v4 = first.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/);
  return v4 ? v4[1] : first;
}

const emailDomain = (email: string) => email.trim().toLowerCase().split('@').pop() || '';

async function verifyTurnstile(token: string, ip: string, cfg: Config, deps: Deps): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  const form = new URLSearchParams({ secret: cfg.turnstileSecret, response: token });
  if (ip) form.set('remoteip', ip);
  const res = await deps.fetch(cfg.siteverifyUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

function forwardBody(s: Submission): string {
  // Same shape the flow has always received from the page.
  return JSON.stringify({ name: s.name, email: s.email, company: s.company, message: s.message });
}

export async function handleContact(bodyText: string, ip: string, cfg: Config, deps: Deps): Promise<Result> {
  const reject = (reason: string, s?: Submission): Result => {
    deps.log({ event: 'rejected', reason, ip, emailDomain: s ? emailDomain(s.email) : undefined });
    return { status: 200, body: OK_BODY };
  };
  const fail = (reason: string): Result => {
    deps.log({ event: 'error', reason, ip });
    return { status: 502, body: ERROR_BODY };
  };

  if (!cfg.flowUrl || !cfg.flowSharedKey || (cfg.turnstileEnabled && !cfg.turnstileSecret)) {
    deps.log({ event: 'error', reason: 'missing-config', ip });
    return { status: 500, body: ERROR_BODY };
  }

  if (cfg.rateLimitPerHour > 0 && !deps.limiter.allow(ip || 'unknown')) return reject('rate-limited');
  if (Buffer.byteLength(bodyText) > MAX_BODY_BYTES) return reject('too-large');

  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return reject('bad-json');
  }
  const s = parseSubmission(raw);

  const reason = validateSubmission(s);
  if (reason) return reject(reason, s);

  if (cfg.turnstileEnabled) {
    let passed: boolean;
    try {
      passed = await verifyTurnstile(s.turnstileToken, ip, cfg, deps);
    } catch {
      // Cloudflare unreachable: surface the normal error so a real person can retry.
      return fail('turnstile-unreachable');
    }
    if (!passed) return reject('turnstile', s);
  }

  try {
    const res = await deps.fetch(cfg.flowUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-alteon-key': cfg.flowSharedKey },
      body: forwardBody(s),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return fail('flow-status-' + res.status);
  } catch {
    return fail('flow-unreachable');
  }
  deps.log({ event: 'forwarded', reason: 'ok', ip, emailDomain: emailDomain(s.email) });
  return { status: 200, body: OK_BODY };
}
