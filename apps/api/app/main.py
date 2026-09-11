from fastapi import FastAPI

from app.config import get_settings

app = FastAPI(title="teleyes")


@app.get("/health")
def health() -> dict[str, str]:
    settings = get_settings()
    return {"status": "ok", "env": settings.app_env}
