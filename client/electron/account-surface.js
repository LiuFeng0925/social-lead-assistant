'use strict';

// Native account 5 never owns a BrowserView. Its previous persistent partition
// stays on disk, but must not be created/displayed as a fallback native surface.
function usesBrowser(accountId) {
  return [1, 2, 3, 4, 6].includes(Number(accountId));
}

module.exports = { usesBrowser };
