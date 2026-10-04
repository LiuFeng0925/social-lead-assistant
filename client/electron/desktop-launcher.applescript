on run
	set launcherRoot to "/Users/wuhaotian/Documents/ChatGPT/自动获客/social-lead-assistant/client"
	set launcherNodeDir to "/Users/wuhaotian/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
	set launchState to do shell script "if pgrep -f '^.*Electron electron/main\\.js$' >/dev/null; then echo yes; fi"
	if launchState is "yes" then
		tell application "Electron" to activate
	else
		do shell script "cd " & quoted form of launcherRoot & " && PATH=" & quoted form of (launcherNodeDir & ":/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin") & " env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron electron/main.js >/tmp/xhs-lead-launcher.log 2>&1 &"
	end if
end run
