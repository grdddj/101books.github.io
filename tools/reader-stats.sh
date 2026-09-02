#!/usr/bin/env bash
#
# Usage summary for the running reader, straight off its data directory.
#   ./tools/reader-stats.sh          last 7 days
#   ./tools/reader-stats.sh 1        today
#   ./tools/reader-stats.sh 30 --utc
#
# Reads only, so it is safe while the service is up.
set -euo pipefail

repository="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
days="${1:-7}"
shift || true

cd "$repository"
exec uv run --no-sync python -m reader.admin --data-dir reader-data stats --days "$days" "$@"
