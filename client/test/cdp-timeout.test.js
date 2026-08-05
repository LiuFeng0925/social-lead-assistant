'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForCommandResult } = require('../src/cdp/xhs-cdp-client');

test('CDP command timeout is not reset by unrelated browser events', async () => {
  const conn = {
    waitForMessage() {
      return Promise.resolve(JSON.stringify({ method: 'Page.event' }));
    }
  };
  const started = Date.now();
  await assert.rejects(waitForCommandResult(conn, 99, 30), /cdp_command_timeout/);
  assert.ok(Date.now() - started < 150);
});
