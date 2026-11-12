#!/usr/bin/env node
// Local end-to-end check of the contact form against the real proxy code.
//
// Builds a test copy of index.html whose contactEndpoint points at a local
// proxy, serves it, and drives it in Chromium with a fake Turnstile widget,
// a mock siteverify endpoint and a mock Power Automate flow. Nothing leaves
// this machine.
//
//   (cd server && npm run build)
//   NODE_PATH=$(npm root -g) node tools/e2e-contact.mjs [screenshot-dir]

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] || mkdtempSync(join(tmpdir(), 'e2e-shots-'));
const PAGE = 18080, PROXY = 17071, MOCK = 17072;

// --- test copy of the page -------------------------------------------------
const { splitBundle, decodeTemplate, encodeTemplate } = await import('./bundle-template.mjs');
const page = readFileSync(join(root, 'index.html'), 'utf8');
const parts = splitBundle(page);
let tpl = decodeTemplate(parts.encoded);
const endpointLine = /contactEndpoint = '[^']*';/;
assert.match(tpl, endpointLine, 'contactEndpoint not found in template');
tpl = tpl.replace(endpointLine, `contactEndpoint = 'http://localhost:${PROXY}/api/contact';`);
tpl = tpl.replace(/turnstileSiteKey = '[^']*';/, "turnstileSiteKey = 'test-site-key';");
const testPage = parts.before + encodeTemplate(tpl) + parts.after;

// --- mock flow + mock siteverify -------------------------------------------
const flowHits = [];
const verifyHits = [];
let flowStatus = 202;
const mock = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/siteverify') {
    const form = new URLSearchParams(body);
    verifyHits.push(Object.fromEntries(form));
    res.end(JSON.stringify({ success: form.get('response') === 'fake-token' && form.get('secret') === 'test-secret' }));
  } else if (req.url === '/flow') {
    flowHits.push({ key: req.headers['x-alteon-key'], body: JSON.parse(body) });
    res.writeHead(flowStatus).end();
  } else res.writeHead(404).end();
}).listen(MOCK);

const site = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') res.writeHead(200, { 'Content-Type': 'text/html' }).end(testPage);
  else res.writeHead(404).end();
}).listen(PAGE);

// --- the real proxy code, via the dev server -------------------------------
const proxyLog = [];
const proxy = spawn(process.execPath, [join(root, 'server/dist/dev/local-server.js')], {
  env: {
    ...process.env,
    PORT: String(PROXY),
    FLOW_URL: `http://localhost:${MOCK}/flow`,
    FLOW_SHARED_KEY: 'test-shared-key',
    TURNSTILE_ENABLED: 'true',
    TURNSTILE_SECRET_KEY: 'test-secret',
    TURNSTILE_SITEVERIFY_URL: `http://localhost:${MOCK}/siteverify`,
    RATE_LIMIT_PER_HOUR: '50',
  },
});
proxy.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => proxyLog.push(l)));
await new Promise((r) => { const t = setInterval(() => { if (proxyLog.length) { clearInterval(t); r(); } }, 50); });

// --- browser ----------------------------------------------------------------
const FAKE_TURNSTILE = `window.turnstile = {
  render(el, opts) { window.__tsOpts = opts; return 'w1'; },
  getResponse() { return 'fake-token'; },
  reset() { window.__tsResets = (window.__tsResets || 0) + 1; }
};`;

const browser = await chromium.launch();
const results = [];
async function scenario(name, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  const proxyCalls = [];
  p.on('request', (r) => { if (r.url().includes(`:${PROXY}/`) && r.method() === 'POST') proxyCalls.push(JSON.parse(r.postData())); });
  await p.route('https://challenges.cloudflare.com/**', (route) => route.fulfill({ contentType: 'text/javascript', body: FAKE_TURNSTILE }));
  await p.route(/fonts\.googleapis|fonts\.gstatic/, (route) => route.abort());
  const before = { flow: flowHits.length, verify: verifyHits.length, log: proxyLog.length };
  await p.goto(`http://localhost:${PAGE}/`);
  await p.locator('form input[name="name"]').waitFor();
  try {
    await fn(p, { proxyCalls, before });
    assert.deepEqual(errors, [], 'page errors');
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
    await p.screenshot({ path: join(shots, name.replace(/\W+/g, '-') + '-FAIL.png') });
  }
  await ctx.close();
}

const success = (p) => p.getByText("Thanks, we'll be in touch.").waitFor({ timeout: 15000 });
const errorMsg = 'Something went wrong sending your request. Please try again, or email us directly.';
async function fill(p, v) {
  await p.fill('form input[name="name"]', v.name);
  await p.fill('form input[name="email"]', v.email);
  await p.fill('form input[name="company"]', v.company);
  await p.fill('form textarea[name="message"]', v.message);
}
const real = { name: 'Duke Bonaventura', email: 'duke@dukenet-test-mail.com', company: 'DukeNet', message: 'Duke test message' };

await scenario('page renders, form and honeypot attributes', async (p) => {
  await p.locator('#contact').scrollIntoViewIfNeeded();
  await p.screenshot({ path: join(shots, 'contact-section.png') });
  await p.screenshot({ path: join(shots, 'top.png'), clip: { x: 0, y: 0, width: 1280, height: 900 } });
  const hp = await p.evaluate(() => {
    const i = document.querySelector('form input[name="website"]');
    const box = i.getBoundingClientRect();
    const wrap = i.closest('[aria-hidden]');
    return { tab: i.getAttribute('tabindex'), ac: i.getAttribute('autocomplete'), aria: wrap && wrap.getAttribute('aria-hidden'),
      display: getComputedStyle(i).display, offscreen: box.right < 0, fields: [...document.querySelectorAll('form [name]')].map((e) => e.name) };
  });
  assert.deepEqual(hp, { tab: '-1', ac: 'off', aria: 'true', display: 'inline-block', offscreen: true,
    fields: ['name', 'email', 'company', 'message', 'website'] });
  assert.equal(await p.locator('form button[type="submit"]').innerText(), 'Request a call');
  assert.equal(await p.evaluate(() => window.__tsOpts && window.__tsOpts.sitekey), 'test-site-key');
});

await scenario('normal submission reaches the proxy and is forwarded', async (p, { proxyCalls, before }) => {
  await fill(p, real);
  await p.waitForTimeout(3300);
  await p.click('form button[type="submit"]');
  await success(p);
  assert.equal(proxyCalls.length, 1);
  const sent = proxyCalls[0];
  assert.equal(sent.turnstileToken, 'fake-token');
  assert.equal(sent.website, '');
  assert.ok(sent.elapsedMs >= 3000, 'elapsedMs ' + sent.elapsedMs);
  await p.waitForTimeout(200);
  assert.equal(verifyHits.length - before.verify, 1);
  assert.equal(flowHits.length - before.flow, 1);
  assert.deepEqual(flowHits.at(-1), { key: 'test-shared-key', body: real });
});

await scenario('honeypot filled: success shown, no network call', async (p, { proxyCalls, before }) => {
  await fill(p, real);
  await p.fill('form input[name="website"]', 'http://spam.example', { force: true });
  await p.waitForTimeout(3300);
  await p.click('form button[type="submit"]');
  await success(p);
  await p.waitForTimeout(500);
  assert.equal(proxyCalls.length, 0);
  assert.equal(flowHits.length, before.flow);
});

await scenario('fast submit (<3 s): success shown, no network call', async (p, { proxyCalls, before }) => {
  await fill(p, real);
  await p.click('form button[type="submit"]');
  await success(p);
  await p.waitForTimeout(500);
  assert.equal(proxyCalls.length, 0);
  assert.equal(flowHits.length, before.flow);
});

await scenario('junk that passes the page is dropped by the proxy, page still shows success', async (p, { proxyCalls, before }) => {
  await fill(p, { name: 'FPPJCvVEeBHLvgWjqZ', email: 'ed.e.v.u.q.ab.741@gmail.com', company: 'Aaobdysmav LLC', message: 'RNswBAnmgOfNgfqAKcGCWA' });
  await p.waitForTimeout(3300);
  await p.click('form button[type="submit"]');
  await success(p);
  assert.equal(proxyCalls.length, 1);
  await p.waitForTimeout(200);
  assert.equal(flowHits.length, before.flow);
  const log = proxyLog.slice(before.log).map((l) => JSON.parse(l));
  assert.deepEqual(log, [{ event: 'rejected', reason: 'email-gmail-dots', ip: log[0].ip, emailDomain: 'gmail.com' }]);
});

await scenario('flow failure shows the unchanged error message and resets Turnstile', async (p) => {
  flowStatus = 500;
  try {
    await fill(p, real);
    await p.waitForTimeout(3300);
    await p.click('form button[type="submit"]');
    await p.getByText(errorMsg).waitFor({ timeout: 15000 });
    assert.equal(await p.evaluate(() => window.__tsResets), 1);
    assert.equal(await p.locator('form button[type="submit"]').innerText(), 'Request a call');
  } finally {
    flowStatus = 202;
  }
});

await browser.close();
proxy.kill();
mock.close();
site.close();
for (const r of results) console.log(r.join('  '));
console.log('screenshots: ' + shots);
process.exit(results.every((r) => r[0] === 'PASS') ? 0 : 1);
