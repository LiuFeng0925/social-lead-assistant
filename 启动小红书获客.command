#!/bin/zsh
# 双击本文件即可启动「小红书获客」桌面应用。
# 启动后会弹出应用窗口;这个终端窗口保持开着 = 程序在运行,关掉应用后可关闭它。

export PATH="/opt/homebrew/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$SCRIPT_DIR/.node/bin:$PATH"
cd "$SCRIPT_DIR/client" || { echo "找不到项目目录"; exit 1; }

# 关掉可能残留的旧实例,避免端口被占
pkill -f "electron/main.js" 2>/dev/null
sleep 1

# 清除 ELECTRON_RUN_AS_NODE,否则 electron 会以普通 Node.js 模式运行
# 导致 require('electron') 返回路径字符串而非 API 对象
unset ELECTRON_RUN_AS_NODE

echo "正在启动小红书获客…(首次启动稍等几秒,窗口会自动弹出)"
npm run app
