'use strict';

// 合规红线检查 —— 评论/私信发送前必过(需求 FR-9.7)。
// 命中任一规则即判违规、不发。规则保守,宁可错杀明文联系方式。
// 注意:"私聊我 / 主页有实拍 / 扣1"这类软引导不违规(没有明文联系方式)。

const RULES = [
  { name: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/, hint: '疑似明文手机号' },
  { name: '微信', re: /(微信|加\s*我?\s*[vV]\b|\b[vV]\s*信|薇信|weixin|wechat|\bvx\b|\bwx\b|加个?\s*微)/i, hint: '提到微信/索要微信号' },
  { name: 'QQ', re: /(扣扣|企鹅号|\bQQ\b)\s*[:：]?\s*\d{4,}/i, hint: '疑似 QQ 号' },
  { name: '二维码', re: /(二维码|扫码|扫一扫|长按识别|识别图中)/, hint: '二维码引导' },
  { name: '外链', re: /(https?:\/\/|www\.[a-z]|\.com\b|\.cn\b|\.net\b|短链)/i, hint: '站外链接' },
];

function check(text) {
  const t = String(text || '');
  const violations = [];
  for (const r of RULES) {
    if (r.re.test(t)) violations.push({ rule: r.name, hint: r.hint });
  }
  return { ok: violations.length === 0, violations };
}

// 目标帖是否明确排斥中介(中介硬评易被举报,建议跳过/确认个人房东身份)
function rejectsAgent(text) {
  return /(中介勿扰|中介滚|勿扰中介|拒绝中介|托管勿扰|不要中介|中介别)/.test(String(text || ''));
}

module.exports = { check, rejectsAgent, RULES };
