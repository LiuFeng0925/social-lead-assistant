'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../public/app.html'), 'utf8');

test('account buttons show the full remark without an account-number prefix', () => {
  assert.match(html, /const name = label \|\| String\(id\)/);
  assert.match(html, /white-space:normal/);
  assert.match(html, /overflow-wrap:anywhere/);
  assert.doesNotMatch(html, /const name = accountLabels\[id\] \? \('账号 '/);
});

test('unlabelled account buttons retain a compact numeric identity', () => {
  assert.match(html, /const accessibleName = label \? \('账号 ' \+ id \+ ' · ' \+ label\) : \('账号 ' \+ id\)/);
  assert.match(html, /btn\.setAttribute\('aria-label', accessibleName\)/);
});
