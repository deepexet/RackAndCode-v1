"""Wiki routes — org-wide and per-project knowledge base."""

from __future__ import annotations
import json as _json
import re as _re
from typing import Any
from fastapi import APIRouter, HTTPException
from app.middleware.auth import Auth, require_permission

router = APIRouter()

_DIAGRAM_COMPONENT_TYPES = {
    "ict_wx", "ict_door_exp", "reader_wiegand", "reader_osdp", "electric_strike",
    "maglock", "dps", "rex_pir", "push_exit", "psu_12v", "psu_24v", "relay_spdt",
    "eol_resistor", "terminal_block", "butt_connector",
}
_HEX_COLOR = _re.compile(r"^#[0-9a-fA-F]{6}$")
_SAFE_DIAGRAM_ID = _re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")


def _invalid_request(exc: ValueError) -> HTTPException:
    """Keep store validation failures on the public API's 400 contract."""
    return HTTPException(status_code=400, detail={"code": "invalid_request", "message": str(exc)})


def _validate_generated_diagram(value: Any) -> dict[str, Any]:
    """Reject malformed or unexpectedly large model output before it reaches the renderer."""
    if not isinstance(value, dict):
        raise ValueError("diagram must be an object")
    components = value.get("components")
    wires = value.get("wires")
    labels = value.get("labels", [])
    if not isinstance(value.get("name"), str) or not value["name"].strip():
        raise ValueError("diagram name is required")
    if not isinstance(components, list) or not isinstance(wires, list) or not isinstance(labels, list):
        raise ValueError("components, wires, and labels must be arrays")
    if len(components) > 100 or len(wires) > 200 or len(labels) > 100:
        raise ValueError("diagram exceeds component, wire, or label limits")

    component_ids: set[str] = set()
    for component in components:
        if not isinstance(component, dict):
            raise ValueError("each component must be an object")
        component_id = component.get("id")
        if not isinstance(component_id, str) or not _SAFE_DIAGRAM_ID.fullmatch(component_id) or component_id in component_ids:
            raise ValueError("component IDs must be unique safe identifiers")
        if component.get("type") not in _DIAGRAM_COMPONENT_TYPES:
            raise ValueError("component type is not supported")
        if not all(type(component.get(axis)) is int and 0 <= component[axis] <= 1200 for axis in ("x", "y")):
            raise ValueError("component coordinates must be bounded integers")
        component_ids.add(component_id)

    wire_ids: set[str] = set()
    for wire in wires:
        if not isinstance(wire, dict):
            raise ValueError("each wire must be an object")
        wire_id = wire.get("id")
        if (
            not isinstance(wire_id, str)
            or not _SAFE_DIAGRAM_ID.fullmatch(wire_id)
            or wire_id in component_ids
            or wire_id in wire_ids
        ):
            raise ValueError("wire IDs must be unique safe identifiers")
        if not isinstance(wire.get("color"), str) or not _HEX_COLOR.fullmatch(wire["color"]):
            raise ValueError("wire color must be a six-digit hex color")
        for endpoint_name in ("from", "to"):
            endpoint = wire.get(endpoint_name)
            if not isinstance(endpoint, dict) or endpoint.get("compId") not in component_ids:
                raise ValueError("wire endpoints must reference diagram components")
            terminal_id = endpoint.get("termId")
            if not isinstance(terminal_id, str) or not _SAFE_DIAGRAM_ID.fullmatch(terminal_id):
                raise ValueError("wire endpoints require safe terminal IDs")
        wire_ids.add(wire_id)

    label_ids: set[str] = set()
    for label in labels:
        if not isinstance(label, dict):
            raise ValueError("each label must be an object")
        label_id = label.get("id")
        if (
            not isinstance(label_id, str)
            or not _SAFE_DIAGRAM_ID.fullmatch(label_id)
            or label_id in component_ids
            or label_id in wire_ids
            or label_id in label_ids
        ):
            raise ValueError("label IDs must be unique safe identifiers")
        if not isinstance(label.get("text"), str) or len(label["text"]) > 500:
            raise ValueError("label text must be a string of at most 500 characters")
        if not all(type(label.get(axis)) is int and 0 <= label[axis] <= 1200 for axis in ("x", "y")):
            raise ValueError("label coordinates must be bounded integers")
        if "size" in label and (type(label["size"]) is not int or not 8 <= label["size"] <= 72):
            raise ValueError("label size must be an integer between 8 and 72")
        if "color" in label and (not isinstance(label["color"], str) or not _HEX_COLOR.fullmatch(label["color"])):
            raise ValueError("label color must be a six-digit hex color")
        label_ids.add(label_id)
    return value

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
    require_permission(ctx, "projectRead")
    pages = ctx.store.list_wiki_pages(ctx.org, project_id=None, category=category)
    categories = sorted({p["category"] for p in pages if p.get("category")})
    return {"pages": pages, "categories": categories}


@router.post("")
async def create_wiki_page(body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "wikiManage")
    body.pop("projectId", None)
    body.pop("project_id", None)
    try:
        page = ctx.store.create_wiki_page(ctx.org, body, actor=ctx.user_id or "")
    except ValueError as exc:
        raise _invalid_request(exc) from exc
    return {"page": page}


@router.get("/diagrams")
async def list_diagrams(ctx: Auth):
    require_permission(ctx, "projectRead")
    return {"diagrams": ctx.store.list_wiki_diagrams(ctx.org)}


# ── AI diagram generation (must be before /{page_id} to avoid route shadowing)

@router.post("/generate-diagram")
async def generate_diagram(body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "wikiManage")
    raw_prompt = body.get("prompt", "")
    if not isinstance(raw_prompt, str):
        raise HTTPException(400, "prompt must be a string")
    prompt = raw_prompt.strip()
    if not prompt:
        raise HTTPException(400, "prompt required")
    if len(prompt) > 10_000:
        raise HTTPException(400, "prompt exceeds 10000 characters")
    ai_router = ctx.store.get_ai_router(ctx.org)
    result = ai_router.invoke(prompt, system=_DIAGRAM_GEN_SYSTEM, max_tokens=2000)
    text = result.get("text", "").strip()
    text = _re.sub(r'^```(?:json)?\s*', '', text)
    text = _re.sub(r'\s*```$', '', text.strip())
    m = _re.search(r'\{[\s\S]*\}', text)
    if not m:
        raise HTTPException(500, "AI returned no diagram JSON")
    try:
        diagram = _validate_generated_diagram(_json.loads(m.group()))
    except (_json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(502, f"AI returned an invalid diagram: {exc}") from exc
    return {"diagram": diagram}


@router.get("/{page_id}")
async def get_wiki_page(page_id: str, ctx: Auth):
    require_permission(ctx, "projectRead")
    page = ctx.store.get_wiki_page(ctx.org, page_id)
    if not page:
        raise HTTPException(404, "Page not found")
    return {"page": page}


@router.get("/{page_id}/diagrams")
async def list_page_diagrams(page_id: str, ctx: Auth):
    require_permission(ctx, "projectRead")
    if not ctx.store.get_wiki_page(ctx.org, page_id):
        raise HTTPException(404, "Page not found")
    return {"links": ctx.store.list_wiki_page_diagram_links(ctx.org, page_id)}


@router.post("/{page_id}/diagrams")
async def link_page_diagram(page_id: str, body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "projectManage")
    diagram_id = str(body.get("diagramId", "")).strip()
    if not diagram_id:
        raise HTTPException(400, "diagramId required")
    link = ctx.store.link_wiki_diagram(ctx.org, page_id, diagram_id, actor=ctx.user_id or '')
    if not link:
        raise HTTPException(404, "Wiki page or diagram not found")
    return {"link": link}


@router.post("/{page_id}/diagrams/{diagram_id}/delete")
async def unlink_page_diagram(page_id: str, diagram_id: str, ctx: Auth):
    require_permission(ctx, "projectManage")
    if not ctx.store.unlink_wiki_diagram(ctx.org, page_id, diagram_id, actor=ctx.user_id or ''):
        raise HTTPException(404, "Diagram link not found")
    return {"ok": True}


@router.get("/{page_id}/diagrams/history")
async def page_diagram_history(page_id: str, ctx: Auth):
    require_permission(ctx, "projectRead")
    if not ctx.store.get_wiki_page(ctx.org, page_id):
        raise HTTPException(404, "Page not found")
    return {"events": ctx.store.list_wiki_diagram_history(ctx.org, page_id)}


@router.get("/diagrams/{diagram_id}/backlinks")
async def diagram_backlinks(diagram_id: str, ctx: Auth):
    require_permission(ctx, "projectRead")
    diagram = ctx.store.get_wiki_page(ctx.org, diagram_id)
    if not diagram or diagram.get("page_type") != "schema":
        raise HTTPException(404, "Diagram not found")
    return {"pages": ctx.store.list_diagram_wiki_backlinks(ctx.org, diagram_id)}


@router.post("/{page_id}")
async def update_wiki_page(page_id: str, body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "wikiManage")
    try:
        page = ctx.store.update_wiki_page(ctx.org, page_id, body, actor=ctx.user_id or "")
    except ValueError as exc:
        raise _invalid_request(exc) from exc
    if not page:
        raise HTTPException(404, "Page not found")
    return {"page": page}


@router.post("/{page_id}/delete")
async def delete_wiki_page(page_id: str, ctx: Auth):
    require_permission(ctx, "wikiManage")
    ctx.store.delete_wiki_page(ctx.org, page_id, actor=ctx.user_id or "")
    return {"ok": True}


# ── Per-project wiki ──────────────────────────────────────────────────────

@router.get("/projects/{project_id}")
async def list_project_wiki(project_id: str, ctx: Auth, category: str | None = None):
    require_permission(ctx, "projectRead")
    pages = ctx.store.list_wiki_pages(ctx.org, project_id=project_id, category=category)
    categories = sorted({p["category"] for p in pages if p.get("category")})
    return {"pages": pages, "categories": categories, "projectId": project_id}


@router.post("/projects/{project_id}")
async def create_project_wiki_page(project_id: str, body: dict[str, Any], ctx: Auth):
    require_permission(ctx, "wikiManage")
    body["projectId"] = project_id
    try:
        page = ctx.store.create_wiki_page(ctx.org, body, actor=ctx.user_id or "")
    except ValueError as exc:
        raise _invalid_request(exc) from exc
    return {"page": page}
