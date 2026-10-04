'use strict';

const { selectGalleryMatch } = require('./rental-gallery');

function demandSummary(demand = {}) {
  return [
    ['地区', [demand.city, demand.district, ...(demand.locations || [])].filter(Boolean).join('、') || '未知'],
    ['预算', demand.budgetMin != null || demand.budgetMax != null ? `${demand.budgetMin ?? '不限下限'}—${demand.budgetMax ?? '不限上限'}元/月` : '未知'],
    ['户型', demand.bedrooms && demand.bedrooms.length ? demand.bedrooms.join('/') + '室' : '未知'],
    ['租期', demand.leaseMonthsMin != null || demand.leaseMonthsMax != null ? `${demand.leaseMonthsMin ?? '?'}—${demand.leaseMonthsMax ?? '?'}个月` : '未知'],
    ['其他要求', (demand.requirements || []).join('、') || '未说明']
  ].map(([k, v]) => k + '：' + v).join('；');
}

// 本地联调阶段用经过匹配的房源事实生成短句，不调用旧版会泛称“我有几套”的模板。
// 预算/户型未知时明确追问；图片只代表这一套备选房源，不承诺一定适合对方。
function groundedComment(property, demand = {}) {
  const area = String((property.locations || [])[0] || property.district || property.city || '').slice(0, 14);
  const type = property.rentalType === 'shared' ? '合租' : '整租';
  const facts = `${area}${property.bedrooms}室${type}，${property.rent}元/月，图中这套供参考。`;
  let question = '位置和租金能接受吗？';
  if (demand.budgetMin == null && demand.budgetMax == null && !(demand.bedrooms || []).length) question = '你的预算和户型要求是？';
  else if (demand.budgetMin == null && demand.budgetMax == null) question = '你的预算大概多少？';
  else if (!(demand.bedrooms || []).length) question = '你想找几室？';
  return facts + question;
}

async function buildReplyPlan({ decision, catalogPath, select = selectGalleryMatch, check = () => ({ ok: true }) }) {
  const demand = decision && decision.rentalDemand;
  if (!decision || !decision.eligible) return { status: 'not_eligible', reason: '笔记不符合获客条件', demand: demand || null };
  if (!demand) return { status: 'needs_more_info', reason: '未提取到结构化需求，暂不选图', demand: null };
  if (Array.isArray(demand.unverifiedFields) && demand.unverifiedFields.length) return { status: 'needs_more_info', reason: '需求原文与提取结果需核对：' + demand.unverifiedFields.join('、') + '；不放宽条件选图', demand };
  let match;
  try { match = await select({ demand, catalogPath }); }
  catch (_) { return { status: 'failed', reason: '本地图库读取失败，未生成图文回复', demand }; }
  if (!match || match.status !== 'matched') return { ...(match || { status: 'failed', reason: '图库返回无效' }), demand };
  if (!match.property || !match.imagePath) return { status: 'failed', reason: '匹配房源缺少图片或明细', demand };
  const comment = groundedComment(match.property, demand);
  if (comment.length > 80 || !check(comment).ok) return { status: 'failed', reason: '匹配房源生成的文案未通过发送检查', demand };
  return { ...match, demand, comment, textSource: 'verified_property_template' };
}

function saveReplyPlan(database, { runId, noteId, keyword, plan }) {
  database.exec(`create table if not exists native_reply_plans (
    run_id integer not null, note_id text not null, keyword text not null,
    status text not null, plan_json text not null, updated_at text not null,
    primary key (run_id,note_id,keyword))`);
  database.prepare(`insert into native_reply_plans values (?,?,?,?,?,?)
    on conflict(run_id,note_id,keyword) do update set status=excluded.status,plan_json=excluded.plan_json,updated_at=excluded.updated_at`)
    .run(Number(runId) || 0, String(noteId), String(keyword), String(plan.status), JSON.stringify(plan), new Date().toISOString());
}

module.exports = { buildReplyPlan, groundedComment, demandSummary, saveReplyPlan };
