#!/usr/bin/env bash
# Re-render every diagram in mermaid/ to SVG (diagrams/, function-flows/) and
# PNG (png/, function-flows/). Needs the Mermaid CLI:
#   npm install -g @mermaid-js/mermaid-cli
# Optional: MMDC=/path/to/mmdc, PUPPETEER_CFG=puppeteer.json (e.g. to point at an
# installed Chrome with {"executablePath": "..."}).
set -euo pipefail
cd "$(dirname "$0")"
MMDC="${MMDC:-mmdc}"
CFG=mermaid/mermaid-config.json
PARGS=()
[ -n "${PUPPETEER_CFG:-}" ] && PARGS=(-p "$PUPPETEER_CFG")

render() {   # $1 = source .mmd, $2 = svg out, $3 = png out
  "$MMDC" "${PARGS[@]}" -c "$CFG" -b white -i "$1" -o "$2" -q
  # Page width = the diagram's natural width, so wide diagrams are not squeezed.
  local w scale=2
  w=$(grep -o 'viewBox="[^"]*"' "$2" | head -1 | awk '{printf "%d", $3 + 40}')
  [ "${w:-0}" -lt 800 ] && w=800
  [ "$w" -gt 4000 ] && scale=1
  "$MMDC" "${PARGS[@]}" -c "$CFG" -b white -w "$w" -s "$scale" -i "$1" -o "$3" -q
  echo "ok  $1 (png width $w x$scale)"
}

mkdir -p diagrams png function-flows
for f in mermaid/[0-9][0-9]-*.mmd; do
  n=$(basename "$f" .mmd)
  render "$f" "diagrams/$n.svg" "png/$n.png"
done
for f in mermaid/fn/F*.mmd; do
  n=$(basename "$f" .mmd)
  render "$f" "function-flows/$n.svg" "function-flows/$n.png"
done
