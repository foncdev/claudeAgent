#!/usr/bin/env bash
# claudeAgent를 실행 파일 하나로 묶는다. 받는 쪽은 Node·npm install·빌드 없이 바로 실행한다.
# (Claude Code CLI(`claude`)는 따로 깔려 있어야 한다 — 세션은 그걸 띄운다.)
#
#   npm run build:bin                 # 모든 대상
#   npm run build:bin -- darwin_arm64
#
# 결과(terminal-agent·notify-agent와 같은 이름 규칙 — install.sh가 이 이름을 쓴다):
#   release/claudeAgent_<os>_<arch>.tar.gz   안에 claudeAgent(윈도우는 claudeAgent.exe)와 README.md
#   release/<os>_<arch>/claudeAgent          묶기 전 실행 파일(scripts/install.sh가 쓴다)
#   release/checksums.txt
#
# 맥용 서명·공증(다른 맥에서 '확인되지 않은 개발자'로 막히지 않게):
#   DEVELOPER_ID="Developer ID Application: 이름 (TEAMID)" NOTARY_PROFILE=notary npm run build:bin
#   준비는 mac-agent/scripts/release.sh 머리말과 같다(인증서, notarytool store-credentials).
#   맨 실행 파일은 공증표를 붙일(staple) 수 없어, 처음 실행할 때 맥이 온라인으로 공증을 확인한다.
set -euo pipefail
cd "$(dirname "$0")/.."

BIN=claudeAgent
TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=(darwin_arm64 darwin_amd64 linux_amd64 linux_arm64 windows_amd64)
fi

# Bun의 대상 이름(x64)과 릴리스 이름(amd64)을 잇는다.
bun_target() {
  local os=${1%_*} arch=${1#*_}
  [ "$arch" = amd64 ] && arch=x64
  echo "bun-$os-$arch"
}

mkdir -p release
for t in "${TARGETS[@]}"; do
  out_dir="release/$t"
  exe="$BIN"
  [[ "$t" == windows_* ]] && exe="$BIN.exe"
  rm -rf "$out_dir" && mkdir -p "$out_dir"
  bun build src/bin.ts --compile --minify --target="$(bun_target "$t")" --outfile "$out_dir/$exe"

  if [[ "$t" == darwin_* && -n "${DEVELOPER_ID:-}" ]]; then
    codesign --force --options runtime --timestamp \
      --entitlements scripts/bun.entitlements --sign "$DEVELOPER_ID" "$out_dir/$exe"
    codesign --verify --strict --verbose=2 "$out_dir/$exe"
    if [ -n "${NOTARY_PROFILE:-}" ]; then
      (cd "$out_dir" && zip -q notarize.zip "$exe")
      xcrun notarytool submit "$out_dir/notarize.zip" --keychain-profile "$NOTARY_PROFILE" --wait
      rm "$out_dir/notarize.zip"
    fi
  fi

  cp README.md "$out_dir/"
  tar -czf "release/${BIN}_$t.tar.gz" -C "$out_dir" "$exe" README.md
  rm "$out_dir/README.md"
  echo "→ release/${BIN}_$t.tar.gz"
done

(cd release && shasum -a 256 "${BIN}"_*.tar.gz > checksums.txt)
