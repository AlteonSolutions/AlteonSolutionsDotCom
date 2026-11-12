#!/usr/bin/env node
// Decode / re-encode the page template inside index.html.
//
// index.html is a Claude Design self-unpacking bundle. The page markup lives in
// <script type="__bundler/template"> as one JSON string, encoded as
// JSON.stringify(html) with every "</" written as "</" so the string can
// never close the surrounding <script> element.
//
//   node tools/bundle-template.mjs decode [index.html] [out.html]
//   node tools/bundle-template.mjs encode [in.html] [index.html]
//   node tools/bundle-template.mjs check  [index.html]   (round-trip proof)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OPEN = '<script type="__bundler/template">\n';
const CLOSE = '\n  </script>';

export function encodeTemplate(html) {
  return JSON.stringify(html).replace(/<\//g, '<\\u002F');
}

export function decodeTemplate(encoded) {
  return JSON.parse(encoded);
}

export function splitBundle(page) {
  const start = page.indexOf(OPEN);
  if (start < 0 || page.indexOf(OPEN, start + 1) >= 0) throw new Error('expected exactly one template block');
  const from = start + OPEN.length;
  const to = page.indexOf(CLOSE, from);
  if (to < 0) throw new Error('template block is not closed');
  return { before: page.slice(0, from), encoded: page.slice(from, to), after: page.slice(to) };
}

function assertSafe(encoded) {
  // Inside a <script> element, "<!--" followed by "<script" switches the HTML
  // parser into the double-escaped state; refuse rather than ship a broken page.
  if (/<!--/.test(encoded)) throw new Error('encoded template contains "<!--"; escape it before encoding');
  if (/<\/script/i.test(encoded)) throw new Error('encoded template still contains a closing script tag');
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
const [cmd, a, b] = isMain ? process.argv.slice(2) : [];
if (cmd === 'decode') {
  const { encoded } = splitBundle(readFileSync(a || 'index.html', 'utf8'));
  writeFileSync(b || 'template.html', decodeTemplate(encoded));
} else if (cmd === 'encode') {
  const target = b || 'index.html';
  const page = readFileSync(target, 'utf8');
  const parts = splitBundle(page);
  const encoded = encodeTemplate(readFileSync(a || 'template.html', 'utf8'));
  assertSafe(encoded);
  writeFileSync(target, parts.before + encoded + parts.after);
} else if (cmd === 'check') {
  const page = readFileSync(a || 'index.html', 'utf8');
  const parts = splitBundle(page);
  const rebuilt = parts.before + encodeTemplate(decodeTemplate(parts.encoded)) + parts.after;
  assertSafe(parts.encoded);
  if (rebuilt !== page) {
    let i = 0;
    while (rebuilt[i] === page[i]) i++;
    console.error('round trip differs at offset ' + i);
    process.exit(1);
  }
  console.log('round trip OK: ' + Buffer.byteLength(page) + ' bytes identical');
} else if (cmd) {
  console.error('usage: bundle-template.mjs decode|encode|check ...');
  process.exit(2);
}
