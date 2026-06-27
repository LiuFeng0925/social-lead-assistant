#!/usr/bin/env bash
# 用调试端口启动 Chrome —— M1 的客户端会接管这个浏览器做自动化。
# 关键:用一个独立 profile;第一次启动后在打开的窗口里手动登录小红书,之后复用。
#
# 用法:bash scripts/launch-chrome.sh    (或 npm run launch)

set -e

PROFILE="${XHS_CHROME_PROFILE:-$HOME/.xhs-chrome-profile}"
PORT="${XHS_CDP_PORT:-9222}"
CHROME="${XHS_CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [ ! -x "$CHROME" ]; then
  echo "✗ 找不到 Chrome:$CHROME"
  echo "  用 XHS_CHROME_BIN 环境变量指定 Chrome 可执行文件路径再试。"
  exit 1
fi

echo "启动 Chrome —— 调试端口 $PORT,profile:$PROFILE"
"$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  "https://www.xiaohongshu.com" >/dev/null 2>&1 &

echo "✓ 已在后台启动。首次请在打开的窗口里登录小红书,登录后再运行:npm run m1 -- \"朝阳 租房\""
