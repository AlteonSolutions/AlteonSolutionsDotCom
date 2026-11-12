import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, handleContact, loadConfig, LogEntry, OK_BODY, SITEVERIFY_URL } from '../src/handler';
import { RateLimiter } from '../src/rateLimit';

const FLOW = 'https://flow.invalid/invoke';
const cfg = loadConfig({ FLOW_URL: FLOW, FLOW_SHARED_KEY: 'shared', TURNSTILE_SECRET_KEY: 'ts-secret' });

const good = {
  name: 'Duke Bonaventura',
  email: 'duke@dukenet.example-mail.com',
  company: 'DukeNet',
  message: 'Duke test message',
  website: '',
  elapsedMs: 8000,
  turnstileToken: 'good-token',
};

interface Call { url: string; init: RequestInit }

function harness(opts: { turnstileOk?: boolean; flowStatus?: number; limit?: number } = {}) {
  const calls: Call[] = [];
  const logs: LogEntry[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url) === SITEVERIFY_URL) {
      return new Response(JSON.stringify({ success: opts.turnstileOk ?? true }));
    }
    return new Response('', { status: opts.flowStatus ?? 202 });
  }) as typeof fetch;
  const deps = { fetch: fakeFetch, log: (e: LogEntry) => logs.push(e), limiter: new RateLimiter(opts.limit ?? 5) };
  return { calls, logs, deps };
}

const flowCalls = (calls: Call[]) => calls.filter((c) => c.url === FLOW);

test('clean submission is verified and forwarded with the old shape and the shared key', async () => {
  const h = harness();
  const r = await handleContact(JSON.stringify(good), '203.0.113.9', cfg, h.deps);
  assert.deepEqual(r, { status: 200, body: OK_BODY });
  const verify = h.calls.find((c) => c.url === SITEVERIFY_URL)!;
  const form = verify.init.body as URLSearchParams;
  assert.equal(form.get('secret'), 'ts-secret');
  assert.equal(form.get('response'), 'good-token');
  assert.equal(form.get('remoteip'), '203.0.113.9');
  const [flow] = flowCalls(h.calls);
  assert.deepEqual(JSON.parse(flow.init.body as string), {
    name: good.name, email: good.email, company: good.company, message: good.message,
  });
  assert.equal((flow.init.headers as Record<string, string>)['x-alteon-key'], 'shared');
  assert.equal(h.logs[0].event, 'forwarded');
});

test('junk gets the same 200 body, is never forwarded, and is logged with a reason only', async () => {
  const h = harness();
  const junk = { ...good, name: 'FPPJCvVEeBHLvgWjqZ', company: 'Aaobdysmav LLC', email: 'ed.e.v.u.q.ab.741@gmail.com', message: 'RNswBAnmgOfNgfqAKcGCWA' };
  const r = await handleContact(JSON.stringify(junk), '198.51.100.1', cfg, h.deps);
  assert.deepEqual(r, { status: 200, body: OK_BODY });
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.logs, [{ event: 'rejected', reason: 'email-gmail-dots', ip: '198.51.100.1', emailDomain: 'gmail.com' }]);
  assert.ok(!JSON.stringify(h.logs).includes('RNswBAnmgOfNgfqAKcGCWA'), 'message body must not be logged');
});

test('direct POST without the new fields (old bot path) is dropped', async () => {
  const h = harness();
  const r = await handleContact(JSON.stringify({ name: '', email: 'victim-ukv3x4og@example.com', company: '', message: '' }), '1.1.1.1', cfg, h.deps);
  assert.equal(r.status, 200);
  assert.equal(flowCalls(h.calls).length, 0);
  assert.equal(h.logs[0].reason, 'too-fast');
});

test('bad Turnstile token is dropped silently', async () => {
  const h = harness({ turnstileOk: false });
  const r = await handleContact(JSON.stringify(good), '1.1.1.1', cfg, h.deps);
  assert.deepEqual(r, { status: 200, body: OK_BODY });
  assert.equal(flowCalls(h.calls).length, 0);
  assert.equal(h.logs[0].reason, 'turnstile');
});

test('missing Turnstile token is dropped without calling siteverify', async () => {
  const h = harness();
  await handleContact(JSON.stringify({ ...good, turnstileToken: '' }), '1.1.1.1', cfg, h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.logs[0].reason, 'turnstile');
});

test('Turnstile can be switched off by config; other layers still apply', async () => {
  const off = loadConfig({ FLOW_URL: FLOW, FLOW_SHARED_KEY: 'shared', TURNSTILE_ENABLED: 'false' });
  const h = harness();
  const ok = await handleContact(JSON.stringify({ ...good, turnstileToken: '' }), '1.1.1.1', off, h.deps);
  assert.equal(ok.status, 200);
  assert.equal(h.calls.filter((c) => c.url === SITEVERIFY_URL).length, 0);
  assert.equal(flowCalls(h.calls).length, 1);
  await handleContact(JSON.stringify({ ...good, website: 'x' }), '1.1.1.1', off, h.deps);
  assert.equal(flowCalls(h.calls).length, 1);
});

test('per-IP rate limit drops the 6th request in an hour', async () => {
  const h = harness({ limit: 5 });
  for (let i = 0; i < 5; i++) await handleContact(JSON.stringify(good), '9.9.9.9', cfg, h.deps);
  const r = await handleContact(JSON.stringify(good), '9.9.9.9', cfg, h.deps);
  assert.equal(r.status, 200);
  assert.equal(flowCalls(h.calls).length, 5);
  assert.equal(h.logs.at(-1)!.reason, 'rate-limited');
  await handleContact(JSON.stringify(good), '9.9.9.10', cfg, h.deps);
  assert.equal(flowCalls(h.calls).length, 6, 'other IPs unaffected');
});

test('flow failure surfaces as an error so the page shows its error message', async () => {
  const h = harness({ flowStatus: 500 });
  const r = await handleContact(JSON.stringify(good), '1.1.1.1', cfg, h.deps);
  assert.equal(r.status, 502);
  assert.equal(h.logs[0].reason, 'flow-status-500');
});

test('missing secrets fail closed with a 500', async () => {
  const h = harness();
  const r = await handleContact(JSON.stringify(good), '1.1.1.1', loadConfig({ FLOW_URL: FLOW }), h.deps);
  assert.equal(r.status, 500);
  assert.equal(h.calls.length, 0);
});

test('malformed and oversized bodies are dropped', async () => {
  const h = harness();
  assert.equal((await handleContact('{not json', '1.1.1.1', cfg, h.deps)).status, 200);
  assert.equal((await handleContact(JSON.stringify({ ...good, message: 'x'.repeat(40_000) }), '1.1.1.2', cfg, h.deps)).status, 200);
  assert.deepEqual(h.logs.map((l) => l.reason), ['bad-json', 'too-large']);
  assert.equal(h.calls.length, 0);
});

test('clientIp strips ports and takes the first forwarded address', () => {
  assert.equal(clientIp('203.0.113.9:51234'), '203.0.113.9');
  assert.equal(clientIp('203.0.113.9, 10.0.0.1'), '203.0.113.9');
  assert.equal(clientIp('[2001:db8::1]:443'), '2001:db8::1');
  assert.equal(clientIp('2001:db8::1'), '2001:db8::1');
  assert.equal(clientIp(undefined, 'fallback'), 'fallback');
});
