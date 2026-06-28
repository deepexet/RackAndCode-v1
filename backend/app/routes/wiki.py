"""Wiki routes — org-wide and per-project knowledge base."""

from __future__ import annotations
import json as _json
import re as _re
from typing import Any
from fastapi import APIRouter, HTTPException
from app.middleware.auth import Auth

router = APIRouter()

_DIAGRAM_GEN_SYSTEM = """You are a wiring diagram generator for RackPilot, a field-ops platform for ICT access control and low-voltage systems.

Generate a JSON wiring diagram for the given description. Return ONLY valid JSON — no markdown fences, no explanation.

JSON schema:
{"name":"Title in Russian","components":[{"id":"c1","type":"TYPE","x":100,"y":100}],"wires":[{"id":"w1","color":"#hex","from":{"compId":"c1","termId":"TERM"},"to":{"compId":"c2","termId":"TERM"}}],"labels":[]}

Available types and terminal IDs (side:id(label)):
- ict_wx: L:r1_12v(+12V) r1_d0(D0) r1_d1(D1) r1_gnd(GND) r1_led(LED) r1_buz(BUZ) | R:d1_com(COM) d1_no(NO) d1_nc(NC) d1_in1(IN1) d1_in2(IN2) d1_inc(COM) | B:pwr_v(+12V) pwr_g(GND) | T:eth(ETH)
- ict_door_exp: T:rs_a(A) rs_b(B) | L:r1_v(+12V) r1_d0(D0) r1_d1(D1) r1_g(GND) r2_v(+12V) r2_d0(D0) r2_d1(D1) r2_g(GND) | R:d1_c(COM) d1_no(NO) d1_i(IN1) d2_c(COM) d2_no(NO) d2_i(IN1) | B:pwr_v(+12V) pwr_g(GND)
- reader_wiegand: R:v12(+12V) gnd(GND) d0(D0) d1(D1) led(LED) buz(BUZ)
- reader_osdp: R:v12(+12V) gnd(GND) a(A) b(B)
- electric_strike: L:com(COM) no(NO) nc(NC)
- maglock: L:pos(+) neg(-)
- dps: R:com(COM) no(NO) nc(NC)
- rex_pir: R:v12(+12V) gnd(GND) com(COM) no(NO)
- push_exit: R:com(COM) no(NO)
- psu_12v: T:ac_l(L) ac_n(N) ac_g(PE) | B:pos(+12V) neg(GND) | R:bat(BAT+)
- psu_24v: T:ac_l(L) ac_n(N) ac_g(PE) | B:pos(+24V) neg(GND)
- relay_spdt: L:com(COM) no(NO) nc(NC) | R:coil_p(+) coil_n(-)
- eol_resistor: L:a(A) | R:b(B)
- terminal_block: L:t1 t2 t3 t4 t5 t6 | R:t1 t2 t3 t4 t5 t6
- butt_connector: L:l1 l2 | R:r1 r2

Wire colors: #e53935=+12V/+24V, #1a1a1a=GND, #1565c0=D0, #f9a825=D1, #2e7d32=relay contacts, #e65100=RS-485, #757575=signal/general

Layout: x/y must be multiples of 20. PSU left (x≈60), controller center (x≈380), peripherals right (x≈680). Start y=60, space 100-160px vertically. Values between 40-1000."""


# ── Org-wide wiki ─────────────────────────────────────────────────────────

@router.get("")
async def list_wiki(ctx: Auth, category: str | None = None):
    pages = ctx.store.list_wiki_pages(ctx.org, project_id=None, category=category)
    categories = sorted({p["category"] for p in pages if p.get("category")})
    return {"pages": pages, "categories": categories}


@router.post("")
async def create_wiki_page(body: dict[str, Any], ctx: Auth):
    body.pop("projectId", None)
    body.pop("project_id", None)
    page = ctx.store.create_wiki_page(ctx.org, body, actor=ctx.user_id)
    return {"page": page}


# ── AI diagram generation (must be before /{page_id} to avoid route shadowing)

@router.post("/generate-diagram")
async def generate_diagram(body: dict[str, Any], ctx: Auth):
    prompt = body.get("prompt", "").strip()
    if not prompt:
        raise HTTPException(400, "prompt required")
    ai_router = ctx.store.get_ai_router(ctx.org)
    result = ai_router.invoke(prompt, system=_DIAGRAM_GEN_SYSTEM, max_tokens=2000)
    text = result.get("text", "").strip()
    text = _re.sub(r'^```(?:json)?\s*', '', text)
    text = _re.sub(r'\s*```$', '', text.strip())
    m = _re.search(r'\{[\s\S]*\}', text)
    if not m:
        raise HTTPException(500, "AI returned no diagram JSON")
    try:
        diagram = _json.loads(m.group())
    except Exception:
        raise HTTPException(500, "AI returned invalid JSON")
    return {"diagram": diagram}


@router.get("/{page_id}")
async def get_wiki_page(page_id: str, ctx: Auth):
    page = ctx.store.get_wiki_page(ctx.org, page_id)
    if not page:
        raise HTTPException(404, "Page not found")
    return {"page": page}


@router.post("/{page_id}")
async def update_wiki_page(page_id: str, body: dict[str, Any], ctx: Auth):
    page = ctx.store.update_wiki_page(ctx.org, page_id, body, actor=ctx.user_id)
    if not page:
        raise HTTPException(404, "Page not found")
    return {"page": page}


@router.post("/{page_id}/delete")
async def delete_wiki_page(page_id: str, ctx: Auth):
    ctx.store.delete_wiki_page(ctx.org, page_id, actor=ctx.user_id)
    return {"ok": True}


# ── Per-project wiki ──────────────────────────────────────────────────────

@router.get("/projects/{project_id}")
async def list_project_wiki(project_id: str, ctx: Auth, category: str | None = None):
    pages = ctx.store.list_wiki_pages(ctx.org, project_id=project_id, category=category)
    categories = sorted({p["category"] for p in pages if p.get("category")})
    return {"pages": pages, "categories": categories, "projectId": project_id}


@router.post("/projects/{project_id}")
async def create_project_wiki_page(project_id: str, body: dict[str, Any], ctx: Auth):
    body["projectId"] = project_id
    page = ctx.store.create_wiki_page(ctx.org, body, actor=ctx.user_id)
    return {"page": page}
