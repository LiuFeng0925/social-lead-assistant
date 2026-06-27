'use strict';

// M4 · 发评论
// 默认 DRY-RUN:只定位评论框 + 截图,不发。加 --send 才真发。
// 安全:发送前合规复检 + tmp/STOP 文件紧急刹车 + 拟人点击/输入。
// 用法:
//   node src/m4-comment.js              # dry-run:定位评论框,截图,不发
//   node src/m4-comment.js --send       # 真发队列第 0 条
//   node src/m4-comment.js --send --index 1

const fs = require('node:fs');
const path = require('node:path');
const { XhsCdpClient } = require('./cdp/xhs-cdp-client');
const { check } = require('./compliance');

const ENDPOINT = process.env.XHS_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const SEND = process.argv.includes('--send');
const idxArg = process.argv.indexOf('--index');
const INDEX = idxArg >= 0 ? Number(process.argv[idxArg + 1] || 0) : 0;
const textArg = process.argv.indexOf('--text');
const CUSTOM_TEXT = textArg >= 0 ? process.argv[textArg + 1] : null; // 覆盖评论内容(测试用)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const ts = () => new Date().toLocaleTimeString('zh-CN');
const log = (...a) => console.log(`[${ts()}]`, ...a);
const TMP = path.join(__dirname, '..', 'tmp');

function latestToSend() {
  const files = fs.readdirSync(TMP).filter((f) => /^to-send-\d+\.json$/.test(f)).sort();
  if (!files.length) throw new Error('没有 to-send-*.json,先跑 m3-generate-demo');
  return path.join(TMP, files[files.length - 1]);
}

// 定位评论输入框 + 发送按钮(返回中心坐标)
const PROBE = `(function(){
  function vis(r){ return r.width>40 && r.height>10 && r.bottom>0 && r.top<window.innerHeight; }
  var inputs=[];
  var els=document.querySelectorAll('[contenteditable="true"],textarea,p[class*="placeholder"],div[class*="comment"] [class*="input"],div[class*="content-input"],[class*="inner-input"],[class*="comment-input"]');
  for(var i=0;i<els.length;i++){ var e=els[i]; var r=e.getBoundingClientRect(); if(!vis(r))continue;
    inputs.push({tag:e.tagName,cls:String(e.className).slice(0,60),ph:String(e.getAttribute('placeholder')||e.getAttribute('data-placeholder')||e.innerText||'').slice(0,24),x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height)}); }
  var btns=[]; var all=document.querySelectorAll('button,span,div,[class*="submit"],[class*="send"]');
  for(var j=0;j<all.length&&btns.length<10;j++){ var b=all[j]; var tx=(b.childElementCount===0?(b.innerText||''):'').trim();
    if(tx==='发送'||tx==='发布'){ var br=b.getBoundingClientRect(); if(vis(br)) btns.push({tx:tx,cls:String(b.className).slice(0,50),x:Math.round(br.x+br.width/2),y:Math.round(br.y+br.height/2)}); } }
  return JSON.stringify({inputs:inputs.slice(0,8),sendBtns:btns});
})()`;

async function shot(client, target, name) {
  try { const img = await client.screenshot({ target }); if (img) { const f = path.join(TMP, `m4-${name}-${Date.now()}.jpg`); fs.writeFileSync(f, Buffer.from(img, 'base64')); log('截图:', path.basename(f)); } } catch (e) {}
}

async function main() {
  if (SEND && fs.existsSync(path.join(TMP, 'STOP'))) { log('⛔ 检测到 tmp/STOP,紧急刹车生效,拒绝发送。'); process.exit(0); }

  const data = JSON.parse(fs.readFileSync(latestToSend(), 'utf8'));
  const item = (data.queue || [])[INDEX];
  if (!item) { log('队列里没有第', INDEX, '条'); process.exit(1); }

  const comment = CUSTOM_TEXT || item.comment;
  log(SEND ? '⚠ 发送模式' : 'DRY-RUN(只定位 + 截图,不发)');
  log('目标笔记:', item.title);
  log('评论内容:', comment, CUSTOM_TEXT ? '(自定义测试内容)' : '');

  const comp = check(comment);
  if (!comp.ok) { log('✗ 合规复检不过,拒发:', comp.violations.map((v) => v.hint).join('、')); process.exit(1); }
  log('合规复检:✓');

  const client = new XhsCdpClient({ endpoint: ENDPOINT });
  const target = await client.resolvePageTarget();
  await client.navigate({ target, url: item.url });
  for (let k = 0; k < 12; k++) { await sleep(900); const rs = await client.evaluate({ target, expression: 'document.readyState' }); if (rs && rs.value === 'complete') break; }
  await sleep(1500);
  await client.evaluate({ target, expression: 'window.scrollBy(0, 600);"ok"' }).catch(() => {});
  await sleep(rand(900, 1600));

  const pr = await client.evaluate({ target, expression: PROBE });
  let probe; try { probe = JSON.parse(pr.value); } catch (e) { probe = { inputs: [], sendBtns: [] }; }
  console.log('\n—— 评论框候选 ——'); console.log(JSON.stringify(probe.inputs, null, 1));
  console.log('—— 发送按钮候选 ——'); console.log(JSON.stringify(probe.sendBtns, null, 1));
  await shot(client, target, 'probe');

  if (!SEND) { log('\nDRY-RUN 结束。看截图 + 候选定位准不准,确认后加 --send 真发。'); process.exit(0); }

  // —— 真发 ——
  const box = probe.inputs[0];
  if (!box) { log('✗ 没定位到评论框,中止(评论未发)。把上面候选发我调选择器。'); process.exit(1); }
  log('① 点击评论框 @', box.x, box.y);
  await client.click({ target, x: box.x, y: box.y });
  await sleep(rand(700, 1400));
  log('② 拟人输入评论…');
  await client.typeText({ target, text: comment });
  await sleep(rand(1200, 2200));
  await shot(client, target, 'typed');
  const pr2 = await client.evaluate({ target, expression: PROBE });
  let probe2; try { probe2 = JSON.parse(pr2.value); } catch (e) { probe2 = { sendBtns: [] }; }
  const btn = (probe2.sendBtns || [])[0] || (probe.sendBtns || [])[0];
  if (!btn) { log('✗ 没找到发送按钮(评论已输入但未发出)。把 typed 截图发我。'); process.exit(1); }
  log('③ 点击发送 @', btn.x, btn.y);
  await client.click({ target, x: btn.x, y: btn.y });
  await sleep(2200);
  await shot(client, target, 'sent');
  log('✓ 已点发送。看 sent 截图确认评论是否出现在笔记下。');
  process.exit(0);
}

main().catch((e) => { console.error('未捕获错误:', e); process.exit(1); });
