"""Export the FastAPI OpenAPI schema to a JSON file.

Usage:
    python scripts/export_openapi.py [output_path]

Defaults to `contracts/openapi.json`. Loads the FastAPI `app` object directly
(no running server needed) and dumps `app.openapi()`.
"""

import json
import sys
from pathlib import Path

from app.main import app

DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "contracts" / "openapi.json"


def main() -> None:
    output_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUTPUT
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n")
    print(f"OpenAPI schema escrito em {output_path}")


if __name__ == "__main__":
    main()
