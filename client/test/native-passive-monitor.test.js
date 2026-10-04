'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'electron', 'native-xhs.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const normalWindow = { id: 55, x: 100, y: 100, width: 1000, height: 800 };

// Dependency-isolated tests: no actual App, shell, capture, keyboard or clipboard call.
function loadNative(respond) {
  const calls = [];
  const fakeFs = Object.create(fs);
  fakeFs.mkdirSync = () => {};
  fakeFs.existsSync = () => true;
  fakeFs.statSync = () => ({ mtimeMs: 1 });
  const module = { exports: {} };
  vm.runInNewContext(`${source}\nmodule.exports.testInput = {typeAndSubmit,pasteWithoutSubmit,pressEscape};`, {
    module,
    __dirname: path.dirname(sourcePath),
    require(name) {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:util') return { promisify: () => async (file, args, options) => {
        const call = { file, args, options };
        calls.push(call);
        return respond(call);
      } };
      return require(name);
    },
    setTimeout: (fn) => queueMicrotask(fn),
  }, { filename: sourcePath });
  return { native: module.exports, calls };
}

test('passive monitor only reads the existing window and captures its own image', async () => {
  const { native, calls } = loadNative(({ file, args }) => {
    if (path.basename(file) === 'native-xhs-helper' && args[0] === 'window') return { stdout: JSON.stringify(normalWindow) };
    if (file === 'screencapture') return { stdout: '' };
    throw new Error(`Unexpected program: ${file}`);
  });
  const shot = await native.captureWindow({ passive: true });
  assert.equal(path.basename(shot.imagePath), 'native-xhs-monitor.png');
  assert.equal(calls.length, 2);
  assert.deepEqual(Array.from(calls[1].args.slice(0, 4)), ['-x', '-l', '55', shot.imagePath]);
  assert.equal(calls.some(({ file }) => ['open', 'osascript', 'swift'].includes(file)), false);
});

test('missing/minimized App window returns unavailable without raising or capturing it', async () => {
  const { native, calls } = loadNative(() => { throw Object.assign(new Error('no window'), { code: 4 }); });
  await assert.rejects(native.captureWindow({ passive: true }), { code: 'native_app_window_unavailable' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'window');
});

test('task window retries remain read-only and never recover by stealing focus', async () => {
  const { native, calls } = loadNative(() => { throw Object.assign(new Error('no window'), { code: 4 }); });
  await assert.rejects(native.appWindowBounds(), { code: 'native_app_window_unavailable' });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ file, args }) => path.basename(file) === 'native-xhs-helper' && args[0] === 'window'));
});

test('an unrelated small App surface is not displayed as the main App window', async () => {
  const { native, calls } = loadNative(() => ({ stdout: JSON.stringify({ ...normalWindow, width: 100 }) }));
  await assert.rejects(native.captureWindow({ passive: true }), { code: 'native_app_window_unavailable' });
  assert.equal(calls.length, 1);
});

test('search refuses background execution and does not activate the App', async () => {
  const { native, calls } = loadNative(() => ({ stdout: JSON.stringify({ ok: true, frontmost: false }) }));
  await assert.rejects(native.search('石家庄求租'), { code: 'native_app_not_frontmost' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'foreground');
});

test('focus lost after search starts immediately pauses rather than running fallback clicks', async () => {
  let foregroundChecks = 0;
  const { native, calls } = loadNative(({ args }) => {
    assert.equal(args[0], 'foreground');
    foregroundChecks += 1;
    return { stdout: JSON.stringify({ ok: true, frontmost: foregroundChecks === 1 }) };
  });
  await assert.rejects(native.search('石家庄求租'), { code: 'native_app_not_frontmost' });
  assert.equal(calls.length, 2);
});

test('helper focus-loss errors stay recognizable by task pause handling', async () => {
  const { native } = loadNative(({ file }) => {
    if (file === 'pgrep') return { stdout: '123' };
    throw Object.assign(new Error('exit 78'), { code: 78, stderr: 'native_app_not_frontmost' });
  });
  await assert.rejects(native.pressText('搜索'), { code: 'native_app_not_frontmost' });
});

test('background typing/escape never touch clipboard or send global key events', async () => {
  const { native, calls } = loadNative(() => ({ stdout: JSON.stringify({ ok: true, frontmost: false }) }));
  for (const method of ['typeAndSubmit', 'pasteWithoutSubmit', 'pressEscape']) {
    await assert.rejects(native.testInput[method]('预算1800'), { code: 'native_app_not_frontmost' });
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ args }) => args[0] === 'foreground'));
});

test('foreground typing checks focus per key and conditionally restores prior clipboard', async () => {
  const { native, calls } = loadNative(({ file }) => file === 'osascript'
    ? { stdout: '' } : { stdout: JSON.stringify({ ok: true, frontmost: true }) });
  await native.testInput.typeAndSubmit('预算1800');
  const script = calls.find(({ file }) => file === 'osascript').args[1];
  assert.match(script, /set previousClipboard to the clipboard as record/);
  assert.match(script, /if \(the clipboard as text\) is insertedText then set the clipboard to previousClipboard/);
  assert.match(script, /my requireNativeForeground\(\)\s+keystroke "a"/);
  assert.match(script, /my requireNativeForeground\(\)\s+keystroke "v"/);
  assert.match(script, /my requireNativeForeground\(\)\s+key code 36/);
  assert.doesNotMatch(script, /set frontmost to true/);
});

test('AppleScript focus-loss errors are normalized instead of masking the pause reason', async () => {
  const { native } = loadNative(({ file }) => {
    if (file !== 'osascript') return { stdout: JSON.stringify({ ok: true, frontmost: true }) };
    throw Object.assign(new Error('AppleScript failed'), { code: 1, stderr: 'execution error: native_app_not_frontmost (78)' });
  });
  await assert.rejects(native.testInput.pressEscape(), { code: 'native_app_not_frontmost' });
});

test('only the explicit activate entry point can force App foreground', () => {
  const outsideActivate = source.slice(0, source.indexOf('async function activate('))
    + source.slice(source.indexOf('async function openPublish('));
  assert.doesNotMatch(outsideActivate, /set frontmost to true/);
});
