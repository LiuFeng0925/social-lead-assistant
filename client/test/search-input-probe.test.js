'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { SEARCH_INPUT_PROBE, SEARCH_SUBMIT_PROBE, SEARCH_INPUT_DIAGNOSTIC_PROBE } = require('../src/search-input-probe');

// Small read-only DOM fixture: selector matching and paint-order hit testing
// run the production expression without Electron, networking or real accounts.
function fixture() {
  const all = [];
  function basic(el, selector) {
    const tag = selector.match(/^[A-Za-z][\w-]*/);
    if (tag && el.tagName !== tag[0].toUpperCase()) return false;
    for (const id of selector.matchAll(/#([\w-]+)/g)) if (el.getAttribute('id') !== id[1]) return false;
    for (const cls of selector.matchAll(/\.([\w-]+)/g)) if (!String(el.getAttribute('class')).split(/\s+/).includes(cls[1])) return false;
    for (const attr of selector.matchAll(/\[([\w-]+)(\*?=)?["']?([^\]"']*)["']?\]/g)) {
      const value = el.getAttribute(attr[1]);
      if (value == null || (attr[2] === '=' && value !== attr[3]) || (attr[2] === '*=' && !value.includes(attr[3]))) return false;
    }
    return true;
  }
  function matches(el, selector) {
    return selector.split(',').some(part => {
      const chunks = part.trim().split(/\s+/);
      if (!basic(el, chunks.pop())) return false;
      let parent = el.parentElement;
      while (chunks.length) {
        const expected = chunks.pop();
        while (parent && !basic(parent, expected)) parent = parent.parentElement;
        if (!parent) return false;
        parent = parent.parentElement;
      }
      return true;
    });
  }
  function add(tag, props = {}, parent) {
    const attrs = { ...(props.attrs || {}) };
    const dimensions = { left: 250, top: 20, width: 400, height: 36, ...(props.rect || {}) };
    const el = {
      tagName: tag.toUpperCase(), parentElement: parent || null, isConnected: true,
      value: '', textContent: '', type: tag === 'input' ? 'text' : '', placeholder: '',
      disabled: false, readOnly: false, isContentEditable: false,
      style: { display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto', ...(props.style || {}) },
      getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
      getBoundingClientRect() { return { ...dimensions, right: dimensions.left + dimensions.width, bottom: dimensions.top + dimensions.height }; },
      contains(other) { for (let p = other; p; p = p.parentElement) if (p === this) return true; return false; },
      matches(selector) { return matches(this, selector); },
      closest(selector) { for (let p = this; p; p = p.parentElement) if (matches(p, selector)) return p; return null; },
      click() { assert.fail('probe must not click'); }, focus() { assert.fail('probe must not focus'); }
    };
    for (const key of ['value', 'type', 'textContent', 'placeholder', 'disabled', 'readOnly', 'isContentEditable', 'isConnected', 'hidden', 'inert']) if (Object.hasOwn(props, key)) el[key] = props[key];
    all.push(el); return el;
  }
  const body = add('body', { rect: { left: 0, top: 0, width: 1200, height: 900 } });
  const header = add('header', { rect: { left: 0, top: 0, width: 1200, height: 80 } }, body);
  const region = add('div', { attrs: { class: 'input-box' }, rect: { left: 220, top: 10, width: 510, height: 60 } }, header);
  const input = add('input', { attrs: { id: 'search-input' }, placeholder: '搜索小红书', value: '石家庄求租' }, region);
  let hitOverride = null;
  const document = {
    activeElement: body, readyState: 'complete',
    querySelectorAll(selector) { return all.filter(el => el.isConnected && matches(el, selector)); },
    elementFromPoint(x, y) {
      if (hitOverride) { const override = hitOverride(x, y); if (override !== undefined) return override; }
      return all.slice().reverse().find(el => {
        const r = el.getBoundingClientRect();
        return el.isConnected && el.style.display !== 'none' && el.style.visibility !== 'hidden' && el.style.pointerEvents !== 'none' && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
      }) || null;
    }
  };
  const context = { document, window: { innerWidth: 1200, innerHeight: 900 },
    location: { pathname: '/search_result', search: '?xsec_token=DO_NOT_LOG', hash: '#SECRET' }, getComputedStyle: el => el.style };
  return { all, add, body, header, region, input, document, context,
    hitOverride(fn) { hitOverride = fn; },
    evaluate(expr = SEARCH_INPUT_PROBE) { const value = vm.runInNewContext(expr, context); return value ? JSON.parse(value) : null; },
    button(props = {}, parent = region) { return add('button', { attrs: { type: 'submit' }, rect: { left: 670, top: 20, width: 36, height: 36 }, ...props }, parent); }
  };
}

test('returns real topbar input coordinates, value and focused state without writing', () => {
  const f = fixture();
  assert.deepEqual(f.evaluate(), { x: 450, y: 38, value: '石家庄求租', placeholder: '搜索小红书', focused: false });
  f.document.activeElement = f.input;
  assert.equal(f.evaluate().focused, true);
});

test('detail overlay covering the search field prevents stale coordinates', () => {
  const f = fixture();
  f.add('div', { attrs: { class: 'note-detail-mask' }, rect: { left: 0, top: 0, width: 1200, height: 900 } }, f.body);
  assert.equal(f.evaluate(), null);
  const diagnostic = f.evaluate(SEARCH_INPUT_DIAGNOSTIC_PROBE);
  assert.equal(diagnostic.candidates[0].clickable, false);
  assert.equal(diagnostic.candidates[0].hit.className, 'note-detail-mask');
});

test('active overlapping AI textarea wins over a stale matching input', () => {
  const f = fixture();
  const ai = f.add('textarea', { attrs: { name: 'aiSearchTextarea' }, value: '刚输入的新关键词' }, f.region);
  f.document.activeElement = ai;
  assert.equal(f.evaluate().value, '刚输入的新关键词');
  assert.equal(f.evaluate().focused, true);
});

test('focused searchbox contenteditable accepts a descendant caret target', () => {
  const f = fixture(); f.input.isConnected = false;
  const editable = f.add('div', { attrs: { role: 'searchbox' }, isContentEditable: true, textContent: '新搜索词' }, f.region);
  const child = f.add('span', {}, editable); f.document.activeElement = child;
  assert.equal(f.evaluate().value, '新搜索词');
  assert.equal(f.evaluate().focused, true);
});

test('non-editable role searchbox never becomes an input or leaks its text', () => {
  const f = fixture(); f.input.isConnected = false;
  const box = f.add('div', { attrs: { role: 'searchbox' } }, f.region);
  Object.defineProperty(box, 'textContent', { get() { assert.fail('must not read non-editor text'); } });
  assert.equal(f.evaluate(), null);
  assert.equal(f.evaluate(SEARCH_INPUT_DIAGNOSTIC_PROBE).candidates[0].value, '');
});

for (const [name, mutate] of [
  ['disabled', f => { f.input.disabled = true; }],
  ['readonly', f => { f.input.readOnly = true; }],
  ['hidden', f => { f.input.style.visibility = 'hidden'; }],
  ['opacity zero', f => { f.input.style.opacity = '0'; }],
  ['pointer events none', f => { f.input.style.pointerEvents = 'none'; }],
  ['hidden ancestor', f => { f.region.style.display = 'none'; }],
  ['inert ancestor', f => { f.region.inert = true; }],
  ['offscreen right edge', f => { f.context.window.innerWidth = 620; }],
  ['password field', f => { f.input.type = 'password'; }],
  ['disconnected stale field', f => { f.input.isConnected = false; }]
]) test(name + ' search field is rejected', () => { const f = fixture(); mutate(f); assert.equal(f.evaluate(), null); });

test('all possible click jitter points must hit the field, not only its center', () => {
  const f = fixture();
  const overlay = { tagName: 'DIV', getAttribute() { return 'tiny-overlay'; } };
  // Every proposed point has a blocker only at its +4/+3 jitter location.
  f.hitOverride((x, y) => [454, 394, 514, 334, 574].includes(x) && y === 41 ? overlay : undefined);
  assert.equal(f.evaluate(), null);
});

test('partially covered field uses another fully safe point', () => {
  const f = fixture();
  f.hitOverride((x, y) => x > 430 && x < 470 ? f.body : undefined);
  assert.equal(f.evaluate().x, 390);
});

test('visible hit-testable children can override ancestor pointer and visibility styles', () => {
  const f = fixture();
  f.region.style.visibility = 'hidden'; f.region.style.pointerEvents = 'none';
  assert.equal(f.evaluate().value, '石家庄求租');
});

test('each execution resolves replacements after a render, never cached DOM', () => {
  const f = fixture(); assert.equal(f.evaluate().x, 450);
  f.input.isConnected = false;
  const replacement = f.add('textarea', { attrs: { id: 'search-input' }, rect: { left: 260, top: 20, width: 420, height: 36 }, value: '重绘后关键词' }, f.region);
  f.document.activeElement = replacement;
  assert.deepEqual(f.evaluate(), { x: 470, y: 38, value: '重绘后关键词', placeholder: '', focused: true });
});

test('recognizes the classic submit button and the new single-line search button', () => {
  for (const props of [{}, { attrs: { class: 'single-line-search-btn' } }, { attrs: { class: 'submit-button-wrapper' } }, { attrs: { class: 'search-icon' } }]) {
    const f = fixture(); f.button(props);
    assert.deepEqual(f.evaluate(SEARCH_SUBMIT_PROBE), { x: 688, y: 38 });
  }
});

test('submit hit testing permits an icon descendant inside its actual button', () => {
  const f = fixture(), button = f.button();
  f.add('svg', { rect: { left: 678, top: 27, width: 20, height: 20 } }, button);
  assert.deepEqual(f.evaluate(SEARCH_SUBMIT_PROBE), { x: 688, y: 38 });
});

test('comment submit elsewhere on the page is never used for search', () => {
  const f = fixture();
  f.button({ rect: { left: 670, top: 500, width: 36, height: 36 } }, f.body);
  assert.equal(f.evaluate(SEARCH_SUBMIT_PROBE), null);
});

test('a generic topbar submit in a separate form cannot be a search button', () => {
  const f = fixture(); f.region.tagName = 'FORM';
  const form = f.add('form', { rect: { left: 660, top: 10, width: 80, height: 60 } }, f.header);
  f.button({}, form);
  assert.equal(f.evaluate(SEARCH_SUBMIT_PROBE), null);
});

test('a button near search with no shared search region is rejected', () => {
  const f = fixture(); f.button({}, f.body);
  assert.equal(f.evaluate(SEARCH_SUBMIT_PROBE), null);
});

test('a search-labelled wrapper cannot masquerade as a submit button', () => {
  const f = fixture();
  const wrapper = f.add('div', { attrs: { 'aria-label': '搜索' }, rect: { left: 240, top: 10, width: 460, height: 60 } }, f.region);
  f.input.parentElement = wrapper;
  // Keep the input on top of its wrapper, as in a real DOM paint tree.
  f.hitOverride((x, y) => x >= 250 && x < 650 && y >= 20 && y < 56 ? f.input : undefined);
  assert.equal(f.evaluate(SEARCH_SUBMIT_PROBE), null);
});

test('disabled, hidden, overlay-covered or out-of-viewport search buttons are rejected', () => {
  for (const mutate of [b => { b.disabled = true; }, b => { b.style.opacity = '0'; }, (b, f) => { f.context.window.innerWidth = 690; }, (b, f) => { f.hitOverride((x, y) => x > 660 ? f.body : undefined); }]) {
    const f = fixture(), b = f.button(); mutate(b, f);
    assert.equal(f.evaluate(SEARCH_SUBMIT_PROBE), null);
  }
});

test('diagnostic is bounded and redacts link/token/phone instead of reading page content', () => {
  const f = fixture();
  f.input.value = 'https://example.com/?api_key=SECRET 13812345678 abcdefghijklmnopqrstuvwxyz1234567890 ' + '词'.repeat(5000);
  f.context.location.pathname = '/search_result/6a8019510000000005031e2d';
  for (let n = 0; n < 80; n++) f.add('textarea', { attrs: { id: 'search-input' }, value: '字'.repeat(5000) }, f.region);
  Object.defineProperty(f.document, 'cookie', { get() { assert.fail('no cookies'); } });
  Object.defineProperty(f.body, 'textContent', { get() { assert.fail('no page body'); } });
  const result = f.evaluate(SEARCH_INPUT_DIAGNOSTIC_PROBE);
  assert.equal(result.candidates.length, 6);
  assert.equal(result.candidateCount, 32);
  assert.ok(result.candidates.every(candidate => candidate.value.length <= 80));
  const serialized = JSON.stringify(result);
  assert.ok(serialized.length < 6000);
  assert.doesNotMatch(serialized, /SECRET|13812345678|xsec_token|6a8019510000000005031e2d/);
  assert.match(serialized, /\[链接\]/);
  assert.match(serialized, /\[手机号\]/);
});

test('comment and modal inputs are excluded even if their selector and coordinates resemble search', () => {
  for (const attrs of [{ class: 'comment-input' }, { role: 'dialog' }]) {
    const f = fixture(); f.input.isConnected = false;
    const container = f.add('div', { attrs }, f.body);
    const editor = f.add('input', { attrs: { id: 'search-input' } }, container);
    Object.defineProperty(editor, 'value', { get() { assert.fail('do not read excluded editor text'); } });
    assert.equal(f.evaluate(), null);
    assert.equal(f.evaluate(SEARCH_INPUT_DIAGNOSTIC_PROBE).candidates[0].value, '');
  }
});
