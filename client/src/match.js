'use strict';

// M2 · 分层匹配(规则版)
// 读最新 clean-*.json,对每条笔记判定:L1 地区命中 + L2 意向(求租/房源/中介)→ 筛出"该评论的求租帖"。
// 规则都在文件顶部,可调。用法:node src/match.js [clean-xxx.json]

const fs = require('node:fs');
const path = require('node:path');

const TMP = path.join(__dirname, '..', 'tmp');

// ── 可配置规则(以后搬进配置中心)──
const TARGET_REGIONS = ['朝阳', '北京', '望京', '国贸', '三里屯', '双井', '十里河', '大悦城', '酒仙桥', '798', '团结湖', '安贞', '劲松', '潘家园', '日坛', '亮马', '燕莎', '草房', '常营', '管庄'];
const RE_SEEK = /(求租|求转租|求直租|求推荐|求靠谱|求房|找房|蹲|谁有|有没有|想租|要租|跪求|急租|预算[\d千万]|[\d千万]+(以)?内.{0,4}(一居|两居|室|开间|房|公寓))/; // 求租意向
const RE_SUPPLY = /(整租|^直租|房东直租|出租|转租|拎包入住|可短租|月付|押[一二三]付|看房|空房|新出|有房|出房|招租)/;                       // 房源意向
const RE_AGENT = /(CH$|好房|直租|物业|公寓|甄选|管家|房产|租房记|找房|安家|房探|地产|不动产|优选|房屋|租赁|严选|好房甄选|直租CH)/;       // 中介营销号(作者名)

function classify(note) {
  const title = note.title || '';
  const author = note.author || '';
  const region = TARGET_REGIONS.find((r) => title.includes(r)) || (title.includes('租房') || title.includes('租') ? '(泛北京)' : '');
  const regionHit = !!region;
  const isAgent = RE_AGENT.test(author);
  const seek = RE_SEEK.test(title);
  const supply = RE_SUPPLY.test(title);
  let intent;
  if (seek) intent = '求租';           // "求转租/求直租"也算求租
  else if (supply) intent = '房源';
  else intent = '不明';                 // 标题无明显信号(多为无标题图文帖)
  // 评论玩法目标:个人求租帖 + 地区命中 + 非中介营销号
  const isTarget = intent === '求租' && regionHit && !isAgent;
  const heat = Number(note.comments || 0) + Number(note.likes || 0);
  return { ...note, region, regionHit, isAgent, intent, isTarget, heat };
}

function latestClean() {
  const files = fs.readdirSync(TMP).filter((f) => /^clean-\d+\.json$/.test(f)).sort();
  if (!files.length) throw new Error('没有 clean-*.json,先跑 scan-clean');
  return path.join(TMP, files[files.length - 1]);
}

function main() {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : latestClean();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const notes = data.notes || [];
  console.log(`读取 ${path.basename(file)} · 关键词「${data.keyword}」共 ${notes.length} 条\n`);

  const tagged = notes.map(classify);
  const byIntent = {};
  tagged.forEach((n) => { byIntent[n.intent] = (byIntent[n.intent] || 0) + 1; });
  const targets = tagged.filter((n) => n.isTarget).sort((a, b) => b.heat - a.heat);

  console.log('—— L2 意向分布 ——');
  Object.entries(byIntent).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log(`  其中作者像中介营销号: ${tagged.filter((n) => n.isAgent).length}`);

  console.log(`\n—— 筛出"该评论"的求租帖:${targets.length} 条(按热度=赞+评排序)——`);
  targets.slice(0, 25).forEach((n, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${n.title || '(无标题)'}  [${n.region}]`);
    console.log(`     ${n.author} · 赞${n.likes}/藏${n.collects}/评${n.comments} · 热度${n.heat}`);
  });
  if (targets.length > 25) console.log(`… 其余 ${targets.length - 25} 条已存 JSON`);

  console.log('\n—— 被排除的(抽样核对规则准不准)——');
  const excluded = tagged.filter((n) => !n.isTarget);
  excluded.filter((n) => n.isAgent).slice(0, 3).forEach((n) => console.log(`  [中介] ${n.title || '(无标题)'} · ${n.author}`));
  excluded.filter((n) => n.intent === '房源' && !n.isAgent).slice(0, 3).forEach((n) => console.log(`  [房源] ${n.title || '(无标题)'} · ${n.author}`));
  excluded.filter((n) => n.intent === '不明').slice(0, 3).forEach((n) => console.log(`  [不明] ${n.title || '(无标题)'} · ${n.author} (无标题图文,规则判不出,需进详情/LLM)`));

  const out = path.join(TMP, `match-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ keyword: data.keyword, total: notes.length, byIntent, targetCount: targets.length, targets }, null, 2));
  console.log(`\n已存匹配结果:${path.basename(out)}`);
  console.log(`小结:${notes.length} 条 → 命中"该评论的求租帖" ${targets.length} 条。规则(地区/意向/中介词)都在 match.js 顶部,可调。`);
}

main();
