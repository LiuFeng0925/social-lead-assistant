'use strict';
// 国产 LLM,可切换 provider。火山方舟 / 阿里百炼都兼容 OpenAI 的 chat/completions 协议。
// 默认不开;在「任务设置」填 provider + model + api_key 并勾选启用后,评论改由大模型按对方正文+你的方向生成。
const https = require('https');

const PROVIDERS = {
  ark: { host: 'ark.cn-beijing.volces.com', path: '/api/v3/chat/completions', label: '火山方舟(豆包)' },
  dashscope: { host: 'dashscope.aliyuncs.com', path: '/compatible-mode/v1/chat/completions', label: '阿里百炼(通义)' },
};

function postChat({ host, path, apiKey, body, timeoutMs = 12000 }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      host, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Content-Length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode >= 400) return reject(new Error('LLM ' + res.statusCode + ': ' + (j.error && j.error.message || data).slice(0, 200)));
          resolve(j);
        } catch (e) { reject(new Error('LLM 返回解析失败: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('LLM 超时')); });
    req.write(payload);
    req.end();
  });
}

// 按对方笔记 + 方向,让大模型生成一句拟人评论
async function genComment({ note, direction, provider, model, apiKey }) {
  const ep = PROVIDERS[provider] || PROVIDERS.ark;
  const title = (note && note.title) || '';
  const desc = ((note && note.desc) || '').slice(0, 600);
  const tags = ((note && note.tags) || []).join(' ');
  const sys = '你是帮租房中介在小红书做获客的助手。读对方的求租笔记,写一句自然、口语化、像真人随手回的评论,呼应对方的具体诉求(地区/户型/预算/通勤等),态度友好,引导对方看你主页或私聊。硬性红线:绝对不能出现微信号、手机号、二维码、任何外链或"加我"等明示联系方式;不超过 50 字;只输出评论本身,不要引号、不要解释。';
  const user = '【对方笔记标题】' + title + '\n【正文】' + desc + '\n【标签】' + tags + '\n【我的方向/卖点】' + (direction || '友好回应,引导看主页/私聊') + '\n请按上面要求写这一句评论。';
  const j = await postChat({
    host: ep.host, path: ep.path, apiKey,
    body: { model: model || '', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0.9, max_tokens: 120 },
  });
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!txt) throw new Error('LLM 没返回内容');
  return String(txt).trim().replace(/^["「『]|["」』]$/g, '').trim();
}

module.exports = { genComment, PROVIDERS };
