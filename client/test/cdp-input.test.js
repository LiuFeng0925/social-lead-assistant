'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { XhsCdpClient } = require('../src/cdp/xhs-cdp-client');

test('one pointer move uses one CDP command instead of reopening many sockets', async () => {
  const client = new XhsCdpClient();
  const calls = [];
  client.sendCommand = async (command) => { calls.push(command); return {}; };
  await client.humanMove({ target: {}, toX: 320, toY: 480 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'Input.dispatchMouseEvent');
});

test('one wheel action uses one CDP command', async () => {
  const client = new XhsCdpClient();
  const calls = [];
  client.sendCommand = async (command) => { calls.push(command); return {}; };
  await client.wheelScroll({ target: {}, totalDeltaY: 900 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.deltaY, 900);
});

test('typing a comment uses one insert command', async () => {
  const client = new XhsCdpClient();
  const calls = [];
  client.sendCommand = async (command) => { calls.push(command); return {}; };
  await client.typeText({ target: {}, text: '房东直租，私' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.text, '房东直租，私');
  assert.equal(calls[0].timeoutMs, 3000);
});

test('select all includes the explicit Chromium editing command', async () => {
  const client = new XhsCdpClient();
  const sequences = [];
  client.sendCommandSequence = async (request) => { sequences.push(request); return [{}, {}]; };
  await client.selectAll({ target: {} });
  assert.equal(sequences.length, 1);
  assert.deepEqual(sequences[0].commands[0].params.commands, ['SelectAll']);
});

test('file uploads keep DOM lookup and set-file commands in one CDP session', () => {
  const source = require('node:fs').readFileSync(require.resolve('../src/cdp/xhs-cdp-client'), 'utf8');
  assert.match(source, /async setFileInputFiles/);
  assert.match(source, /DOM\.getDocument/);
  assert.match(source, /DOM\.setFileInputFiles/);
});

test('a click keeps mouse press and release in one CDP session', async () => {
  const client = new XhsCdpClient();
  const commands = [];
  client.sendCommand = async (request) => { commands.push(request); return {}; };
  client.humanMove = async () => {};
  const sequences = [];
  client.sendCommandSequence = async (request) => { sequences.push(request); return [{}, {}]; };
  await client.click({ target: {}, x: 320, y: 480 });
  assert.equal(commands[0].method, 'Page.bringToFront');
  assert.equal(sequences.length, 1);
  assert.deepEqual(sequences[0].commands.map((item) => item.params.type), ['mousePressed', 'mouseReleased']);
});
