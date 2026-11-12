import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGibberishToken, parseSubmission, validateSubmission, Submission } from '../src/validate';

const base: Submission = {
  name: 'Duke Bonaventura',
  email: 'duke@dukenet.example-mail.com',
  company: 'DukeNet',
  message: 'Duke test message',
  website: '',
  elapsedMs: 12_000,
  turnstileToken: 'token',
};
const sub = (over: Partial<Submission>): Submission => ({ ...base, ...over });

// The junk received since Oct 16, plus variations of the same shape.
const junk: Array<[string, Partial<Submission>, string]> = [
  ['gibberish name + LLC + dotted gmail', { name: 'FPPJCvVEeBHLvgWjqZ', company: 'Aaobdysmav LLC', email: 'ed.e.v.u.q.ab.741@gmail.com', message: 'RNswBAnmgOfNgfqAKcGCWA' }, 'email-gmail-dots'],
  ['second gibberish shape', { name: 'WnehYrIRJyfWOBWAEwERNvdX', company: 'Aaobdysmav LLC', email: 'a.l.e.d.eh.i.w.a.l91@gmail.com', message: 'RNswBAnmgOfNgfqAKcGCWA' }, 'email-gmail-dots'],
  ['gibberish name + LLC, clean email', { name: 'FPPJCvVEeBHLvgWjqZ', company: 'Aaobdysmav LLC', email: 'someone@outlook.com', message: 'Hello there' }, 'company-llc-and-gibberish-name'],
  ['gibberish name alone', { name: 'WnehYrIRJyfWOBWAEwERNvdX', company: '', email: 'someone@outlook.com' }, 'name-gibberish'],
  ['gibberish message alone', { message: 'RNswBAnmgOfNgfqAKcGCWA' }, 'message-gibberish'],
  ['blank probe from example.com', { name: '', company: '', message: '', email: 'victim-ukv3x4og@example.com' }, 'name-blank'],
  ['probe with a name still caught by domain', { name: 'Probe', email: 'victim-ukv3x4og@example.com' }, 'email-example-domain'],
  ['victim local part on a real domain', { email: 'victim-abc@outlook.com' }, 'email-test-local'],
  ['test local part', { email: 'testing123@company.com' }, 'email-test-local'],
  ['example.net', { email: 'joe@example.net' }, 'email-example-domain'],
  ['example.org subdomain', { email: 'joe@mail.example.org' }, 'email-example-domain'],
  ['googlemail dots', { email: 'a.b.c.d.e@googlemail.com' }, 'email-gmail-dots'],
  ['honeypot filled', { website: 'http://spam.example' }, 'honeypot'],
  ['too fast', { elapsedMs: 900 }, 'too-fast'],
  ['elapsedMs missing', { elapsedMs: undefined }, 'too-fast'],
  ['whitespace-only name', { name: '   \t ' }, 'name-blank'],
  ['name over 100 chars', { name: 'A'.repeat(101) }, 'name-too-long'],
  ['blank email', { email: '' }, 'email-invalid'],
  ['email without domain dot', { email: 'joe@localhost' }, 'email-invalid'],
];

for (const [label, over, reason] of junk) {
  test('rejects: ' + label, () => assert.equal(validateSubmission(sub(over)), reason));
}

// Real people must always get through.
const real: Array<[string, Partial<Submission>]> = [
  ['your own earlier test', {}],
  ['single-word name', { name: 'Cher' }],
  ['hyphenated name', { name: 'Mary-Jane Watson-Parker' }],
  ['accented name', { name: 'José Núñez' }],
  ['long accented single word', { name: 'Ðorđević' }],
  ['Mc/Mac capitalisation', { name: 'Ronald McDonald-MacArthur' }],
  ['blank company', { company: '' }],
  ['blank message', { message: '' }],
  ['real LLC company with a normal name', { company: 'Acmewidgets LLC' }],
  ['one-word camel-case message', { message: 'SharePointPowerAutomate' }],
  ['longer camel-case message', { message: 'PowerAutomateSharePointExcelTeams' }],
  ['lower camel-case message', { message: 'iPhoneAppDevelopment' }],
  ['gmail with a few dots', { email: 'jane.q.public@gmail.com' }],
  ['gmail with no dots', { email: 'janeqpublic@gmail.com' }],
  ['contest@ is not test@', { email: 'contest@company.com' }],
  ['exactly 3 s elapsed', { elapsedMs: 3000 }],
  ['100-char name', { name: 'B'.repeat(100) }],
  ['name with surrounding spaces', { name: '  Duke Bonaventura  ' }],
  ['real multi-line message', { message: 'We run our CAPA log in Excel.\nIt is getting painful.' }],
];

for (const [label, over] of real) {
  test('accepts: ' + label, () => assert.equal(validateSubmission(sub(over)), null));
}

test('gibberish detector on the exact fixture tokens', () => {
  for (const t of ['FPPJCvVEeBHLvgWjqZ', 'WnehYrIRJyfWOBWAEwERNvdX', 'RNswBAnmgOfNgfqAKcGCWA']) {
    assert.equal(isGibberishToken(t), true, t);
  }
  for (const t of ['Duke Bonaventura', 'DukeNet', 'Cher', 'Duke test message', 'SharePointPowerAutomate', 'Aaobdysmav LLC', '']) {
    assert.equal(isGibberishToken(t), false, t);
  }
});

test('parseSubmission tolerates junk input', () => {
  assert.deepEqual(parseSubmission(null), { name: '', email: '', company: '', message: '', website: '', elapsedMs: undefined, turnstileToken: '' });
  const p = parseSubmission({ name: 42, email: ['x'], elapsedMs: '5000', website: null });
  assert.equal(p.name, '');
  assert.equal(p.email, '');
  assert.equal(p.elapsedMs, undefined);
  assert.equal(validateSubmission(p), 'too-fast');
});
