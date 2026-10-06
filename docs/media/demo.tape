# Real terminal demo of the published @cochon123/cli2api package.
# The mock adapter is used because Codex, OpenCode, Cursor Agent, and Claude
# Code are not authenticated in this environment. Every command is executed.
#
# npm_config_prefix keeps the global install in the user directory so the
# documented `npm install --global` command can run without root.

Output docs/media/demo.gif

Require npm
Require curl
Require jq

Set Shell bash
Set FontFamily "JetBrains Mono"
Set FontSize 16
Set Width 880
Set Height 900
Set Padding 18
Set LineHeight 1.2
Set Theme "Catppuccin Mocha"
Set TypingSpeed 18ms
Set Framerate 10
Set WindowBar Colorful
Set CursorBlink false

Env npm_config_prefix "/home/ubuntu/.local"
Env npm_config_update_notifier "false"

Hide
Type `export PATH="$HOME/.local/bin:$PATH"`
Enter
Type `export PS1='$ '`
Enter
Type `mkdir -p "$HOME/demo" && cd "$HOME/demo"`
Enter
Type `pkill -f 'node .*cli2api' >/dev/null 2>&1 || true`
Enter
Type `npm uninstall --global @cochon123/cli2api >/dev/null 2>&1 || true`
Enter
Type "clear"
Enter
Show

Type "npm install --global @cochon123/cli2api"
Enter
Wait+Screen@20s /added .+ package/
Sleep 800ms

Type "cli2api --version"
Enter
Wait+Screen /0\.1\.0/
Sleep 600ms

Type "cli2api doctor --adapter mock"
Enter
Wait+Screen /no binary required/
Sleep 900ms

Type "CLI2API_TOKEN=dev-secret cli2api serve --adapter mock --port 3927 &"
Enter
Wait+Screen /Env swap/
Sleep 1s

Type@12ms `curl -sS http://127.0.0.1:3927/v1/chat/completions \`
Enter
Type@12ms `  -H "Authorization: Bearer dev-secret" \`
Enter
Type@12ms `  -H "Content-Type: application/json" \`
Enter
Type@12ms `  -d '{"model":"mock/echo","messages":[{"role":"user","content":"ping"}]}' \`
Enter
Type@12ms "  | jq ."
Enter
Sleep 2.5s

Hide
Type "kill %1 >/dev/null 2>&1 || true"
Enter
