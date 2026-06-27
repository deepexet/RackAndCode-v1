#!/usr/bin/env python3
"""Development entry point. Production uses Docker/uvicorn directly."""
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

import uvicorn
from app.core.config import settings

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.reload or settings.debug,
        log_level="info",
        access_log=True,
    )
