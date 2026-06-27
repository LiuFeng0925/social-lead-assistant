'use strict';

// CDP 链路冒烟测试 —— 不依赖小红书。
// 连一个带调试端口的 Chrome,验证 listTargets / evaluate / navigate / screenshot 都正常。
// 用法:先起一个 headless Chrome 在某端口,然后:
//   SELFTEST_ENDPOINT=http://127.0.0.1:9223 node scripts/selftest-cdp.js

const { XhsCdpClient } = require('../src/cdp/xhs-cdp-client');

const ENDPOINT = process.env.SELFTEST_ENDPOINT || 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = new XhsCdpClient({ endpoint: ENDPOINT });

  const targets = await c.listTargets();
  console.log('1) listTargets:', targets.length, '个 target');

  const target = await c.resolvePageTarget({ preferHost: 'example' });
  console.log('2) 选中 target:', target.url || '(about:blank)');

  const r1 = await c.evaluate({ target, expression: '2 + 3' });
  console.log('3) evaluate 2+3 =>', r1 && r1.value);

  await c.navigate({ target, url: 'https://example.com/' });
  await sleep(2000);
  const r2 = await c.evaluate({
    target,
    expression: 'document.querySelector("h1") ? document.querySelector("h1").innerText : document.title'
  });
  console.log('4) navigate 后 h1/title =>', JSON.stringify(r2 && r2.value));

  const shot = await c.screenshot({ target });
  console.log('5) screenshot base64 字节数:', shot ? shot.length : 0);

  const ok = r1 && r1.value === 5 && /example/i.test(String(r2 && r2.value)) && shot && shot.length > 0;
  console.log(ok ? '\n✓ CDP 链路自测通过(接管/执行JS/导航/截图 全部正常)'
                 : '\n△ 结果异常,请看上面输出');
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error('自测失败:', e.message); process.exit(1); });
