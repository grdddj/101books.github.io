#!/usr/bin/env bash
#
# Regenerate the PWA icons in reader/static/icons/ with ImageMagick.
# The motif is the top-left corner of a goban with a small stone cluster;
# the grid lines deliberately run off the canvas so it reads as a board.
#
#   ./tools/generate-icons.sh
#
set -euo pipefail

OUT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/reader/static/icons
mkdir -p "${OUT_DIR}"

BOARD="#e0b563"
LINE="#5b4426"
BLACK="#1b1b1b"
WHITE="#fbfaf7"

number() { awk "BEGIN{printf \"%.1f\", $1}"; }

# draw_icon <size> <output> <margin-fraction> <spacing-fraction>
draw_icon() {
    local size=$1 output=$2 margin_fraction=$3 spacing_fraction=$4

    local margin spacing stroke stone_stroke stone_radius hoshi_radius
    margin=$(number "${size} * ${margin_fraction}")
    spacing=$(number "${size} * ${spacing_fraction}")
    stroke=$(number "${size} / 512 * 7")
    stone_stroke=$(number "${size} / 512 * 4")
    stone_radius=$(number "${spacing} * 0.46")
    hoshi_radius=$(number "${size} / 512 * 11")

    # Coordinate of grid intersection <index>; index 0 is the board edge.
    at() { number "${margin} + ${spacing} * $1"; }
    # MVG has no radius argument: a circle is centre plus a point on the rim.
    stone() { printf "circle %s,%s %s,%s" "$1" "$2" "$(number "$1 + $3")" "$2"; }

    local mvg="fill '${BOARD}' stroke none rectangle 0,0 ${size},${size}"
    mvg+=" stroke '${LINE}' stroke-width ${stroke} fill none"
    for index in 0 1 2 3 4; do
        mvg+=" line $(at 0),$(at "${index}") ${size},$(at "${index}")"
        mvg+=" line $(at "${index}"),$(at 0) $(at "${index}"),${size}"
    done
    mvg+=" stroke none fill '${LINE}' $(stone "$(at 3)" "$(at 3)" "${hoshi_radius}")"
    mvg+=" fill '${BLACK}' $(stone "$(at 1)" "$(at 1)" "${stone_radius}")"
    mvg+=" stroke '${LINE}' stroke-width ${stone_stroke} fill '${WHITE}'"
    mvg+=" $(stone "$(at 2)" "$(at 1)" "${stone_radius}")"
    mvg+=" stroke none fill '${BLACK}' $(stone "$(at 2)" "$(at 2)" "${stone_radius}")"

    convert -size "${size}x${size}" xc:none -draw "${mvg}" -depth 8 "${output}"
}

# The maskable variant pulls the motif into the centre safe zone, because
# Android crops the outer ~10% to whatever shape the launcher uses.
draw_icon 192 "${OUT_DIR}/icon-192.png" 0.16 0.17
draw_icon 512 "${OUT_DIR}/icon-512.png" 0.16 0.17
draw_icon 512 "${OUT_DIR}/icon-maskable-512.png" 0.30 0.145
draw_icon 180 "${OUT_DIR}/apple-touch-icon.png" 0.16 0.17

ls -l "${OUT_DIR}"
