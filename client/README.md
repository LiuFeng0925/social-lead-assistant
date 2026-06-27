# 客户端 · M1:接管浏览器 + 检索

第一期评论闭环的第一个里程碑。验证整个项目最大的未知数:**"借真实页面的手取数,在小红书到底灵不灵"**。

## 它做什么

接管你**已登录小红书的真实 Chrome** → 导航到搜索结果页 → 等待渲染 + 滚动 → 解析第一屏笔记(标题/作者/链接)→ 打印 + 存一张截图。

搜索结果是**页面自己用 `x-s/x-t` 签名请求并渲染**的,我们只读 DOM —— 不逆向签名(与需求/架构一致)。

## 怎么跑(3 步)

```bash
# 0) 装依赖(只需一次)
cd client && npm install

# 1) 用调试端口启动 Chrome(会用独立 profile 打开小红书)
npm run launch
#    首次:在打开的窗口里手动登录小红书,登录一次以后这个 profile 会记住

# 2) 跑 M1(换成你想搜的关键词)
npm run m1 -- "朝阳 租房"
```

跑完会:
- 打印解析到的笔记列表(标题/作者/链接)
- 打印一段「诊断」(当前 URL、是否要登录、找到多少笔记锚点等)
- 在 `client/tmp/` 存一张当时页面的截图

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/cdp/cdp-fetch.js` | CDP 底层连接(原生 http + ws),搬自 BOSS |
| `src/cdp/xhs-cdp-client.js` | 精简 CDP 客户端:导航 / 执行JS / 截图 |
| `src/m1-search.js` | M1 主流程:接管 → 搜 → 解析 → 打印 |
| `scripts/launch-chrome.sh` | 用调试端口启动 Chrome |

## 配置(环境变量)

| 变量 | 默认 | 说明 |
|---|---|---|
| `XHS_CDP_ENDPOINT` | `http://127.0.0.1:9222` | CDP 端口地址 |
| `XHS_CHROME_PROFILE` | `~/.xhs-chrome-profile` | Chrome 用户数据目录(登录态存这) |
| `XHS_CDP_PORT` | `9222` | 调试端口 |
| `XHS_CHROME_BIN` | macOS 默认 Chrome 路径 | Chrome 可执行文件 |

## 如果没解析到笔记

把终端打印的「诊断」段发回来。常见原因 + 对策:
- `needLogin: true` → 在那个 Chrome 里先登录小红书。
- `anchorCount: 0` 但页面正常 → 小红书改了 DOM 结构,据截图调选择器,或改走"注入 fetch 直接拿 JSON"。
- 连不上(`no_page_target` / 连接错误)→ Chrome 没用调试端口启动,重跑 `npm run launch`。
