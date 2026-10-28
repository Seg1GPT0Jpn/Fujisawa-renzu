#!/usr/bin/env bash
# Rebuild site/data/environment/*.json from official sources.
# Usage: scripts/env/run_all.sh            (uses cached downloads where present)
#        ENV_REFRESH=1 scripts/env/run_all.sh  (re-download everything)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VENV="$ROOT/.cache/env/venv"
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r "$ROOT/scripts/env/requirements.txt"
fi
cd "$ROOT"   # scripts are run with -I, so nothing is imported from the CWD
"$VENV/bin/python" -I scripts/env/landcover.py
"$VENV/bin/python" -I scripts/env/landcover_grid.py   # after landcover.py; reads site/data/shelters.json for district labels
"$VENV/bin/python" -I scripts/env/water_quality.py
"$VENV/bin/python" -I scripts/env/air_quality.py
ls -l site/data/environment/
