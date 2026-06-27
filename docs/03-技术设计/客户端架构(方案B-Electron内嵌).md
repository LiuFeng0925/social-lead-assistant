# 客户端架构(技术设计)· 方案 B:Electron 内嵌浏览器

> 上游:需求文档 v0.2 · 产品架构 v0.1。本文档定客户端**怎么实现**,核心是**客户端形态**这一决策。
> 决策日期:2026-06-26 ｜ 状态:已钉死

---

## 0 一句话

客户端 = **Electron 桌面应用,内嵌浏览器(`BrowserView`)加载小红书**。运营**装一个包、打开即用、浏览器嵌在窗口里直接操作**(扫码登录/点击都在里面)。引擎通过内嵌浏览器的 **CDP 接口**驱动,复用现有"检索→匹配→生成→评论"逻辑。

---

## 1 为什么选 B(内嵌),否决其它

| 形态 | 好用性 | 反检测 | 结论 |
|---|---|---|---|
| **B Electron 内嵌浏览器** | ✅ 装一个包、双击即用、**一个窗口**、直接操作 | ⚠ 内嵌 Chromium 指纹需 stealth 补 | ✅ **选它** |
| A 外部驱动真实 Chrome | ❌ 也要装驱动 + 繁琐启动(调试端口/独立 profile)+ **两个窗口**(浏览器嵌不进去) | ✅ 真实 Chrome 指纹最真 | 否决:运营用不了 |
| 浏览器插件 | 一般 | ❌ 注入事件 `isTrusted=false` **最易被识破**;后台能力受限 | 否决:扛不起重型自动化 |
| 纯云端 | — | ❌ 云够不着本地浏览器(反检测要本地真实 Chrome + 住宅 IP) | 否决:架构矛盾;云只能做汇总看板 |

**决定性理由**:产品给**不懂技术的中介运营**用,**必须开箱即用** → 只能 B。
**硬约束**:驱动浏览器的程序**必须在用户本地**(反检测靠本地真实环境 + 住宅 IP);云端只做薄后台汇总。

---

## 2 架构

```
┌──────────────── Electron 桌面应用(一个窗口) ────────────────┐
│  主进程 main:                                                │
│   · 窗口 / BrowserView 管理                                   │
│   · 引擎调度(检索→匹配→生成→评论)                            │
│   · 本地 SQLite(笔记/评论/线索)                              │
│   · 防封控制(限频/养号/刹车)                                 │
│   · 向云后台上报(Token)                                      │
│                                                              │
│  渲染进程 renderer:控制台 UI(复用现有 app.html 那套)        │
│  ┌──────────────┐  ┌──────────────────────────────────┐     │
│  │ 左侧菜单+控制台│  │ BrowserView:内嵌浏览器          │     │
│  │ (renderer)    │  │  加载小红书,用户可直接操作       │     │
│  │               │  │  引擎也通过它的 CDP 驱动         │     │
│  └──────────────┘  └──────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
                          ↕ CDP(webContents.debugger)
              内嵌浏览器自己生成 x-s/x-t 签名,绕签名墙
```

- **BrowserView 是核心**:既是"实时监控"(直接可见,不用投屏),又是被驱动的浏览器,**用户随时能自己点/扫码**(真实交互 `isTrusted=true`,天然拟人)。
- **引擎驱动方式**:`browserView.webContents.debugger`(Electron 内置 CDP),或附加远程调试端口走现有 CDP-over-WebSocket。命令集和现在一样(`Runtime.evaluate`/`Page.navigate`/`Input.*`)。

---

## 3 与当前开发版的对应(复用什么 / 改什么)

| 当前(外部 Chrome + 投屏) | 改造后(Electron 内嵌) | 复用度 |
|---|---|---|
| `engine.js`(检索/扫全/读正文) | 几乎直接复用(换 CDP 连接对象) | 🟢 高 |
| `match.js` / `compliance.js` / `db.js` / 生成 | **直接复用**(浏览器无关的纯逻辑) | 🟢 100% |
| `cdp-fetch` + `XhsCdpClient`(连外部 Chrome) | 换成连 `BrowserView` 的 `webContents.debugger` | 🟡 改连接层 |
| `app.html`(网页控制台) | 搬进 Electron renderer(HTML/JS 直接用) | 🟢 高 |
| `screencast` 投屏 + 画面点击 | **删掉**(BrowserView 直接显示、直接点) | 🔴 去掉 |
| `server.js`(本地 HTTP+SSE) | 收进 Electron 主进程(IPC 替代 HTTP) | 🟡 重组 |

**结论:现有"检索→评论闭环"是浏览器无关的逻辑,换浏览器载体不白做**;主要新增是 Electron 壳 + BrowserView 接入 + UI 迁移。

---

## 4 反检测:B 的代价 + 对策(记入反检测清单第 6 类)

内嵌 Chromium 默认有自动化痕迹,要补:
- ⬜ 设真实 `user-agent`(对齐常见 Chrome 版本)
- ⬜ `navigator.webdriver = false`、关掉 AutomationControlled
- ⬜ 启动即注入 stealth 脚本(`addScriptToEvaluateOnNewDocument`)
- ⬜ 一账号一应用实例一机器、住宅 IP
- 🟢 优势:用户直接操作的部分天然 `isTrusted=true`,比纯自动化更像人

---

## 5 改造路线(分步,开发期命令启动、不打包)

1. **Electron 骨架**:`main.js` + `renderer`,`electron .` 弹出窗口。
2. **内嵌 BrowserView + CDP 验证**:加载小红书,用 `webContents.debugger` 跑一次 `evaluate` 取数据(最小验证,像 M1 打一枪)。
3. **迁移引擎**:CDP 连接对象从"外部 Chrome"换成"BrowserView",检索/匹配/生成/评论跑通。
4. **控制台 UI**:`app.html` → renderer,IPC 替代 HTTP/SSE。
5. **监控**:去投屏,BrowserView 直接显示在窗口右侧。
6. **stealth + 账号/IP 隔离**。
7. **打包**:`electron-builder` 出 `.dmg`/`.exe`(可复用 BOSS 的打包配置)。

---

## 6 开发 vs 交付

- **开发期**:命令启动(`electron .` / `npm run dev`),**不用打包**,改代码即时看。
- **交付期**:`electron-builder` 打包成安装包,运营双击安装、开箱即用。

---

*技术设计 · 客户端架构(方案 B)｜ 2026-06-26 ｜ 决策已钉死,改动以本文件为准*
