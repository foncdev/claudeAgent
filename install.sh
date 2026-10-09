#!/bin/sh
#
# claudeAgent 설치 스크립트. (terminal-agent의 install.sh와 같은 규칙)
#
#   curl -fsSL https://raw.githubusercontent.com/foncdev/claudeAgent/main/install.sh | sh
#
# GitHub Release에서 이 기기에 맞는 바이너리를 받아 설치한다.
#
# 이 방식으로 받으면 macOS 격리 속성(quarantine)이 붙지 않아
# Gatekeeper 경고 없이 바로 실행된다. 브라우저로 직접 받으면 경고가 뜬다.
#
# 환경변수로 바꿀 수 있는 것:
#   VERSION   받을 버전 (기본: 최신 릴리스)
#   BIN_DIR   설치 위치 (기본: /usr/local/bin, 권한 없으면 ~/.local/bin)

set -eu

REPO="foncdev/claudeAgent"
BIN="claudeAgent"

# --- 출력 ---

# 터미널이면 색을 쓰고, 파이프면 쓰지 않는다.
if [ -t 1 ]; then
	c_dim='\033[2m'; c_red='\033[31m'; c_grn='\033[32m'; c_off='\033[0m'
else
	c_dim=''; c_red=''; c_grn=''; c_off=''
fi

say()  { printf '%b\n' "$*"; }
info() { printf '%b\n' "${c_dim}  $*${c_off}"; }
ok()   { printf '%b\n' "${c_grn}✓${c_off} $*"; }
die()  { printf '%b\n' "${c_red}✗${c_off} $*" >&2; exit 1; }

# --- 플랫폼 확인 ---

detect_os() {
	case "$(uname -s)" in
		Darwin) echo darwin ;;
		Linux)  echo linux ;;
		*) die "지원하지 않는 운영체제입니다: $(uname -s)
  윈도우는 Release 페이지에서 .exe를 직접 받으세요.
  https://github.com/$REPO/releases" ;;
	esac
}

detect_arch() {
	case "$(uname -m)" in
		arm64|aarch64) echo arm64 ;;
		x86_64|amd64)  echo amd64 ;;
		*) die "지원하지 않는 아키텍처입니다: $(uname -m)" ;;
	esac
}

# --- 필요한 도구 ---

need() {
	command -v "$1" >/dev/null 2>&1 || die "$1 이 필요합니다."
}

# 받기. curl이 없으면 wget을 쓴다.
fetch() {
	url="$1"; out="$2"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$url" -o "$out"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO "$out" "$url"
	else
		die "curl 또는 wget이 필요합니다."
	fi
}

fetch_stdout() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$1"
	else
		wget -qO- "$1"
	fi
}

# --- 최신 버전 찾기 ---

latest_version() {
	# GitHub API에서 최신 릴리스 태그를 뽑는다.
	# jq 없이 sed만으로 처리해 의존성을 늘리지 않는다.
	fetch_stdout "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
		sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
		head -1
}

# --- 설치 위치 ---

pick_bin_dir() {
	if [ -n "${BIN_DIR:-}" ]; then
		echo "$BIN_DIR"
		return
	fi
	# 쓸 수 있으면 /usr/local/bin, 아니면 홈 아래.
	if [ -w /usr/local/bin ] 2>/dev/null; then
		echo /usr/local/bin
	elif [ "$(id -u)" = "0" ]; then
		echo /usr/local/bin
	else
		echo "$HOME/.local/bin"
	fi
}

# --- 본체 ---

main() {
	need tar

	os=$(detect_os)
	arch=$(detect_arch)

	version="${VERSION:-}"
	if [ -z "$version" ]; then
		info "최신 버전 확인 중…"
		version=$(latest_version)
		[ -n "$version" ] || die "최신 버전을 찾지 못했습니다.
  아직 릴리스가 없거나 네트워크 문제일 수 있습니다.
  https://github.com/$REPO/releases 를 확인하세요."
	fi

	asset="${BIN}_${os}_${arch}.tar.gz"
	url="https://github.com/$REPO/releases/download/$version/$asset"

	say "claudeAgent $version ($os/$arch)"

	tmp=$(mktemp -d)
	# 중간에 실패해도 임시 파일을 남기지 않는다.
	trap 'rm -rf "$tmp"' EXIT INT TERM

	info "내려받는 중…"
	fetch "$url" "$tmp/$asset" || die "받지 못했습니다: $url
  그 버전에 이 플랫폼 파일이 없을 수 있습니다."

	# 체크섬이 있으면 확인한다. 없어도 설치는 진행한다.
	if fetch "https://github.com/$REPO/releases/download/$version/checksums.txt" \
		"$tmp/checksums.txt" 2>/dev/null; then
		if command -v shasum >/dev/null 2>&1; then
			sum=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)
		elif command -v sha256sum >/dev/null 2>&1; then
			sum=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
		else
			sum=""
		fi
		if [ -n "$sum" ]; then
			want=$(grep "$asset" "$tmp/checksums.txt" 2>/dev/null | cut -d' ' -f1 | head -1)
			if [ -n "$want" ] && [ "$sum" != "$want" ]; then
				die "체크섬이 맞지 않습니다. 받다 만 파일일 수 있습니다."
			fi
			[ -n "$want" ] && info "체크섬 확인됨"
		fi
	fi

	tar -xzf "$tmp/$asset" -C "$tmp" || die "압축을 풀지 못했습니다."
	[ -f "$tmp/$BIN" ] || die "압축 안에 $BIN 이 없습니다."
	chmod +x "$tmp/$BIN"

	dir=$(pick_bin_dir)
	mkdir -p "$dir" 2>/dev/null || true

	if [ -w "$dir" ]; then
		mv "$tmp/$BIN" "$dir/$BIN"
	else
		info "$dir 에 쓰려면 관리자 권한이 필요합니다."
		sudo mv "$tmp/$BIN" "$dir/$BIN" || die "설치에 실패했습니다."
	fi

	ok "설치됨: $dir/$BIN"

	# PATH에 없으면 알려준다. 설치하고 안 되는 게 제일 답답하다.
	case ":$PATH:" in
		*":$dir:"*) ;;
		*)
			say ""
			say "${c_dim}PATH에 $dir 이 없습니다. 셸 설정에 추가하세요:${c_off}"
			say "  export PATH=\"$dir:\$PATH\""
			;;
	esac

	say ""
	say "다음 단계:"
	say "  1. Claude Code CLI(claude)를 깔고 로그인합니다"
	say "  2. 실행할 폴더에 .env를 만듭니다"
	say "     ${c_dim}AGENT_ALLOWED_ROOTS, RELAY_URL, RELAY_AGENT_TOKEN 을 적습니다${c_off}"
	say "  3. 그 폴더에서 실행합니다"
	say "     ${c_dim}claudeAgent${c_off}"
	say ""
	say "${c_dim}자세한 설명: https://github.com/$REPO#실행-파일로-받기${c_off}"
}

main "$@"
