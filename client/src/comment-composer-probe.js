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
  const ariaLabel = String(candidate.ariaLabel || '').replace(/\s+/g, '').toLowerCase();
  const title = String(candidate.title || '').replace(/\s+/g, '').toLowerCase();
  const testId = String(candidate.testId || '').toLowerCase();
  const type = String(candidate.type || '').toLowerCase();
  const role = String(candidate.role || '').toLowerCase();
  const semantic = [classes, text, ariaLabel, title, testId].join(' ');
  const hasSubmitClass = /(^|\s)submit(\s|$)|send-button|comment-submit|publish-button|btn-send|send-btn/.test(semantic);
  const hasSendText = [text, ariaLabel, title].some((value) => /^(发送|发布|send|submit)$/.test(value));
  const hasSubmitType = type === 'submit';
  if (!hasSubmitClass && !hasSendText && !hasSubmitType) return -100000;
  if (candidate.inComposer) score += 180;
  if (hasSubmitClass) score += 260;
  if (hasSendText) score += 180;
  if (hasSubmitType) score += 120;
  if (String(candidate.tag || '').toUpperCase() === 'BUTTON') score += 40;
  if (role === 'button') score += 35;
  if (candidate.hitTested) score += 45;
  if (/cancel|取消/.test(semantic)) score -= 1000;
  if (candidate.inSearch) score -= 1200;
  if (candidate.pointerEvents === 'none') score -= 1000;
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
  return buttons.find((button) => button && button.disabled !== true &&
    String(button.ariaDisabled || '').toLowerCase() !== 'true' && button.pointerEvents !== 'none') || null;
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
  function hitTested(el){
    try{var p=center(el),hit=document.elementFromPoint(p.x,p.y);return !!(hit&&(hit===el||el.contains(hit)||hit.contains(el)));}catch(e){return false;}
  }
  var inputEls=[].slice.call(document.querySelectorAll('#content-textarea,[contenteditable="true"],[role="textbox"],textarea,p[class*="content-input"],[class*="comment-input"],[class*="comment-editor"]'));
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
  var oldMarkers=document.querySelectorAll('[data-sla-comment-editor="active"]');
  for(var m=0;m<oldMarkers.length;m++) oldMarkers[m].removeAttribute('data-sla-comment-editor');
  if(chosenEl) chosenEl.setAttribute('data-sla-comment-editor','active');
  var composer=chosenEl&&closest(chosenEl,'.engage-bar,.engage-bar-container,[class*="engage-bar"],form,[class*="comment-composer"],[class*="comment-box"],[class*="input-wrapper"],[class*="comment-input-container"],[class*="publish-container"]');
  if(!composer&&chosenEl){
    var parent=chosenEl.parentElement;
    for(var depth=0;parent&&depth<7;depth++,parent=parent.parentElement){
      if(parent.querySelector('button,[role="button"],[aria-label*="发送"],[title*="发送"],[data-testid*="send"],[class*="submit"],[class*="send"]')){composer=parent;break;}
    }
  }
  if(!composer&&chosenEl) composer=closest(chosenEl,'.note-detail-mask,.note-container,[class*="note-detail"]');
  var buttonRoot=composer||document;
  var buttonEls=[].slice.call(buttonRoot.querySelectorAll('button,[role="button"],[type="submit"],[aria-label],[title],[data-testid],span,div'));
  var rankedButtons=[];
  for(var j=0;j<buttonEls.length;j++){
    var button=buttonEls[j];
    var ariaLabel=String(button.getAttribute('aria-label')||'').trim();
    var title=String(button.getAttribute('title')||'').trim();
    var text=String(button.innerText||button.textContent||'').replace(/\\s+/g,' ').trim();
    var classes=classText(button);
    var style=getComputedStyle(button);
    var metaBtn={visible:visible(button),classes:classes,text:text,ariaLabel:ariaLabel,title:title,testId:button.getAttribute('data-testid')||'',type:button.getAttribute('type')||'',role:button.getAttribute('role')||'',tag:button.tagName,inComposer:!!composer&&composer.contains(button),inSearch:!!closest(button,'header,[class*="search"],[class*="Search"]'),pointerEvents:style.pointerEvents,hitTested:hitTested(button)};
    var buttonScore=sendCandidateScore(metaBtn);
    if(buttonScore<=0) continue;
    var buttonPoint=center(button);
    rankedButtons.push({x:buttonPoint.x,y:buttonPoint.y,score:buttonScore,text:text,ariaLabel:ariaLabel,title:title,classes:classes,tag:button.tagName,disabled:!!button.disabled,ariaDisabled:button.getAttribute('aria-disabled'),pointerEvents:style.pointerEvents});
  }
  rankedButtons.sort(function(a,b){return b.score-a.score;});
  return JSON.stringify({inputs:rankedInputs.slice(0,4),sendBtns:rankedButtons.slice(0,6),composerFound:!!composer,success:String(document.body&&document.body.innerText||'').indexOf('评论成功')>=0});
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
