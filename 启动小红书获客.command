#!/bin/zsh
# 双击本文件即可启动「小红书获客」桌面应用。
# 启动后会弹出应用窗口;这个终端窗口保持开着 = 程序在运行,关掉应用后可关闭它。

export PATH="/opt/homebrew/bin:$PATH"
cd "/Users/liufeng/Documents/项目/小红书自动获取线索/client" || { echo "找不到项目目录"; exit 1; }

# 关掉可能残留的旧实例,避免端口被占
pkill -f "electron/main.js" 2>/dev/null
sleep 1

echo "正在启动小红书获客…(首次启动稍等几秒,窗口会自动弹出)"
npm run app
