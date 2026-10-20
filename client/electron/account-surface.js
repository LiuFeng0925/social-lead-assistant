'use strict';
const { ACCOUNT_COUNT } = require('../src/account-config');

function usesBrowser(accountId) {
  const id = Number(accountId);
  return Number.isInteger(id) && id >= 1 && id <= ACCOUNT_COUNT;
}

module.exports = { usesBrowser };
