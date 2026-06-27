# Human Note Navigation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every automated note view behave like a human search-result workflow: open a note from the list, close it, then open the next note.

**Architecture:** Add a focused note-navigation helper that owns search-list lookup, human click-to-open, detail readiness checks, and close-to-list verification. Wire both detail reading and comment sending through this helper instead of navigating directly to note URLs.

**Tech Stack:** Electron BrowserView, Chrome DevTools Protocol, Node.js CommonJS, native assertion tests.

---

## Chunk 1: Human Note Navigation

### Task 1: Add a Tested Note Navigation Helper

**Files:**
- Create: `client/src/note-navigation.js`
- Create: `client/scripts/selftest-note-navigation.js`
- Modify: `client/src/cdp/xhs-cdp-client.js`

- [ ] **Step 1: Write the failing test**

Create `client/scripts/selftest-note-navigation.js` with fixture-based tests for:
- matching a note link by note id
- extracting a clickable center point
- detecting when a detail view is open
- detecting when the page has returned to the search list

Run: `node scripts/selftest-note-navigation.js`
Expected: FAIL because `src/note-navigation.js` does not exist.

- [ ] **Step 2: Write minimal helper**

Create `client/src/note-navigation.js` exporting:
- `findNoteCardExpr(note)` returns a browser expression that finds the note card link by `id` or `/explore/{id}` URL and returns `{ ok, x, y, href }`.
- `detailStateExpr(note)` returns `{ open, urlMatches, hasDetailMap }`.
- `listStateExpr()` returns `{ onSearch, cardCount }`.
- `openNoteFromList({ client, target, note, onLog })` clicks the card and waits for detail readiness.
- `closeCurrentNote({ client, target, onLog })` tries a visible close button, then `Escape`, then verifies list state.

- [ ] **Step 3: Add keyboard support**

Modify `client/src/cdp/xhs-cdp-client.js` with a generic `pressKey({ target, key, code, windowsVirtualKeyCode })` and keep `pressEnter()` as a wrapper.

- [ ] **Step 4: Run helper tests**

Run: `node scripts/selftest-note-navigation.js`
Expected: PASS.

### Task 2: Wire Detail Reading Through Open/Close

**Files:**
- Modify: `client/src/engine.js`
- Modify: `client/src/server.js`

- [ ] **Step 1: Update `engine.readDetail`**

Change `readDetail` from direct `client.navigate({ url })` to:
- `openNoteFromList({ client, target, note })`
- wait/read `DETAIL_EXTRACT`
- scroll lightly inside detail
- `closeCurrentNote({ client, target })` in `finally`

Keep the existing direct read behavior out of the automated path.

- [ ] **Step 2: Pass the full note**

Change the call in `client/src/server.js` from `engine.readDetail({ client, target, url: t.url })` to `engine.readDetail({ client, target, note: t, onLog })`.

### Task 3: Wire Comment Sending Through Open/Close

**Files:**
- Modify: `client/src/server.js`

- [ ] **Step 1: Replace direct send navigation**

In `handleSend`, replace `client.navigate({ target, url: r.url })` with `openNoteFromList({ client, target, note: r })`.

- [ ] **Step 2: Always close after dry-run/send**

Wrap the send flow so `closeCurrentNote` runs before every response path where a detail view was opened. For dry-run this means: open, locate comment box, return dry-run success, close.

### Task 4: Verify Behavior

**Files:**
- Modify: `docs/反检测与拟人化清单.md`

- [ ] **Step 1: Run static checks**

Run:
- `node --check src/note-navigation.js`
- `node --check src/engine.js`
- `node --check src/server.js`
- `node scripts/selftest-note-navigation.js`

Expected: all pass.

- [ ] **Step 2: Verify no automated detail direct navigate remains**

Run: `rg -n "navigate\\(\\{ target, url: .*\\.url|readDetail\\(\\{ client, target, url" client/src`
Expected: no hits in the main automated `readDetail`/`handleSend` paths.

- [ ] **Step 3: Manual live check**

Restart Electron and run one search from the UI. Watch the right browser show: card click -> detail opens -> detail closes -> next card opens.

- [ ] **Step 4: Update anti-detection checklist**

Change the “读详情改拟人路径” item from pending to done or partial, depending on live verification result.
