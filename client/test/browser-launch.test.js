'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chromeCandidates, buildChromeArgs } = require('../src/browser-launch');

test('Windows Chrome candidates include system and user installs', () => {
  const candidates = chromeCandidates({
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'
  });
  assert.equal(candidates.length, 3);
  assert.match(candidates[0], /Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/);
});

test('CDP Chrome uses a dedicated profile and requested port', () => {
  const args = buildChromeArgs({ port: 9222, profileDir: 'C:\\xhs-profile' });
  assert.ok(args.includes('--remote-debugging-port=9222'));
  assert.ok(args.includes('--user-data-dir=C:\\xhs-profile'));
  assert.ok(args.includes('https://www.xiaohongshu.com/explore'));
});
