"""pytest 全局夹具：保证 `import conf` / `import posthub` 可用（daemon 根目录入 sys.path）。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
