'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('running task keeps the Mac awake and releases the lock when stopped', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(main, /powerSaveBlocker\.start\('prevent-display-sleep'\)/);
  assert.match(main, /process\.on\('xhs:task-wake-lock', setTaskWakeLock\)/);
  assert.match(server, /setTaskWakeLock\(true\)/);
  assert.match(server, /setTaskWakeLock\(false\)/);
});
