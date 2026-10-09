#!/usr/bin/env bash
# claudeAgent를 실행 파일 하나로 묶는다. 받는 쪽은 Node·npm install·빌드 없이 바로 실행한다.
# (Claude Code CLI(`claude`)는 따로 깔려 있어야 한다 — 세션은 그걸 띄운다.)
#
#   npm run build:bin            # 모든 대상
#   npm run build:bin -- darwin-arm64
#
# 맥용 서명·공증(다른 맥에서 '확인되지 않은 개발자'로 막히지 않게):
#   DEVELOPER_ID="Developer ID Application: 이름 (TEAMID)" NOTARY_PROFILE=notary npm run build:bin
#   준비는 mac-agent/scripts/release.sh 머리말과 같다(인증서, notarytool store-credentials).
#   맨 실행 파일은 공증표를 붙일(staple) 수 없어, 처음 실행할 때 맥이 온라인으로 공증을 확인한다.
#
# 결과: release/claude-agent-<버전>-<대상>(.exe)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64)
fi

mkdir -p release
for t in "${TARGETS[@]}"; do
  ext=""
  [[ "$t" == windows-* ]] && ext=".exe"
  out="release/claude-agent-$VERSION-$t$ext"
  bun build src/bin.ts --compile --minify --target="bun-$t" --outfile "$out"
  if [[ "$t" == darwin-* && -n "${DEVELOPER_ID:-}" ]]; then
    codesign --force --options runtime --timestamp \
      --entitlements scripts/bun.entitlements --sign "$DEVELOPER_ID" "$out"
    codesign --verify --strict --verbose=2 "$out"
    if [ -n "${NOTARY_PROFILE:-}" ]; then
      zip -j -q "$out.zip" "$out"
      xcrun notarytool submit "$out.zip" --keychain-profile "$NOTARY_PROFILE" --wait
      rm "$out.zip"
    fi
  fi
  echo "→ $out"
done

(cd release && shasum -a 256 claude-agent-"$VERSION"-* > SHA256SUMS)
