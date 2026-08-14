#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# IVR prompts.
#
# The dialplan looks for custom/ivr-main and custom/ivr-closed.  Asterisk's
# bundled sound library has no phrase resembling "press 1 for sales", so these
# have to come from somewhere else.  This script offers two ways:
#
#   1. Synthesise them with espeak-ng (fine for testing, obviously robotic)
#   2. Convert audio you recorded yourself (what you want in production)
#
# Asterisk plays 8kHz mono; anything else is resampled on every call, which
# costs CPU and sounds worse than converting once here.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/infra/asterisk/sounds/custom"
COMPOSE="${COMPOSE:-docker compose}"

MAIN_TEXT="${MAIN_TEXT:-Thank you for calling. For sales, press 1. For support, press 2. To dial an extension directly, press 3. To speak with an operator, press 0, or stay on the line.}"

usage() {
    cat <<'EOF'
Usage:
  scripts/generate-prompts.sh synth            Synthesise prompts with espeak-ng
  scripts/generate-prompts.sh convert <file>   Convert a recording to ivr-main
  scripts/generate-prompts.sh install          Copy prompts into the container

Environment:
  MAIN_TEXT   Override the synthesised main-menu wording

After installing, set IVR_ENABLED=true in .env and run `make reload`.
EOF
}

need() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "error: $1 is required for this command" >&2
        echo "       Debian/Ubuntu: sudo apt install $2" >&2
        echo "       macOS:         brew install $2" >&2
        exit 1
    }
}

# Asterisk is happiest with signed 16-bit 8kHz mono WAV; it reads .wav
# directly and the quality loss versus .gsm is worth the disk space.
to_asterisk_wav() {
    local src="$1" dst="$2"
    sox "$src" -r 8000 -c 1 -b 16 -e signed-integer "$dst" 2>/dev/null \
        || ffmpeg -loglevel error -y -i "$src" -ar 8000 -ac 1 -c:a pcm_s16le "$dst"
}

cmd_synth() {
    need espeak-ng espeak-ng
    need sox sox
    mkdir -p "$OUT_DIR"

    echo "Synthesising the main menu..."
    espeak-ng -v en-us -s 145 -w "$OUT_DIR/.raw-main.wav" "$MAIN_TEXT"
    to_asterisk_wav "$OUT_DIR/.raw-main.wav" "$OUT_DIR/ivr-main.wav"
    rm -f "$OUT_DIR/.raw-main.wav"

    echo "Wrote $OUT_DIR/ivr-main.wav"
    echo "This is a synthesised voice — replace it before customers hear it."
    echo "Next: scripts/generate-prompts.sh install"
}

cmd_convert() {
    local src="${1:-}"
    [[ -n "$src" ]] || { usage; exit 1; }
    [[ -f "$src" ]] || { echo "error: no such file: $src" >&2; exit 1; }

    command -v sox >/dev/null 2>&1 || command -v ffmpeg >/dev/null 2>&1 || {
        echo "error: this needs either sox or ffmpeg installed" >&2
        exit 1
    }

    mkdir -p "$OUT_DIR"
    to_asterisk_wav "$src" "$OUT_DIR/ivr-main.wav"
    echo "Wrote $OUT_DIR/ivr-main.wav from $src"
    echo "Next: scripts/generate-prompts.sh install"
}

cmd_install() {
    if [[ ! -d "$OUT_DIR" ]] || [[ -z "$(ls -A "$OUT_DIR" 2>/dev/null)" ]]; then
        echo "error: no prompts in $OUT_DIR — run 'synth' or 'convert' first" >&2
        exit 1
    fi

    # Sounds live inside the image rather than in a mount, so prompts are
    # copied in and must be re-copied after a rebuild.
    #
    # Both locations, deliberately: Asterisk resolves a relative sound name
    # against the data directory (/usr/share/asterisk/sounds/<lang>), while
    # Debian-family packages also ship a custom directory under the variable
    # data directory. Which one wins varies by build, the files are a few
    # kilobytes, and a prompt that cannot be found means callers hear silence
    # where the menu should be.
    for target in /usr/share/asterisk/sounds/en/custom /var/lib/asterisk/sounds/custom; do
        $COMPOSE exec -T asterisk mkdir -p "$target"
        for file in "$OUT_DIR"/*; do
            echo "  installing $(basename "$file") -> $target"
            $COMPOSE cp "$file" "asterisk:$target/$(basename "$file")"
        done
        $COMPOSE exec -T asterisk chown -R asterisk:asterisk "$target"
    done

    echo
    echo "Installed.  Now set IVR_ENABLED=true in .env and run: make reload"
}

case "${1:-}" in
    synth) cmd_synth ;;
    convert) shift; cmd_convert "${1:-}" ;;
    install) cmd_install ;;
    *) usage; exit 1 ;;
esac
