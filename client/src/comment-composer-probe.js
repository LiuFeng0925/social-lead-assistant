'use strict';

// 评论框定位不能依赖“页面里的第一个输入框”或固定坐标。
// 小红书会按窗口宽度/A-B 版本插入搜索 textarea；这里按元素语义和所属组件打分。
function inputCandidateScore(candidate = {}) {
  if (!candidate.visible) return -100000;
  let score = 0;
  const id = String(candidate.id || '').toLowerCase();
  const classes = String(candidate.classes || '').toLowerCase();
  const placeholder = String(candidate.placeholder || '').toLowerCase();
  if (candidate.inSearch || /搜索|search/.test(placeholder)) score -= 1200;
  if (id === 'content-textarea') score += 400;
  if (/(^|\s)content-input(\s|$)/.test(classes)) score += 260;
  if (/comment-input|comment.*editor|editor.*comment/.test(classes)) score += 180;
  if (candidate.inEngageBar) score += 220;
  if (candidate.inNoteDetail) score += 100;
  if (candidate.contentEditable) score += 50;
  if (/评论|回复|comment|reply/.test(placeholder)) score += 80;
  if (String(candidate.tag || '').toUpperCase() === 'TEXTAREA') score += 5;
  return score;
}

function sendCandidateScore(candidate = {}) {
  if (!candidate.visible) return -100000;
  let score = 0;
  const classes = String(candidate.classes || '').toLowerCase();
  const text = String(candidate.text || '').replace(/\s+/g, '').toLowerCase();
  const hasSubmitClass = /(^|\s)submit(\s|$)|send-button|comment-submit/.test(classes);
  const hasSendText = text === '发送' || text === '发布' || text === 'send';
  if (!hasSubmitClass && !hasSendText) return -100000;
  if (candidate.inComposer) score += 180;
  if (hasSubmitClass) score += 260;
  if (hasSendText) score += 180;
  if (String(candidate.tag || '').toUpperCase() === 'BUTTON') score += 40;
  if (/cancel|取消/.test(classes + text)) score -= 1000;
  if (candidate.inSearch) score -= 1200;
  return score;
}

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function pickCommentInput(probe) {
  return probe && Array.isArray(probe.inputs) ? (probe.inputs[0] || null) : null;
}

function pickEnabledSendButton(probe) {
  const buttons = probe && Array.isArray(probe.sendBtns) ? probe.sendBtns : [];
  return buttons.find((button) => button && button.disabled !== true && String(button.ariaDisabled || '').toLowerCase() !== 'true') || null;
}

function inputHasExpectedText(input, expectedText) {
  return !!input && normalizeText(input.text) === normalizeText(expectedText);
}

const COMMENT_COMPOSER_PROBE = `(function(){
  var inputCandidateScore = ${inputCandidateScore.toString()};
  var sendCandidateScore = ${sendCandidateScore.toString()};
  function visible(el){
    if(!el) return false;
    var r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return r.width>20&&r.height>10&&r.bottom>0&&r.top<window.innerHeight&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0;
  }
  function center(el){ var r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; }
  function classText(el){ var value=el&&el.className; return String(value&&value.baseVal||value||''); }
  function closest(el,selector){ try{return el&&el.closest?el.closest(selector):null;}catch(e){return null;} }
  function editorText(el){ return String(el&&(el.isContentEditable?el.innerText:el.value)||'').replace(/\\s+/g,' ').trim(); }
  var inputEls=[].slice.call(document.querySelectorAll('#content-textarea,[contenteditable="true"],textarea,p[class*="content-input"],[class*="comment-input"]'));
  var rankedInputs=[];
  for(var i=0;i<inputEls.length;i++){
    var el=inputEls[i];
    var placeholder=[el.getAttribute('placeholder'),el.getAttribute('data-placeholder'),el.getAttribute('aria-label')].filter(Boolean).join(' ');
    var inSearch=!!closest(el,'header,[class*="search"],[class*="Search"],[class*="header"],[class*="Header"]');
    var inEngageBar=!!closest(el,'.engage-bar,.engage-bar-container,[class*="engage-bar"]');
    var inNoteDetail=!!closest(el,'.note-detail-mask,.note-container,[class*="note-detail"]');
    var meta={visible:visible(el),id:el.id||'',classes:classText(el),placeholder:placeholder,tag:el.tagName,contentEditable:!!el.isContentEditable,inSearch:inSearch,inEngageBar:inEngageBar,inNoteDetail:inNoteDetail};
    var score=inputCandidateScore(meta);
    if(score<=0) continue;
    var point=center(el);
    rankedInputs.push({x:point.x,y:point.y,score:score,text:editorText(el),id:meta.id,classes:meta.classes,tag:meta.tag});
  }
  rankedInputs.sort(function(a,b){return b.score-a.score;});
  var chosen=rankedInputs[0]||null;
  var chosenEl=null;
  if(chosen){
    for(var k=0;k<inputEls.length;k++){
      var p=center(inputEls[k]);
      if(p.x===chosen.x&&p.y===chosen.y&&editorText(inputEls[k])===chosen.text){chosenEl=inputEls[k];break;}
    }
  }
  var composer=chosenEl&&closest(chosenEl,'.engage-bar,.engage-bar-container,[class*="engage-bar"]');
  if(!composer&&chosenEl) composer=closest(chosenEl,'.note-detail-mask,.note-container,[class*="note-detail"]');
  var buttonRoot=composer||document;
  var buttonEls=[].slice.call(buttonRoot.querySelectorAll('button,[role="button"],span,div'));
  var rankedButtons=[];
  for(var j=0;j<buttonEls.length;j++){
    var button=buttonEls[j];
    var text=String(button.innerText||button.getAttribute('aria-label')||button.getAttribute('title')||'').replace(/\\s+/g,' ').trim();
    var classes=classText(button);
    var metaBtn={visible:visible(button),classes:classes,text:text,tag:button.tagName,inComposer:!!composer&&composer.contains(button),inSearch:!!closest(button,'header,[class*="search"],[class*="Search"]')};
    var buttonScore=sendCandidateScore(metaBtn);
    if(buttonScore<=0) continue;
    var buttonPoint=center(button);
    rankedButtons.push({x:buttonPoint.x,y:buttonPoint.y,score:buttonScore,text:text,classes:classes,tag:button.tagName,disabled:!!button.disabled,ariaDisabled:button.getAttribute('aria-disabled')});
  }
  rankedButtons.sort(function(a,b){return b.score-a.score;});
  return JSON.stringify({inputs:rankedInputs.slice(0,4),sendBtns:rankedButtons.slice(0,6),success:String(document.body&&document.body.innerText||'').indexOf('评论成功')>=0});
})()`;

module.exports = {
  COMMENT_COMPOSER_PROBE,
  inputCandidateScore,
  sendCandidateScore,
  pickCommentInput,
  pickEnabledSendButton,
  inputHasExpectedText,
  normalizeText
};
