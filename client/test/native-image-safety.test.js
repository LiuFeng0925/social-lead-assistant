'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const native = require('../electron/native-xhs');

// These tests only exercise local files. No App/Photos, mouse, keyboard or public send.
function images(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-native-image-safety-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = path.join(dir, 'property-a.png');
  const second = path.join(dir, 'property-b.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6mMAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(first, png);
  fs.writeFileSync(second, png);
  return { dir, first, second, png };
}

test('native image preparation binds the current property path and content', async (t) => {
  const { first, png } = images(t);
  assert.equal(await native.prepareImage(first), fs.realpathSync(first));
  const result = await native.attachImage(first);
  assert.equal(result.imagePath, fs.realpathSync(first));
  assert.equal(result.sha256, crypto.createHash('sha256').update(png).digest('hex'));
  assert.equal(result.verified, false);
  assert.equal(result.attached, false);
  assert.match(result.reason, /没有选择缩略图/);
});

test('same content in another property file cannot replace the prepared image', async (t) => {
  const { first, second } = images(t);
  await native.prepareImage(first);
  await assert.rejects(native.attachImage(second), /native_comment_image_does_not_match_prepared/);
});

test('a prepared path whose contents changed is rejected and its state invalidated', async (t) => {
  const { first, png } = images(t);
  await native.prepareImage(first);
  const changed = Buffer.from(png);
  changed[changed.length - 1] ^= 1;
  fs.writeFileSync(first, changed);
  await assert.rejects(native.attachImage(first), /native_comment_image_changed/);
  await assert.rejects(native.attachImage(first), /native_comment_image_not_prepared/);
});

test('preparing the next property invalidates the preceding property image', async (t) => {
  const { first, second } = images(t);
  await native.prepareImage(first);
  await native.prepareImage(second);
  await assert.rejects(native.attachImage(first), /native_comment_image_does_not_match_prepared/);
  assert.equal((await native.attachImage(second)).attached, false);
});

test('invalid preparation cannot leave the previous image usable', async (t) => {
  const { first, dir } = images(t);
  await native.prepareImage(first);
  await assert.rejects(native.prepareImage(''), /native_comment_image_missing/);
  await assert.rejects(native.attachImage(first), /native_comment_image_not_prepared/);
  await assert.rejects(native.prepareImage(dir), /native_comment_image_invalid/);
});

test('native direct send is blocked when attachment identity is unverified', async (t) => {
  const { first } = images(t);
  await native.prepareImage(first);
  await native.attachImage(first);
  await assert.rejects(native.sendPreparedComment(), /native_comment_image_identity_unverified/);
});

test('image code does not use an anonymous recent-grid position or Photos import as identity', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'native-xhs.js'), 'utf8');
  const attachmentBody = source.slice(source.indexOf('async function attachImage('), source.indexOf('async function sendPreparedComment('));
  assert.doesNotMatch(attachmentBody, /cells\[1\]|helper\('click'|clickAt\(/);
  assert.doesNotMatch(source, /import \{imageFile\} skip check duplicates/);
});
