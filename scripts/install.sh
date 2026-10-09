#!/bin/sh
# claudeAgent를 맥에 설치하고 로그인할 때마다 켜지게 한다. (notify-agent의 scripts/install.sh와 같은 규칙)
#
#   npm run build:bin -- darwin_arm64   # 먼저 이 맥에 맞는 실행 파일을 만든다(인텔 맥은 darwin_amd64)
#   ./scripts/install.sh                설치(또는 새 판으로 바꾸기)
#   ./scripts/install.sh --uninstall    지우기
#
# 설치 뒤 한 번은 사람이 해야 한다:
#   1) Claude Code CLI(claude)를 깔고 로그인
#   2) ~/.config/claudeAgent/.env 에 RELAY_URL·RELAY_AGENT_TOKEN(relay-service .env와 같은 값)과
#      AGENT_ALLOWED_ROOTS를 적고 다시 켜기: launchctl kickstart -k gui/$(id -u)/com.foncsoft.claudeAgent
set -eu

LABEL=com.foncsoft.claudeAgent
BIN_DIR="$HOME/.local/bin"
BIN="$BIN_DIR/claudeAgent"
# .env와 세션 기록(data/)은 실행한 폴더 기준이다. 이 폴더에서 띄운다.
CONF_DIR="$HOME/.config/claudeAgent"
ENV_FILE="$CONF_DIR/.env"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/claudeAgent.log"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$BIN"
  echo "지웠습니다. 설정·세션 기록($CONF_DIR)과 로그($LOG)는 남겨 둡니다."
  exit 0
fi

cd "$(dirname "$0")/.."
case "$(uname -m)" in
  arm64) TARGET=darwin_arm64 ;;
  *) TARGET=darwin_amd64 ;;
esac
SRC="release/$TARGET/claudeAgent"
[ -x "$SRC" ] || { echo "먼저 npm run build:bin -- $TARGET 하세요." >&2; exit 1; }

mkdir -p "$BIN_DIR" "$CONF_DIR" "$(dirname "$PLIST")"
cp "$SRC" "$BIN"

if [ ! -f "$ENV_FILE" ]; then
  KEY=$(openssl rand -hex 24)
  sed "s/^AGENT_API_KEY=.*/AGENT_API_KEY=$KEY/" .env.example > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "설정 파일을 만들었습니다: $ENV_FILE"
  echo "RELAY_URL·RELAY_AGENT_TOKEN·AGENT_ALLOWED_ROOTS를 적고 다시 켜세요."
fi

# launchd의 PATH에는 셸 설정(nvm·homebrew)이 없다. 세션이 claude를 찾을 수 있게 지금 찾은 자리를 넣는다.
CLAUDE=$(command -v claude || true)
if [ -z "$CLAUDE" ]; then
  echo "claude를 찾지 못했습니다. Claude Code CLI를 깔고 이 스크립트를 다시 돌리세요." >&2
fi
CLAUDE_DIR=$(dirname "${CLAUDE:-/usr/local/bin/claude}")
PATH_VALUE="$CLAUDE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>WorkingDirectory</key><string>$CONF_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH_VALUE</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "켰습니다. 로그: $LOG"
