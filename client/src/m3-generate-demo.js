'use strict';

// M3 演示 · 完整链路:笔记详情 → 生成评论 → 合规检查 → 待发清单
//
// 开发阶段:下面 GEN 数组是【Claude 充当 LLM】按 DIRECTION(评论主方向)为这几条笔记生成的评论。
// 接火山 Ark / 阿里百炼后,把 GEN 换成 generateComment(note, DIRECTION) 调真 API 即可,其余不变。
//
// 用法:node src/m3-generate-demo.js

const fs = require('node:fs');
const path = require('node:path');
const { check, rejectsAgent } = require('./compliance');
const TMP = path.join(__dirname, '..', 'tmp');

const DIRECTION = '我是朝阳一带的房源方,看到求租帖就结合对方的地区/户型/预算友好回应,告诉 ta 我可能有合适房源;口吻像邻居一样真诚,结尾自然引导看主页实拍或私聊;绝不留微信/电话/二维码/外链。';

// 【Claude 充当 LLM 的产出】按 details 顺序对应(每条结合该帖的具体诉求,不雷同)
const GEN = [
  '看你想在朝阳大悦城那边找一居室呀～我手上正好有套东边的独立一居,通勤方便、年轻人住着合适,最近刚空出来。要不要看看?主页有实拍,合适的话可以私聊我聊细节～',
  '看到你急租、想马上入住~我这边有几套现房能拎包入住,交通都挺方便。你大概想找哪一片、预算多少呀?说一下我帮你对合适的,主页有实拍可以先看~',
  '团结湖、水碓东路那一带我熟~你要的三居电梯房、不临街、适合一家带孩子住的,我这有对得上的房东直租,7月中下旬入住也来得及。要不要我把符合的几套整理给你看看?主页有实拍。',
  '1500在朝阳能挑的不算多,但通勤方便、不太偏的我这还真有几个~你主要在哪边上班呀?我按你通勤线帮你筛几个,主页有图可以先瞅瞅~',
  '你说的高碑店、四惠那一片,我自己有套一居室,独门独户、整租,个人直租不收中介费,正好在你范围内。要看的话主页有实拍,合适可以私聊我~',
];

function latestDetails() {
  const files = fs.readdirSync(TMP).filter((f) => /^details-\d+\.json$/.test(f)).sort();
  if (!files.length) throw new Error('没有 details-*.json,先跑 m3-read-notes.js');
  return path.join(TMP, files[files.length - 1]);
}

function main() {
  const data = JSON.parse(fs.readFileSync(latestDetails(), 'utf8'));
  const details = data.details || [];
  console.log(`评论主方向(你定):${DIRECTION}\n`);
  console.log(`对 ${details.length} 条目标笔记逐条生成评论(开发期由 Claude 充当 LLM):\n`);

  const queue = [];
  details.forEach((d, i) => {
    const comment = GEN[i] || '(未生成)';
    const comp = check(comment);
    const agentReject = rejectsAgent((d.title || '') + ' ' + (d.desc || ''));
    console.log(`【${i + 1}】${d.title || '(无标题)'}  · ${d.author} · 评${d.comments}`);
    console.log(`  生成评论:${comment}`);
    console.log(`  合规检查:${comp.ok ? '✓ 通过(无明文联系方式)' : '✗ 拦截 → ' + comp.violations.map((v) => v.hint).join('、')}`);
    if (agentReject) console.log('  ⚠ 该帖明确"中介勿扰" → 建议跳过,或确认为个人房东身份再发');
    console.log('');
    if (comp.ok && !agentReject) queue.push({ id: d.id, url: d.url, title: d.title, comment });
  });

  const out = path.join(TMP, `to-send-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ direction: DIRECTION, count: queue.length, queue }, null, 2));
  console.log('================= 小结 =================');
  console.log(`生成 ${details.length} 条 · 合规通过 ${details.filter((d, i) => check(GEN[i] || '').ok).length} 条 · 排斥中介需人工确认 ${details.filter((d) => rejectsAgent((d.title || '') + (d.desc || ''))).length} 条`);
  console.log(`→ 可直接进入发送队列(合规且非中介勿扰):${queue.length} 条,已存 ${path.basename(out)}`);
  console.log('\n这一步接真 LLM 时:把 GEN 换成 generateComment(note, DIRECTION) 调火山/百炼,合规检查这层不变。');
}

main();
