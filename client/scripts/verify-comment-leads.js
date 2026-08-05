'use strict';

const { XhsCdpClient } = require('../src/cdp/xhs-cdp-client');
const { scanClean, scanOpenNoteComments, leadTextDecision, replyOpenNoteComment } = require('../src/engine');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const client = new XhsCdpClient();
  const target = await client.resolvePageTarget();
  const notes = await scanClean({ client, target, keyword: process.argv[2] || '长阳租房', maxNotes: 1, maxRounds: 1 });
  if (!notes[0] || !notes[0].url) throw new Error('no_note_from_search');
  await client.navigate({ target, url: notes[0].url });
  await sleep(7000);
  for (let i = 0; i < 3; i++) {
    await client.wheelScroll({ target, x: 620, y: 540, totalDeltaY: 700 }).catch(() => {});
    await sleep(1800);
  }
  const comments = await scanOpenNoteComments({ client, target });
  const eligible = comments.filter((item) => leadTextDecision(item.content).eligible);
  const replyProbe = eligible[0]
    ? await replyOpenNoteComment({ client, target, item: eligible[0], text: '草稿定位测试', dry: true })
    : null;
  let diagnostic = null;
  if (!comments.length) {
    const r = await client.evaluate({ target, expression: `(function(){
      var classes=[], all=document.querySelectorAll('[class]');
      for(var i=0;i<all.length&&classes.length<80;i++){
        var c=String(all[i].className||'');
        if(/comment|reply|content/i.test(c)&&classes.indexOf(c)<0)classes.push(c);
      }
      return JSON.stringify({url:location.href,classes:classes,hasCommentText:(document.body.innerText||'').indexOf('评论')>=0});
    })()` });
    try { diagnostic = JSON.parse(r.value || '{}'); } catch (e) {}
  }
  console.log(JSON.stringify({ ok: true, commentsRead: comments.length, eligibleLeads: eligible.length, replyProbe, diagnostic }));
})().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
