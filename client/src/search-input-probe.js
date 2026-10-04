'use strict';

// Read-only DOM probes. Coordinates are only returned if the whole trusted
// click jitter area hits the intended control, not a detail/login overlay.
function probeSearchControls(mode) {
  var INPUT_SELECTORS = 'textarea#search-input,textarea[name="aiSearchTextarea"],input.search-input,input#search-input,input[placeholder*="搜索"],input[type="search"],[role="searchbox"]';
  var BUTTON_SELECTORS = '.input-box .submit-button-wrapper,.input-box .search-icon,.input-button .search-icon,.single-line-search-btn,[aria-label="搜索"],button[type="submit"]';
  var EXCLUDED = '.comment-item,.comments-container,.comment-input,.comment-input-container,[class*="comment-composer"],[role="dialog"]';
  var vw = Number(window.innerWidth) || 0, vh = Number(window.innerHeight) || 0;
  var active = document.activeElement;

  function attr(el, name) { try { return String(el.getAttribute(name) || ''); } catch (e) { return ''; } }
  function matches(el, selector) { try { return !!el.matches(selector); } catch (e) { return false; } }
  function contains(el, other) { return !!el && !!other && (el === other || !!(el.contains && el.contains(other))); }
  function closest(el, selector) { try { return el.closest(selector); } catch (e) { return null; } }
  function bounded(value, max) { return String(value == null ? '' : value).replace(/\s+/g, ' ').slice(0, max); }
  function safeText(value, max) {
    return bounded(value, max).replace(/(?:https?:\/\/|www\.)\S+/gi, '[链接]')
      .replace(/\b1[3-9]\d{9}\b/g, '[手机号]')
      .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[标识]');
  }
  function meta(el) {
    if (!el) return null;
    return { tag: bounded(el.tagName || '', 20).toLowerCase(), id: safeText(attr(el, 'id'), 60),
      className: safeText(attr(el, 'class'), 100), role: bounded(attr(el, 'role'), 30) };
  }
  function rect(el) {
    try {
      var r = el.getBoundingClientRect();
      if (![r.left, r.top, r.right, r.bottom, r.width, r.height].every(Number.isFinite)) return null;
      return r;
    } catch (e) { return null; }
  }
  function excluded(el) { return !!closest(el, EXCLUDED); }
  function isEditable(el) {
    if (!el || el.isConnected === false || excluded(el) || el.disabled || el.readOnly || attr(el, 'aria-disabled') === 'true' || attr(el, 'aria-readonly') === 'true') return false;
    var tag = String(el.tagName || '').toLowerCase();
    if (tag === 'input') return /^(|text|search)$/.test(String(el.type || attr(el, 'type') || 'text').toLowerCase());
    if (tag === 'textarea') return true;
    return attr(el, 'role') === 'searchbox' && el.isContentEditable === true;
  }
  function visible(el, r, minWidth, minHeight) {
    if (!el || !r || !vw || !vh || el.isConnected === false || r.width < minWidth || r.height < minHeight || r.left < 0 || r.top < 0 || r.top > 140 || r.right > vw || r.bottom > vh) return false;
    var opacity = 1;
    for (var p = el, n = 0; p && n < 20; p = p.parentElement, n++) {
      if (p.hidden || p.inert || p.disabled || attr(p, 'aria-disabled') === 'true') return false;
      var style;
      try { style = getComputedStyle(p); } catch (e) { return false; }
      if (!style || style.display === 'none') return false;
      // These inherited properties may be explicitly re-enabled by a child;
      // its computed style plus elementFromPoint is the authoritative check.
      if (p === el && (style.visibility === 'hidden' || style.visibility === 'collapse' || style.pointerEvents === 'none')) return false;
      var alpha = Number(style.opacity == null || style.opacity === '' ? 1 : style.opacity);
      if (!Number.isFinite(alpha)) return false;
      opacity *= alpha;
      if (opacity < 0.05) return false;
    }
    return true;
  }
  function hit(el, x, y) {
    try { return contains(el, document.elementFromPoint(x, y)); } catch (e) { return false; }
  }
  function safePoint(el, r) {
    // ±4/±3 mouse-down jitter plus the existing ±1 mouse-up offset.
    var centers = [0.5, 0.35, 0.65, 0.2, 0.8];
    for (var c = 0; c < centers.length; c++) {
      var x = Math.round(r.left + r.width * centers[c]), y = Math.round(r.top + r.height / 2);
      if (x - 5 <= r.left || x + 5 >= r.right || y - 4 <= r.top || y + 4 >= r.bottom) continue;
      var good = true;
      for (var dx = -5; dx <= 5 && good; dx++) {
        for (var dy = -4; dy <= 4; dy++) {
          if (!hit(el, x + dx, y + dy)) { good = false; break; }
        }
      }
      if (good) return { x: x, y: y };
    }
    return null;
  }
  function searchValue(el) {
    var tag = String(el.tagName || '').toLowerCase();
    return String((tag === 'input' || tag === 'textarea' ? el.value : el.textContent) || '');
  }
  var candidates = [];
  try { candidates = Array.prototype.slice.call(document.querySelectorAll(INPUT_SELECTORS), 0, 32); } catch (e) {}
  // The AI page can keep two overlapping textareas. Read the actual active
  // editor first; its hidden/stale twin must not decide whether typing worked.
  var activeSearch = active;
  for (var depth = 0; activeSearch && depth < 5 && !matches(activeSearch, INPUT_SELECTORS); depth++) activeSearch = activeSearch.parentElement;
  if (activeSearch && matches(activeSearch, INPUT_SELECTORS)) {
    candidates = [activeSearch].concat(candidates.filter(function (el) { return el !== activeSearch; })).slice(0, 32);
  }
  var usable = [], diagnostics = [];
  for (var i = 0; i < candidates.length; i++) {
    var el = candidates[i], r = rect(el), editable = isEditable(el), isVisible = visible(el, r, 200, 18);
    var point = editable && isVisible ? safePoint(el, r) : null;
    if (mode === 'diagnostic' && diagnostics.length < 6) {
      var centerHit = null;
      if (r) { try { centerHit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); } catch (e) {} }
      diagnostics.push({ element: meta(el), editable: editable, visible: isVisible, clickable: !!point,
        focused: contains(el, active), value: editable ? safeText(searchValue(el), 80) : '',
        placeholder: safeText(el.placeholder || attr(el, 'aria-label'), 80),
        rect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
        hit: meta(centerHit) });
    }
    if (point) usable.push({ element: el, rect: r, point: point });
    if (point && mode === 'input') return JSON.stringify({ x: point.x, y: point.y,
      value: searchValue(el), placeholder: String(el.placeholder || attr(el, 'aria-label') || ''), focused: contains(el, active) });
  }
  if (mode === 'diagnostic') {
    // Path only: signed query parameters and fragments must never reach logs.
    var path = '';
    try { path = safeText(location.pathname || '', 100).replace(/\/[a-f0-9]{20,}(?=\/|$)/gi, '/[标识]'); } catch (e) {}
    return JSON.stringify({ readyState: bounded(document.readyState, 20), path: path,
      viewport: [vw, vh], active: meta(active), candidates: diagnostics, candidateCount: candidates.length });
  }
  if (mode !== 'submit' || !usable.length) return '';
  function sharesSearchRegion(button, input) {
    var br = rect(button), ir = input.rect;
    if (!br || br.left < ir.left - 48 || br.right > ir.right + 140 || br.bottom < ir.top - 12 || br.top > ir.bottom + 12) return false;
    var buttonForm = closest(button, 'form'), inputForm = closest(input.element, 'form');
    if (buttonForm && inputForm && buttonForm !== inputForm) return false;
    for (var p = input.element.parentElement, n = 0; p && n < 5; p = p.parentElement, n++) {
      if (/^(BODY|HTML)$/i.test(String(p.tagName || ''))) return false;
      if (contains(p, button)) {
        var pr = rect(p);
        return !!pr && pr.top >= 0 && pr.top <= 140 && pr.height <= 180 && pr.width <= vw;
      }
    }
    return false;
  }
  var buttons = [];
  try { buttons = Array.prototype.slice.call(document.querySelectorAll(BUTTON_SELECTORS), 0, 40); } catch (e) {}
  for (var b = 0; b < buttons.length; b++) {
    var button = buttons[b], br = rect(button);
    if (excluded(button) || isEditable(button) || !visible(button, br, 16, 16)) continue;
    // A labelled search wrapper may also match aria-label="搜索", but clicking
    // its editable descendant only moves the caret; it is not a submit action.
    if (usable.some(function (input) { return contains(button, input.element); })) continue;
    for (var u = 0; u < usable.length; u++) {
      if (!sharesSearchRegion(button, usable[u])) continue;
      var bp = safePoint(button, br);
      if (bp) return JSON.stringify(bp);
    }
  }
  return '';
}

const expression = (mode) => '(' + probeSearchControls.toString() + ')(' + JSON.stringify(mode) + ')';
const SEARCH_INPUT_PROBE = expression('input');
const SEARCH_SUBMIT_PROBE = expression('submit');
const SEARCH_INPUT_DIAGNOSTIC_PROBE = expression('diagnostic');

module.exports = { SEARCH_INPUT_PROBE, SEARCH_SUBMIT_PROBE, SEARCH_INPUT_DIAGNOSTIC_PROBE };
