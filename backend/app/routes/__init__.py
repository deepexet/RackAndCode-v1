from fastapi import APIRouter
from . import auth, projects, inventory, work_orders, assets, admin, ai, notifications, tech, dev_agent, wiki, overview, logs

api_router = APIRouter(prefix="/api/v1")

api_router.include_router(auth.router,         prefix="/auth",              tags=["Auth"])
api_router.include_router(projects.router,     prefix="/projects",          tags=["Projects"])
api_router.include_router(inventory.router,    prefix="/inventory",         tags=["Inventory"])
api_router.include_router(work_orders.router,  prefix="/work-orders",       tags=["Work Orders"])
api_router.include_router(assets.router,       prefix="/assets",            tags=["Assets"])
api_router.include_router(admin.router,        prefix="/admin",             tags=["Admin"])
api_router.include_router(ai.router,           prefix="/ai",                tags=["AI"])
api_router.include_router(notifications.router,prefix="/notifications",     tags=["Notifications"])
api_router.include_router(tech.router,         prefix="/tech",              tags=["Field Tech"])
api_router.include_router(dev_agent.router,    prefix="/development-agent", tags=["Dev Agent"])
api_router.include_router(wiki.router,         prefix="/wiki",              tags=["Wiki"])
api_router.include_router(overview.router,                                 tags=["Overview"])
api_router.include_router(logs.router,                                     tags=["Logs"])
