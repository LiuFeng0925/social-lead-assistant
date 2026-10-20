'use strict';

// Electron、账号服务与控制台共用同一份账号配置；编号也是持久数据的身份。
const ACCOUNT_COUNT = Number(process.env.XHS_ACCOUNT_COUNT || 15);
const UI_PORT_BASE = 3100;
if (!Number.isInteger(ACCOUNT_COUNT) || ACCOUNT_COUNT < 1 || ACCOUNT_COUNT > 50) {
  throw new Error('XHS_ACCOUNT_COUNT 必须为 1–50 的整数');
}

function normalizeAccountId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id >= 1 && id <= ACCOUNT_COUNT ? id : 1;
}

module.exports = { ACCOUNT_COUNT, UI_PORT_BASE, normalizeAccountId };
