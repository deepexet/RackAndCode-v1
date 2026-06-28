/**
 * Wiring Diagram Constructor
 *
 * SVG-based visual editor for low-voltage and access-control wiring diagrams.
 * Components: ICT Protégé, Wiegand/OSDP readers, door hardware, power, low-voltage.
 * Saves diagrams as wiki pages (page_type = 'schema').
 */

import { apiJSON, apiPost, apiFetch } from '../core/api.js'
import { esc, loadingSpinner, emptyState } from '../components/ui.js'

// ── Grid & Layout ──────────────────────────────────────────────────────────
const GRID      = 20    // snap size px
const HEADER_H  = 28    // component title bar height
const TERM_R    = 5     // terminal circle radius
const TERM_GAP  = 22    // spacing between terminals on same side
const TERM_PAD  = 14    // padding from corner to first terminal
const STUB      = 20    // wire stub length off terminal (must be multiple of GRID)
const BUNDLE_SPACING = 12  // extra stub px per wire in a parallel bundle
const OBS_MARGIN = 20   // obstacle avoidance margin around components
const HOP_R      = 9    // wire crossing bridge arc radius

// ── Wire Colors ────────────────────────────────────────────────────────────
const WIRE_COLORS = [
  { label: 'Красный (+V)',   hex: '#e53935' },
  { label: 'Чёрный (GND)',   hex: '#1a1a1a' },
  { label: 'Синий',          hex: '#1565c0' },
  { label: 'Жёлтый',        hex: '#f9a825' },
  { label: 'Зелёный',       hex: '#2e7d32' },
  { label: 'Белый',         hex: '#cccccc' },
  { label: 'Оранжевый',     hex: '#e65100' },
  { label: 'Коричневый',    hex: '#6d4c41' },
  { label: 'Серый',         hex: '#757575' },
  { label: 'Фиолетовый',    hex: '#7b1fa2' },
]

// ── Component definitions ──────────────────────────────────────────────────
// Terminal: { id, label, side:'L'|'R'|'T'|'B', pos:number (0-based) }
const COMP_DEFS = {

  // ── ICT Access Control ────────────────────────────────────────────────
  ict_wx: {
    label:'ICT Protégé WX', category:'ict', w:190, h:320, hue:'#123456',
    desc:'2-door IP access controller. Reader ports: Wiegand / OSDP',
    terminals:[
      {id:'r1_12v',label:'+12V',side:'L',pos:0},{id:'r1_d0',label:'D0',side:'L',pos:1},
      {id:'r1_d1', label:'D1',  side:'L',pos:2},{id:'r1_gnd',label:'GND',side:'L',pos:3},
      {id:'r1_led',label:'LED', side:'L',pos:4},{id:'r1_buz',label:'BUZ',side:'L',pos:5},
      {id:'d1_com',label:'COM', side:'R',pos:0},{id:'d1_no', label:'NO', side:'R',pos:1},
      {id:'d1_nc', label:'NC',  side:'R',pos:2},{id:'d1_in1',label:'IN1',side:'R',pos:3},
      {id:'d1_in2',label:'IN2', side:'R',pos:4},{id:'d1_inc',label:'COM',side:'R',pos:5},
      {id:'pwr_v', label:'+12V',side:'B',pos:0},{id:'pwr_g', label:'GND',side:'B',pos:1},
      {id:'eth',   label:'ETH', side:'T',pos:0},
    ]
  },

  ict_door_exp: {
    label:'ICT Door Expander', category:'ict', w:190, h:330, hue:'#1a4d3a',
    desc:'4-door expander via RS-485. For ICT Protégé GX/WX.',
    terminals:[
      {id:'rs_a', label:'A',    side:'T',pos:0},{id:'rs_b', label:'B',   side:'T',pos:1},
      {id:'r1_v', label:'+12V', side:'L',pos:0},{id:'r1_d0',label:'D0',  side:'L',pos:1},
      {id:'r1_d1',label:'D1',   side:'L',pos:2},{id:'r1_g', label:'GND', side:'L',pos:3},
      {id:'r2_v', label:'+12V', side:'L',pos:5},{id:'r2_d0',label:'D0',  side:'L',pos:6},
      {id:'r2_d1',label:'D1',   side:'L',pos:7},{id:'r2_g', label:'GND', side:'L',pos:8},
      {id:'d1_c', label:'COM',  side:'R',pos:0},{id:'d1_no',label:'NO',  side:'R',pos:1},
      {id:'d1_i', label:'IN1',  side:'R',pos:2},
      {id:'d2_c', label:'COM',  side:'R',pos:4},{id:'d2_no',label:'NO',  side:'R',pos:5},
      {id:'d2_i', label:'IN1',  side:'R',pos:6},
      {id:'pwr_v',label:'+12V', side:'B',pos:0},{id:'pwr_g',label:'GND', side:'B',pos:1},
    ]
  },

  ict_input_exp: {
    label:'ICT Input Expander', category:'ict', w:160, h:280, hue:'#0d3a2a',
    desc:'16-input expander via RS-485',
    terminals:[
      {id:'rs_a', label:'A',    side:'T',pos:0},{id:'rs_b',label:'B',  side:'T',pos:1},
      {id:'in1',  label:'IN1',  side:'L',pos:0},{id:'in2', label:'IN2',side:'L',pos:1},
      {id:'in3',  label:'IN3',  side:'L',pos:2},{id:'in4', label:'IN4',side:'L',pos:3},
      {id:'in5',  label:'IN5',  side:'L',pos:4},{id:'in6', label:'IN6',side:'L',pos:5},
      {id:'inc',  label:'COM',  side:'L',pos:6},
      {id:'pwr_v',label:'+12V', side:'B',pos:0},{id:'pwr_g',label:'GND',side:'B',pos:1},
    ]
  },

  reader_wiegand: {
    label:'Reader (Wiegand)', category:'ict', w:140, h:200, hue:'#4a235a',
    desc:'Wiegand 26/34-bit card/fob reader',
    terminals:[
      {id:'v12', label:'+12V',side:'R',pos:0},{id:'gnd',label:'GND',side:'R',pos:1},
      {id:'d0',  label:'D0',  side:'R',pos:2},{id:'d1', label:'D1', side:'R',pos:3},
      {id:'led', label:'LED', side:'R',pos:4},{id:'buz',label:'BUZ',side:'R',pos:5},
    ]
  },

  reader_osdp: {
    label:'Reader (OSDP)', category:'ict', w:140, h:160, hue:'#4a0d5a',
    desc:'OSDP v2 RS-485 smart reader (PIN / BIO)',
    terminals:[
      {id:'v12',label:'+12V',side:'R',pos:0},{id:'gnd',label:'GND',side:'R',pos:1},
      {id:'a',  label:'A',   side:'R',pos:2},{id:'b',  label:'B',  side:'R',pos:3},
    ]
  },

  // ── Door Hardware ─────────────────────────────────────────────────────
  electric_strike: {
    label:'Electric Strike', category:'door', w:140, h:130, hue:'#7f3b00',
    desc:'Electric door strike. Fail-safe or fail-secure.',
    terminals:[
      {id:'com',label:'COM',side:'L',pos:0},
      {id:'no', label:'NO', side:'L',pos:1},
      {id:'nc', label:'NC', side:'L',pos:2},
    ]
  },

  maglock: {
    label:'Magnetic Lock', category:'door', w:140, h:110, hue:'#7f1f00',
    desc:'600 lb electromagnetic lock',
    terminals:[
      {id:'pos',label:'+',  side:'L',pos:0},
      {id:'neg',label:'−',  side:'L',pos:1},
    ]
  },

  dps: {
    label:'Door Position Switch', category:'door', w:150, h:130, hue:'#5a5a00',
    desc:'Magnetic contact for door/window monitoring',
    terminals:[
      {id:'com',label:'COM',side:'R',pos:0},
      {id:'no', label:'NO', side:'R',pos:1},
      {id:'nc', label:'NC', side:'R',pos:2},
    ]
  },

  rex_pir: {
    label:'REX Sensor (PIR)', category:'door', w:140, h:150, hue:'#005a5a',
    desc:'Passive infrared request-to-exit sensor',
    terminals:[
      {id:'v12',label:'+12V',side:'R',pos:0},{id:'gnd',label:'GND',side:'R',pos:1},
      {id:'com',label:'COM', side:'R',pos:2},{id:'no', label:'NO', side:'R',pos:3},
    ]
  },

  push_exit: {
    label:'Push-to-Exit Button', category:'door', w:140, h:110, hue:'#004455',
    desc:'Momentary exit push button',
    terminals:[
      {id:'com',label:'COM',side:'R',pos:0},
      {id:'no', label:'NO', side:'R',pos:1},
    ]
  },

  // ── Power ─────────────────────────────────────────────────────────────
  psu_12v: {
    label:'PSU 12V DC', category:'power', w:150, h:180, hue:'#1a4000',
    desc:'12V DC regulated power supply',
    terminals:[
      {id:'ac_l',label:'L',    side:'T',pos:0},{id:'ac_n',label:'N',  side:'T',pos:1},
      {id:'ac_g',label:'PE',   side:'T',pos:2},
      {id:'pos', label:'+12V', side:'B',pos:0},{id:'neg',label:'GND', side:'B',pos:1},
      {id:'bat', label:'BAT+', side:'R',pos:0},
    ]
  },

  psu_24v: {
    label:'PSU 24V DC', category:'power', w:150, h:180, hue:'#1a3a00',
    desc:'24V DC regulated power supply',
    terminals:[
      {id:'ac_l',label:'L',    side:'T',pos:0},{id:'ac_n',label:'N',  side:'T',pos:1},
      {id:'ac_g',label:'PE',   side:'T',pos:2},
      {id:'pos', label:'+24V', side:'B',pos:0},{id:'neg',label:'GND', side:'B',pos:1},
    ]
  },

  transformer_24vac: {
    label:'Transformer 24VAC', category:'power', w:150, h:140, hue:'#3d2000',
    desc:'Step-down transformer 120/240V → 24VAC for thermostats',
    terminals:[
      {id:'p_l',label:'L',  side:'T',pos:0},{id:'p_n',label:'N',side:'T',pos:1},
      {id:'s_r',label:'R',  side:'B',pos:0},{id:'s_c',label:'C',side:'B',pos:1},
    ]
  },

  // ── Low Voltage ───────────────────────────────────────────────────────
  relay_spdt: {
    label:'Relay SPDT', category:'lv', w:140, h:180, hue:'#2d004a',
    desc:'Single pole double throw 12V relay',
    terminals:[
      {id:'coil_p',label:'A1+',side:'T',pos:0},{id:'coil_n',label:'A2−',side:'T',pos:1},
      {id:'com',   label:'COM',side:'L',pos:0},
      {id:'no',    label:'NO', side:'R',pos:0},
      {id:'nc',    label:'NC', side:'R',pos:1},
    ]
  },

  eol_resistor: {
    label:'EOL Resistor', category:'lv', w:100, h:80, hue:'#3a3a00',
    desc:'End-of-line resistor for supervised zones (1kΩ / 2.2kΩ)',
    terminals:[
      {id:'a',label:'A',side:'L',pos:0},
      {id:'b',label:'B',side:'R',pos:0},
    ]
  },

  terminal_block: {
    label:'Terminal Block ×6', category:'lv', w:110, h:210, hue:'#004040',
    desc:'6-way screw terminal block / junction',
    terminals:[
      {id:'t1a',label:'1',side:'L',pos:0},{id:'t1b',label:'1',side:'R',pos:0},
      {id:'t2a',label:'2',side:'L',pos:1},{id:'t2b',label:'2',side:'R',pos:1},
      {id:'t3a',label:'3',side:'L',pos:2},{id:'t3b',label:'3',side:'R',pos:2},
      {id:'t4a',label:'4',side:'L',pos:3},{id:'t4b',label:'4',side:'R',pos:3},
      {id:'t5a',label:'5',side:'L',pos:4},{id:'t5b',label:'5',side:'R',pos:4},
      {id:'t6a',label:'6',side:'L',pos:5},{id:'t6b',label:'6',side:'R',pos:5},
    ]
  },

  thermostat: {
    label:'Thermostat', category:'lv', w:210, h:220, hue:'#003366',
    desc:'Smart thermostat (Nest Gen3 / Honeywell T6)',
    terminals:[
      {id:'rh', label:'Rh',  side:'B',pos:0},{id:'rc', label:'Rc',  side:'B',pos:1},
      {id:'c',  label:'C',   side:'B',pos:2},{id:'y1', label:'Y1',  side:'B',pos:3},
      {id:'y2', label:'Y2',  side:'B',pos:4},{id:'g',  label:'G',   side:'B',pos:5},
      {id:'w1', label:'W1',  side:'B',pos:6},{id:'w2', label:'W2',  side:'B',pos:7},
      {id:'ob', label:'O/B', side:'B',pos:8},
    ]
  },

  air_handler: {
    label:'Air Handler', category:'lv', w:200, h:240, hue:'#002040',
    desc:'Air handler unit — fan coil terminals',
    terminals:[
      {id:'c', label:'C',  side:'T',pos:0},{id:'g', label:'G',  side:'T',pos:1},
      {id:'w1',label:'W1', side:'T',pos:2},{id:'w2',label:'W2', side:'T',pos:3},
      {id:'y1',label:'Y1', side:'T',pos:4},{id:'y2',label:'Y2', side:'T',pos:5},
      {id:'b', label:'B',  side:'T',pos:6},{id:'r', label:'R',  side:'T',pos:7},
    ]
  },

  heat_pump: {
    label:'Heat Pump (ODU)', category:'lv', w:180, h:260, hue:'#002828',
    desc:'Outdoor heat pump unit — low-voltage control terminals',
    terminals:[
      {id:'c',  label:'C',  side:'R',pos:0},{id:'r',  label:'R',  side:'R',pos:1},
      {id:'y',  label:'Y',  side:'R',pos:2},{id:'y2', label:'Y2', side:'R',pos:3},
      {id:'g',  label:'G',  side:'R',pos:4},{id:'b',  label:'B',  side:'R',pos:5},
      {id:'w',  label:'W',  side:'R',pos:6},
    ]
  },

  boiler_ctrl: {
    label:'Boiler Control', category:'lv', w:160, h:160, hue:'#3a1a00',
    desc:'Hydronic boiler control board',
    terminals:[
      {id:'r', label:'R',  side:'L',pos:0},
      {id:'w', label:'W',  side:'L',pos:1},
      {id:'t', label:'T/T',side:'L',pos:2},
    ]
  },

  // ── Generic ───────────────────────────────────────────────────────────
  custom_box: {
    label:'Custom Device', category:'generic', w:160, h:200, hue:'#303030',
    desc:'Generic labeled device — double-click to rename',
    terminals:[
      {id:'l1',label:'L1',side:'L',pos:0},{id:'l2',label:'L2',side:'L',pos:1},
      {id:'l3',label:'L3',side:'L',pos:2},{id:'l4',label:'L4',side:'L',pos:3},
      {id:'r1',label:'R1',side:'R',pos:0},{id:'r2',label:'R2',side:'R',pos:1},
      {id:'r3',label:'R3',side:'R',pos:2},{id:'r4',label:'R4',side:'R',pos:3},
    ]
  },

  junction_node: {
    label:'Junction Node', category:'generic', w:40, h:40, hue:'#222',
    desc:'Wire junction (solder dot)',
    terminals:[
      {id:'l',label:'',side:'L',pos:0},{id:'r',label:'',side:'R',pos:0},
      {id:'t',label:'',side:'T',pos:0},{id:'b',label:'',side:'B',pos:0},
    ]
  },

  butt_connector: {
    label:'Butt Connector', category:'generic', w:80, h:50, hue:'#5a3a00',
    desc:'Butt splice / wire connector. Crimp or lever type.',
    terminals:[
      {id:'l1',label:'',side:'L',pos:0},
      {id:'l2',label:'',side:'L',pos:1},
      {id:'r1',label:'',side:'R',pos:0},
      {id:'r2',label:'',side:'R',pos:1},
    ]
  },

  text_label: {
    label:'Text Label', category:'generic', w:120, h:50, hue:'#00000000',
    desc:'Floating text annotation',
    terminals:[]
  },
}

const CATEGORIES = {
  ict:     { label:'ICT Access Control', icon:'ti-cpu' },
  door:    { label:'Дверное оборудование', icon:'ti-door' },
  power:   { label:'Питание',            icon:'ti-bolt' },
  lv:      { label:'Low Voltage / HVAC', icon:'ti-schema' },
  generic: { label:'Generic',            icon:'ti-square' },
}

// ── State ──────────────────────────────────────────────────────────────────
let _el = null
let _svgEl = null
let _mode   = 'select'    // select | wire | pan | text
let _activeColor = WIRE_COLORS[0].hex
let _pan    = { x: 80, y: 80 }
let _zoom   = 1
let _drag   = null        // { type:'comp'|'canvas', id, ox, oy, startX, startY }
let _wireStart = null     // { compId, termId, x, y, side }
let _wirePreview = null   // current mouse pos while drawing wire
let _selected  = null     // { type:'comp'|'wire'|'label', id }
let _diagrams  = []       // list from API
let _editId    = null     // currently open diagram id

let _diagram = newDiagram()
let _undoStack = []
let _svgEventsBound = false  // guard: SVG-level events bound only once
let _simulating = false       // current-flow animation active

function newDiagram() {
  return { name:'Новая схема', components:[], wires:[], labels:[], customDefs:[], modified: false }
}

// Returns the definition for a component — built-in first, then custom defs in current diagram
function getCompDef(type) {
  if (COMP_DEFS[type]) return COMP_DEFS[type]
  return _diagram?.customDefs?.find(d => d.id === type) || null
}

// ── Utilities ──────────────────────────────────────────────────────────────
function uid() { return Math.random().toString(36).slice(2,10) }
function snap(v) { return Math.round(v / GRID) * GRID }

function getTermPos(comp, termId) {
  const def = getCompDef(comp.type)
  if (!def) return { x:comp.x, y:comp.y }
  const term = def.terminals.find(t => t.id === termId)
  if (!term) return { x:comp.x, y:comp.y }

  const w = def.w, h = def.h
  switch (term.side) {
    case 'L': return { x: comp.x,   y: comp.y + HEADER_H + TERM_PAD + term.pos * TERM_GAP, side:'L' }
    case 'R': return { x: comp.x+w, y: comp.y + HEADER_H + TERM_PAD + term.pos * TERM_GAP, side:'R' }
    case 'T': return { x: comp.x + TERM_PAD + term.pos * TERM_GAP, y: comp.y,   side:'T' }
    case 'B': return { x: comp.x + TERM_PAD + term.pos * TERM_GAP, y: comp.y+h, side:'B' }
    default:  return { x: comp.x, y: comp.y }
  }
}

function routeWire(fp, fside, tp, tside, waypoints, comps, excludeIds, exitExtra=0, entryExtra=0) {
  const s = STUB
  const sx = fp.x + (fside==='L'?-(s+exitExtra):fside==='R'?(s+exitExtra):0)
  const sy = fp.y + (fside==='T'?-(s+exitExtra):fside==='B'?(s+exitExtra):0)
  const ex = tp.x + (tside==='L'?-(s+entryExtra):tside==='R'?(s+entryExtra):0)
  const ey = tp.y + (tside==='T'?-(s+entryExtra):tside==='B'?(s+entryExtra):0)

  if (waypoints && waypoints.length) {
    const pts = [[fp.x, fp.y], [sx, sy]]
    for (const [wx, wy] of waypoints) {
      const [px, py] = pts[pts.length - 1]
      if (Math.abs(px - wx) > 0.5 && Math.abs(py - wy) > 0.5) pts.push([wx, py])
      pts.push([wx, wy])
    }
    const [px, py] = pts[pts.length - 1]
    if (Math.abs(px - ex) > 0.5 && Math.abs(py - ey) > 0.5) pts.push([ex, py])
    pts.push([ex, ey], [tp.x, tp.y])
    return dedupePts(pts)
  }

  // Auto Manhattan routing — avoid degenerate duplicate points
  const pts = [[fp.x, fp.y], [sx, sy]]
  const hFrom = fside==='L'||fside==='R'
  const hTo   = tside==='L'||tside==='R'
  const allComps = comps || []

  if (hFrom && hTo) {
    if (Math.abs(sy - ey) < 0.5) {
      // Same height — direct horizontal, avoidComps will deflect if needed
    } else if (ex < sx) {
      // R→L: go horizontal to target column first, then vertical.
      // Avoids routing a vertical segment through the source component body.
      pts.push([ex, sy])
    } else {
      // L→R: go vertical at source column, then horizontal to target.
      pts.push([sx, ey])
    }
  } else if (!hFrom && !hTo) {
    if (Math.abs(sx - ex) < 0.5) {
      // Same column — direct vertical
    } else if (ey < sy) {
      // B→T: go vertical to target row first, then horizontal.
      pts.push([sx, ey])
    } else {
      // T→B: go horizontal to target column first, then vertical.
      pts.push([ex, sy])
    }
  } else if (hFrom && !hTo) {
    pts.push([ex, sy])
  } else {
    pts.push([sx, ey])
  }
  pts.push([ex, ey], [tp.x, tp.y])

  return avoidComps(dedupePts(pts), allComps, excludeIds || [])
}

// Find a vertical column (midX) for H→V→H routing that avoids component bodies
function smartMidX(sx, ex, sy, ey, comps) {
  const nominal = snap((sx + ex) / 2)
  const minX = Math.min(sx, ex), maxX = Math.max(sx, ex)
  const yMin = Math.min(sy, ey), yMax = Math.max(sy, ey)
  // Build bboxes for all comps
  const rects = comps.filter(c => getCompDef(c.type)).map(c => ({
    x1: c.x - OBS_MARGIN, x2: c.x + getCompDef(c.type).w + OBS_MARGIN,
    y1: c.y - OBS_MARGIN, y2: c.y + getCompDef(c.type).h + OBS_MARGIN,
  }))
  const blocked = (x) => rects.some(r => x > r.x1 && x < r.x2 && yMin < r.y2 && yMax > r.y1)
  if (!blocked(nominal)) return nominal
  // Try to find clear column sweeping outward from nominal
  for (let d = GRID; d <= maxX - minX; d += GRID) {
    if (nominal - d >= minX && !blocked(nominal - d)) return nominal - d
    if (nominal + d <= maxX && !blocked(nominal + d)) return nominal + d
  }
  return nominal // fallback — avoidComps will handle it
}

// Find a horizontal row (midY) for V→H→V routing that avoids component bodies
function smartMidY(sy, ey, sx, ex, comps) {
  const nominal = snap((sy + ey) / 2)
  const minY = Math.min(sy, ey), maxY = Math.max(sy, ey)
  const xMin = Math.min(sx, ex), xMax = Math.max(sx, ex)
  const rects = comps.filter(c => getCompDef(c.type)).map(c => ({
    x1: c.x - OBS_MARGIN, x2: c.x + getCompDef(c.type).w + OBS_MARGIN,
    y1: c.y - OBS_MARGIN, y2: c.y + getCompDef(c.type).h + OBS_MARGIN,
  }))
  const blocked = (y) => rects.some(r => y > r.y1 && y < r.y2 && xMin < r.x2 && xMax > r.x1)
  if (!blocked(nominal)) return nominal
  for (let d = GRID; d <= maxY - minY; d += GRID) {
    if (nominal - d >= minY && !blocked(nominal - d)) return nominal - d
    if (nominal + d <= maxY && !blocked(nominal + d)) return nominal + d
  }
  return nominal
}

// Classify wire signal for animation
function getWireSignalType(wire) {
  const fc = _diagram.components.find(c => c.id === wire.from?.compId)
  const tc = _diagram.components.find(c => c.id === wire.to?.compId)
  const labels = [
    wire.from?.termId, wire.to?.termId,
    getCompDef(fc?.type)?.terminals?.find(t => t.id === wire.from?.termId)?.label,
    getCompDef(tc?.type)?.terminals?.find(t => t.id === wire.to?.termId)?.label,
  ].join(' ').toLowerCase()
  if (/12v|24v|\+v|v\+|pwr|vcc|rh|rc|pwr_v|r1_v|r2_v/.test(labels)) return 'power'
  if (/gnd|0v|neg|pwr_g|r1_g|r2_g/.test(labels))                       return 'ground'
  if (/d0|d1|wiegand/.test(labels))                                      return 'wiegand'
  if (/rs_a|rs_b|osdp|485/.test(labels))                                 return 'rs485'
  if (/eth|lan/.test(labels))                                             return 'eth'
  if (/_no\b|_nc\b|_com\b|relay|door/.test(labels))                      return 'relay'
  if (/led|buz/.test(labels))                                             return 'signal'
  return 'generic'
}

const SIGNAL_ANIM = {
  power:   { dasharray:'14 6',  dur:'1.2s', color: '#ef4444', offset: 40 },
  ground:  { dasharray:'3 16',  dur:'2.0s', color: '#555',    offset: 19 },
  wiegand: { dasharray:'3 4',   dur:'0.25s',color: '#fbbf24', offset: 14 },
  rs485:   { dasharray:'2 3',   dur:'0.2s', color: '#38bdf8', offset: 10 },
  eth:     { dasharray:'2 2',   dur:'0.15s',color: '#a78bfa', offset: 8  },
  relay:   { dasharray:'10 12', dur:'0.9s', color: '#f97316', offset: 44 },
  signal:  { dasharray:'4 8',   dur:'0.5s', color: '#34d399', offset: 24 },
  generic: { dasharray:'8 6',   dur:'0.7s', color: null,      offset: 28 },
}

// Remove consecutive duplicate points
function dedupePts(pts) {
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const [x1,y1] = out[out.length-1], [x2,y2] = pts[i]
    if (Math.abs(x1-x2) > 0.5 || Math.abs(y1-y2) > 0.5) out.push([x2,y2])
  }
  return out
}

// Remove oscillating loops (A→B→A patterns) left by avoidComps iterations
function deloopPts(pts) {
  const result = []
  const index = new Map()
  for (const pt of pts) {
    const key = `${Math.round(pt[0])},${Math.round(pt[1])}`
    if (index.has(key)) {
      const backTo = index.get(key)
      while (result.length > backTo + 1) {
        const removed = result.pop()
        index.delete(`${Math.round(removed[0])},${Math.round(removed[1])}`)
      }
    } else {
      index.set(key, result.length)
      result.push(pt)
    }
  }
  return result
}

// Push wire segments around component bounding boxes.
// Key rule: stub segments (i=1 and i=n-1) only avoid "other" components (stub can enter
// its own component body to reach the terminal). ALL body segments (i=2..n-2) avoid EVERY
// component including the connected ones — so the wire body never passes through them.
function avoidComps(pts, comps, excludeIds) {
  const toRect = (c) => {
    const def = getCompDef(c.type)
    return {
      id: c.id,
      x1: c.x - OBS_MARGIN, y1: c.y - OBS_MARGIN,
      x2: c.x + def.w + OBS_MARGIN,
      y2: c.y + def.h + OBS_MARGIN,
    }
  }
  // bodyRects: ALL components are obstacles (wire body must not cross any)
  const bodyRects = comps.filter(c => getCompDef(c.type)).map(toRect)
  // stubRects: only non-connected components (stubs may enter connected comp bodies)
  const stubRects = bodyRects.filter(r => !excludeIds.includes(r.id))

  if (!bodyRects.length) return pts

  function deflectSeg(x1, y1, x2, y2, rects, next) {
    for (const r of rects) {
      const rcx = (r.x1 + r.x2) / 2, rcy = (r.y1 + r.y2) / 2
      if (Math.abs(y1 - y2) < 0.5) {
        const lx = Math.min(x1, x2), rx = Math.max(x1, x2)
        if (y1 > r.y1 && y1 < r.y2 && lx < r.x2 - 2 && rx > r.x1 + 2) {
          const newY = snap(y1 < rcy ? r.y1 : r.y2)
          const dir = x2 >= x1 ? 1 : -1
          const entryX = snap(dir > 0 ? Math.max(x1, r.x1) : Math.min(x1, r.x2))
          const exitX  = snap(dir > 0 ? Math.min(x2, r.x2) : Math.max(x2, r.x1))
          if (Math.abs(entryX - x1) > 1) next.push([entryX, y1])
          next.push([entryX, newY], [exitX, newY])
          if (Math.abs(exitX - x2) > 1) next.push([exitX, y1])
          next.push([x2, y2])
          return true
        }
      } else if (Math.abs(x1 - x2) < 0.5) {
        const ty = Math.min(y1, y2), by = Math.max(y1, y2)
        if (x1 > r.x1 && x1 < r.x2 && ty < r.y2 - 2 && by > r.y1 + 2) {
          const newX = snap(x1 < rcx ? r.x1 : r.x2)
          const dir = y2 >= y1 ? 1 : -1
          const entryY = snap(dir > 0 ? Math.max(y1, r.y1) : Math.min(y1, r.y2))
          const exitY  = snap(dir > 0 ? Math.min(y2, r.y2) : Math.max(y2, r.y1))
          if (Math.abs(entryY - y1) > 1) next.push([x1, entryY])
          next.push([newX, entryY], [newX, exitY])
          if (Math.abs(exitY - y2) > 1) next.push([x1, exitY])
          next.push([x2, y2])
          return true
        }
      }
    }
    return false
  }

  for (let iter = 0; iter < 10; iter++) {
    let changed = false
    const next = [pts[0]]
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = next[next.length - 1]
      const [x2, y2] = pts[i]
      if (Math.abs(x2 - x1) < 0.5 && Math.abs(y2 - y1) < 0.5) continue

      // Stubs (first and last segment): use stubRects — can enter connected comp
      // Body segments: use bodyRects — must avoid ALL components
      const isStub = (i === 1 || i === pts.length - 1)
      const rects  = isStub ? stubRects : bodyRects

      const deflected = deflectSeg(x1, y1, x2, y2, rects, next)
      if (deflected) { changed = true } else { next.push([x2, y2]) }
    }
    pts = next
    if (!changed) break
  }
  return deloopPts(dedupePts(pts))
}

// Insert corner points to re-Manhattanize a path with diagonal segments
function manhattanize(pts) {
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = out[out.length - 1]
    const [x2, y2] = pts[i]
    if (Math.abs(x1 - x2) > 0.5 && Math.abs(y1 - y2) > 0.5) {
      out.push([x2, y1])  // horizontal-first corner
    }
    out.push([x2, y2])
  }
  return out
}

// Full point array for a wire — uses manual pts/waypoints or auto-routes
function buildWirePts(wire, exitExtra=0, entryExtra=0) {
  if (!wire.from || !wire.to) return []
  const fromComp = _diagram.components.find(c => c.id === wire.from.compId)
  const toComp   = _diagram.components.find(c => c.id === wire.to.compId)
  if (!fromComp || !toComp) return []
  // Manually dragged path takes priority
  if (wire.pts && wire.pts.length >= 2) return wire.pts
  const fp = getTermPos(fromComp, wire.from.termId)
  const tp = getTermPos(toComp,   wire.to.termId)
  return dedupePts(routeWire(fp, fp.side, tp, tp.side, wire.waypoints, _diagram.components, [fromComp.id, toComp.id], exitExtra, entryExtra))
}

function computeAllWirePts() {
  // Group auto-routed wires by (componentId, terminalSide) to detect parallel bundles
  // and offset them so parallel wires are visually distinct
  const exitBundles = {}   // "compId:side" -> [{wireId, pos}]
  const entryBundles = {}

  for (const w of _diagram.wires) {
    if (w.pts && w.pts.length >= 2) continue  // manual paths skip bundling
    const fc = _diagram.components.find(c => c.id === w.from?.compId)
    const tc = _diagram.components.find(c => c.id === w.to?.compId)
    if (!fc || !tc) continue
    const fp = getTermPos(fc, w.from.termId)
    const tp = getTermPos(tc, w.to.termId)

    const eKey = `${fc.id}:${fp.side}`
    const nKey = `${tc.id}:${tp.side}`

    ;(exitBundles[eKey] = exitBundles[eKey] || []).push({
      wireId: w.id, pos: (fp.side==='L'||fp.side==='R') ? fp.y : fp.x
    })
    ;(entryBundles[nKey] = entryBundles[nKey] || []).push({
      wireId: w.id, pos: (tp.side==='L'||tp.side==='R') ? tp.y : tp.x
    })
  }

  // Sort by terminal position for consistent ordering, assign cumulative offsets
  const exitExtra = {}   // wireId -> extra stub pixels
  const entryExtra = {}

  for (const items of Object.values(exitBundles)) {
    if (items.length < 2) continue
    items.sort((a, b) => a.pos - b.pos)
    items.forEach((item, i) => { exitExtra[item.wireId] = i * BUNDLE_SPACING })
  }
  for (const items of Object.values(entryBundles)) {
    if (items.length < 2) continue
    items.sort((a, b) => a.pos - b.pos)
    items.forEach((item, i) => { entryExtra[item.wireId] = i * BUNDLE_SPACING })
  }

  const map = {}
  for (const w of _diagram.wires) {
    map[w.id] = buildWirePts(w, exitExtra[w.id] || 0, entryExtra[w.id] || 0)
  }
  return map
}

// Returns {x,y} if an H and a V segment strictly cross, else null
function segCross(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
  const aH = Math.abs(ay1 - ay2) < 0.5, aV = Math.abs(ax1 - ax2) < 0.5
  const bH = Math.abs(by1 - by2) < 0.5, bV = Math.abs(bx1 - bx2) < 0.5
  let h, v
  if (aH && bV) {
    h = { x1: Math.min(ax1,ax2), x2: Math.max(ax1,ax2), y: ay1 }
    v = { y1: Math.min(by1,by2), y2: Math.max(by1,by2), x: bx1 }
  } else if (aV && bH) {
    h = { x1: Math.min(bx1,bx2), x2: Math.max(bx1,bx2), y: by1 }
    v = { y1: Math.min(ay1,ay2), y2: Math.max(ay1,ay2), x: ax1 }
  } else return null
  if (v.x > h.x1 + 2 && v.x < h.x2 - 2 && h.y > v.y1 + 2 && h.y < v.y2 - 2) return { x: v.x, y: h.y }
  return null
}

// Map of wireId → [{x,y}] crossings where this wire is drawn UNDER
function findCrossings(allPts) {
  const result = {}
  const ids = Object.keys(allPts)
  for (let i = 0; i < ids.length; i++) {
    const pA = allPts[ids[i]]
    for (let j = i + 1; j < ids.length; j++) {
      const pB = allPts[ids[j]]
      for (let si = 1; si < pA.length; si++) {
        for (let sj = 1; sj < pB.length; sj++) {
          const c = segCross(pA[si-1][0],pA[si-1][1],pA[si][0],pA[si][1],
                             pB[sj-1][0],pB[sj-1][1],pB[sj][0],pB[sj][1])
          if (c) {
            // Earlier wire (i) draws under — gets the hop arc
            if (!result[ids[i]]) result[ids[i]] = []
            result[ids[i]].push(c)
          }
        }
      }
    }
  }
  return result
}

// SVG path string, inserting bridge arcs where this wire crosses under another
function buildWirePath(pts, crossings) {
  if (!crossings || !crossings.length) return 'M ' + pts.map(([x,y]) => `${x},${y}`).join(' L ')
  let d = `M ${pts[0][0]},${pts[0][1]}`
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i-1], [x2, y2] = pts[i]
    const isH = Math.abs(y1 - y2) < 0.5
    const onSeg = crossings.filter(c => isH
      ? Math.abs(c.y - y1) < 1 && c.x > Math.min(x1,x2) + 1 && c.x < Math.max(x1,x2) - 1
      : Math.abs(c.x - x1) < 1 && c.y > Math.min(y1,y2) + 1 && c.y < Math.max(y1,y2) - 1)
    if (!onSeg.length) { d += ` L ${x2},${y2}`; continue }
    const sorted = isH
      ? [...onSeg].sort((a,b) => x1 <= x2 ? a.x - b.x : b.x - a.x)
      : [...onSeg].sort((a,b) => y1 <= y2 ? a.y - b.y : b.y - a.y)
    for (const c of sorted) {
      if (isH) {
        const dir = x1 <= x2 ? 1 : -1
        // Arc curves upward (away from center of diagram is fine)
        d += ` L ${c.x - dir*HOP_R},${y1} A ${HOP_R},${HOP_R} 0 0,${dir>0?0:1} ${c.x + dir*HOP_R},${y1}`
      } else {
        const dir = y1 <= y2 ? 1 : -1
        d += ` L ${x1},${c.y - dir*HOP_R} A ${HOP_R},${HOP_R} 0 0,1 ${x1},${c.y + dir*HOP_R}`
      }
    }
    d += ` L ${x2},${y2}`
  }
  return d
}

function ptStr(pts) { return pts.map(([x,y]) => `${x},${y}`).join(' ') }

function svgXY(e) {
  const rect = _svgEl.getBoundingClientRect()
  return {
    x: (e.clientX - rect.left - _pan.x) / _zoom,
    y: (e.clientY - rect.top  - _pan.y) / _zoom,
  }
}

function hitTestTerminal(x, y, margin = 12) {
  for (const comp of _diagram.components) {
    const def = getCompDef(comp.type)
    if (!def) continue
    for (const term of def.terminals) {
      const tp = getTermPos(comp, term.id)
      if (Math.abs(tp.x - x) <= margin && Math.abs(tp.y - y) <= margin) {
        return { compId: comp.id, termId: term.id, x: tp.x, y: tp.y, side: term.side }
      }
    }
  }
  return null
}

function hitTestComp(x, y) {
  for (let i = _diagram.components.length-1; i >= 0; i--) {
    const comp = _diagram.components[i]
    const def = getCompDef(comp.type)
    if (!def) continue
    if (x >= comp.x && x <= comp.x+def.w && y >= comp.y && y <= comp.y+def.h) return comp
  }
  return null
}

function saveUndo() {
  _undoStack.push(JSON.stringify(_diagram))
  if (_undoStack.length > 50) _undoStack.shift()
}

function undo() {
  if (!_undoStack.length) return
  _diagram = JSON.parse(_undoStack.pop())
  renderCanvas()
}

// ── SVG Rendering ──────────────────────────────────────────────────────────
const BG_DARK  = '#161b22'
const BG_COMP  = '#1e2530'

// ICT Access Controller silhouette (Protégé WX/GX style)
function renderIctController(comp, def, sel) {
  const { x, y } = comp
  const w = def.w, h = def.h
  const label = comp.label || def.label
  const hue = def.hue || '#123456'
  // DIN-rail metal enclosure with LED indicators and terminal blocks
  const ledColors = ['#22c55e','#22c55e','#f59e0b','#ef4444','#22c55e','#22c55e']
  const nLeds = Math.min(6, Math.floor((h - 60) / 18))
  return `<g class="dg-comp" data-id="${comp.id}" style="cursor:move" data-type="${comp.type}">
    <!-- shadow -->
    <rect x="${x+4}" y="${y+4}" width="${w}" height="${h}" rx="5" fill="#00000060"/>
    <!-- main enclosure - brushed metal appearance -->
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="#1c2333" stroke="${sel?'#4a90e2':'#2a3a50'}" stroke-width="${sel?2:1}"/>
    <!-- metal panel texture -->
    <rect x="${x+1}" y="${y+1}" width="${w-2}" height="${h-2}" rx="4" fill="none" stroke="#ffffff08" stroke-width="1"/>
    <!-- DIN rail clip top -->
    <rect x="${x+10}" y="${y-3}" width="${w-20}" height="7" rx="2" fill="#3a4a5a" stroke="#4a5a6a" stroke-width="0.5"/>
    <!-- DIN rail clip bottom -->
    <rect x="${x+10}" y="${y+h-4}" width="${w-20}" height="7" rx="2" fill="#3a4a5a" stroke="#4a5a6a" stroke-width="0.5"/>
    <!-- header brand strip -->
    <rect x="${x}" y="${y}" width="${w}" height="30" rx="5" fill="${hue}ee"/>
    <rect x="${x}" y="${y+26}" width="${w}" height="4" fill="${hue}cc"/>
    <!-- mounting screw holes -->
    <circle cx="${x+8}" cy="${y+8}" r="3" fill="#0a0f18" stroke="#2a3a50" stroke-width="0.5"/>
    <circle cx="${x+w-8}" cy="${y+8}" r="3" fill="#0a0f18" stroke="#2a3a50" stroke-width="0.5"/>
    <!-- brand text -->
    <text x="${x+w/2}" y="${y+13}" font-family="Inter,monospace" font-size="8" font-weight="800"
      fill="#4af" text-anchor="middle" letter-spacing="2">ICT</text>
    <!-- model label -->
    <text x="${x+w/2}" y="${y+23}" font-family="Inter,sans-serif" font-size="9" font-weight="600"
      fill="#ffffffdd" text-anchor="middle">${esc(label)}</text>
    <!-- LED indicator panel -->
    <rect x="${x+8}" y="${y+36}" width="12" height="${nLeds*18+4}" rx="2" fill="#0a0f18" stroke="#2a3a50" stroke-width="0.5"/>
    ${Array.from({length:nLeds},(_,i)=>`
      <circle cx="${x+14}" cy="${y+42+i*18}" r="4" fill="${ledColors[i%ledColors.length]}" opacity="${_simulating?0.95:0.5}" filter="${_simulating?'url(#led-glow)':''}"/>
      <circle cx="${x+14}" cy="${y+42+i*18}" r="2" fill="#ffffff60"/>
    `).join('')}
    <!-- front panel ribs (decorative) -->
    ${Array.from({length:4},(_,i)=>`<line x1="${x+26}" y1="${y+38+i*14}" x2="${x+w-8}" y2="${y+38+i*14}" stroke="#ffffff08" stroke-width="1"/>`).join('')}
    <!-- RS-485 / ETH port indicator -->
    <rect x="${x+w-22}" y="${y+36}" width="16" height="10}" rx="1" fill="#0a0f18" stroke="#2a3a50" stroke-width="0.5"/>
    <rect x="${x+w-20}" y="${y+38}" width="12" height="6" rx="1" fill="#1a2a3a"/>
    <!-- Terminals -->
    ${def.terminals.map(t => renderTermSvg(comp, t)).join('')}
    ${sel?`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="none" stroke="#4a90e2" stroke-width="2" opacity="0.5"/>`:''}
  </g>`
}

// Card reader silhouette (Wiegand / OSDP)
function renderIctReader(comp, def, sel) {
  const { x, y } = comp
  const w = def.w, h = def.h
  const label = comp.label || def.label
  const isOsdp = comp.type === 'reader_osdp'
  const bodyColor = isOsdp ? '#1a1a2e' : '#1a1a1a'
  return `<g class="dg-comp" data-id="${comp.id}" style="cursor:move" data-type="${comp.type}">
    <!-- shadow -->
    <rect x="${x+3}" y="${y+3}" width="${w}" height="${h}" rx="10" fill="#00000050"/>
    <!-- reader body — portrait housing -->
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"
      fill="${bodyColor}" stroke="${sel?'#4a90e2':'#333'}" stroke-width="${sel?2:1}"/>
    <!-- subtle bevel -->
    <rect x="${x+2}" y="${y+2}" width="${w-4}" height="${h-4}" rx="8" fill="none" stroke="#ffffff10" stroke-width="1"/>
    <!-- keypad area (lower 60%) -->
    <rect x="${x+10}" y="${y+h*0.35}" width="${w-20}" height="${h*0.52}" rx="4"
      fill="#111" stroke="#2a2a2a" stroke-width="0.5"/>
    <!-- keypad grid (3×4) -->
    ${Array.from({length:4},(_,row)=>Array.from({length:3},(_,col)=>`
      <rect x="${x+13+col*((w-26)/3)}" y="${y+h*0.38+row*((h*0.45)/4)}"
        width="${(w-34)/3}" height="${(h*0.41)/4.5}" rx="2"
        fill="${row===3&&col===1?'#1a6a1a':'#1e1e1e'}" stroke="#2a2a2a" stroke-width="0.5"/>
    `).join('')).join('')}
    <!-- display strip (top) -->
    <rect x="${x+10}" y="${y+h*0.1}" width="${w-20}" height="${h*0.18}" rx="3" fill="#001a00" stroke="#003300" stroke-width="0.5"/>
    <rect x="${x+12}" y="${y+h*0.12}" width="${w-24}" height="${h*0.14}" rx="2" fill="#002200" opacity="0.8"/>
    <!-- status LED -->
    <circle cx="${x+w/2}" cy="${y+h*0.07}" r="4" fill="${_simulating?'#22c55e':'#113311'}" stroke="#1a3a1a" stroke-width="0.5"/>
    <circle cx="${x+w/2}" cy="${y+h*0.07}" r="2" fill="#ffffff40"/>
    <!-- brand label -->
    <text x="${x+w/2}" y="${y+h*0.94}" font-family="Inter,monospace" font-size="8" font-weight="700"
      fill="#666" text-anchor="middle">${isOsdp?'OSDP':'WIEGAND'}</text>
    <text x="${x+w/2}" y="${y+h*0.06+2}" font-family="Inter,sans-serif" font-size="8"
      fill="#ffffff60" text-anchor="middle">${esc(label)}</text>
    ${def.terminals.map(t => renderTermSvg(comp, t)).join('')}
    ${sel?`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="none" stroke="#4a90e2" stroke-width="2" opacity="0.5"/>`:''}
  </g>`
}

// PSU / transformer silhouette
function renderPsu(comp, def, sel) {
  const { x, y } = comp
  const w = def.w, h = def.h
  const label = comp.label || def.label
  const hue = def.hue || '#333'
  const is24 = comp.type === 'psu_24v' || comp.type === 'transformer_24v'
  return `<g class="dg-comp" data-id="${comp.id}" style="cursor:move" data-type="${comp.type}">
    <!-- shadow -->
    <rect x="${x+4}" y="${y+4}" width="${w}" height="${h}" rx="4" fill="#00000060"/>
    <!-- PSU metal case -->
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="#1a1e24" stroke="${sel?'#4a90e2':'#333'}" stroke-width="${sel?2:1}"/>
    <!-- ventilation slots -->
    ${Array.from({length:6},(_,i)=>`<rect x="${x+8}" y="${y+h*0.35+i*10}" width="${w-16}" height="4" rx="1" fill="#101418"/>`).join('')}
    <!-- label plate -->
    <rect x="${x+6}" y="${y+8}" width="${w-12}" height="22" rx="2" fill="#f0e8d0" opacity="0.9"/>
    <text x="${x+w/2}" y="${y+14}" font-family="monospace" font-size="7" font-weight="700"
      fill="#1a1000" text-anchor="middle">POWER SUPPLY</text>
    <text x="${x+w/2}" y="${y+24}" font-family="monospace" font-size="8" font-weight="800"
      fill="#8b0000" text-anchor="middle">${is24?'24':'12'}VDC</text>
    <!-- output LED -->
    <circle cx="${x+w-14}" cy="${y+h*0.22}" r="5" fill="${_simulating?'#22c55e':'#0a1a0a'}" stroke="#1a3a1a" stroke-width="0.5"/>
    <circle cx="${x+w-14}" cy="${y+h*0.22}" r="2.5" fill="#ffffff30"/>
    <text x="${x+w-14}" y="${y+h*0.22+14}" font-family="Inter,sans-serif" font-size="7" fill="#22c55e80" text-anchor="middle">OUT</text>
    ${def.terminals.map(t => renderTermSvg(comp, t)).join('')}
    ${sel?`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="none" stroke="#4a90e2" stroke-width="2" opacity="0.5"/>`:''}
  </g>`
}

function renderCanvas() {
  if (!_svgEl) return
  const W = _svgEl.clientWidth || 900
  const H = _svgEl.clientHeight || 640

  const sel = _selected
  const allPts = computeAllWirePts()
  const crossingsByWire = findCrossings(allPts)

  _svgEl.innerHTML = `
    <defs>
      <pattern id="grid-sm" width="${GRID}" height="${GRID}" patternUnits="userSpaceOnUse">
        <path d="M ${GRID} 0 L 0 0 0 ${GRID}" fill="none" stroke="#ffffff0d" stroke-width="0.5"/>
      </pattern>
      <pattern id="grid-lg" width="${GRID*5}" height="${GRID*5}" patternUnits="userSpaceOnUse">
        <rect width="${GRID*5}" height="${GRID*5}" fill="url(#grid-sm)"/>
        <path d="M ${GRID*5} 0 L 0 0 0 ${GRID*5}" fill="none" stroke="#ffffff18" stroke-width="1"/>
      </pattern>
      <marker id="arrow-end" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 z" fill="#888" opacity="0.7"/>
      </marker>
      <filter id="led-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="2" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>

    <!-- Background -->
    <rect width="${W}" height="${H}" fill="${BG_DARK}"/>
    <rect width="${W}" height="${H}" fill="url(#grid-lg)"/>

    <!-- World transform -->
    <g transform="translate(${_pan.x},${_pan.y}) scale(${_zoom})">

      <!-- Wires (drawn below components) -->
      <g id="wires-layer">
        ${_diagram.wires.map(w => renderWireSvg(w, sel?.type==='wire'&&sel.id===w.id, allPts[w.id]||[], crossingsByWire[w.id]||[])).join('')}
        ${_wirePreview && _wireStart ? renderWirePreviewSvg() : ''}
      </g>

      <!-- Components -->
      <g id="comps-layer">
        ${_diagram.components.map(c => renderCompSvg(c, sel?.type==='comp'&&sel.id===c.id)).join('')}
      </g>

      <!-- Labels -->
      <g id="labels-layer">
        ${_diagram.labels.map(l => renderLabelSvg(l, sel?.type==='label'&&sel.id===l.id)).join('')}
      </g>
    </g>`

  bindSvgEvents()
}

function renderCustomCompSvg(comp, def, sel) {
  const { x, y } = comp
  const w = def.w, h = def.h
  const hue = def.hue || '#2a3a5a'
  return `<g class="dg-comp" data-id="${comp.id}" style="cursor:move">
    <!-- shadow -->
    <rect x="${x+3}" y="${y+3}" width="${w}" height="${h}" rx="6" fill="#00000040"/>
    <!-- body -->
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"
      fill="#1c2535" stroke="${sel?'#4a90e2':hue}" stroke-width="${sel?2.5:1.5}"/>
    <!-- header bar -->
    <rect x="${x}" y="${y}" width="${w}" height="${HEADER_H}" rx="6" fill="${hue}cc"/>
    <rect x="${x}" y="${y+HEADER_H-4}" width="${w}" height="4" fill="${hue}cc"/>
    <!-- label -->
    <text x="${x+w/2}" y="${y+HEADER_H/2+1}"
      font-family="Inter,sans-serif" font-size="10" font-weight="700" fill="#fff"
      text-anchor="middle" dominant-baseline="middle">${esc(comp.label || def.label)}</text>
    <!-- terminals -->
    ${def.terminals.map(t => renderTermSvg(comp, t)).join('')}
  </g>`
}

function renderCompSvg(comp, isSelected) {
  const def = getCompDef(comp.type)
  if (!def) return ''
  // Custom components use the generic box renderer
  if (comp.type.startsWith('custom_')) return renderCustomCompSvg(comp, def, isSelected)
  const { x, y } = comp
  const w = def.w, h = def.h
  const hue = def.hue || '#333'
  const sel = isSelected

  // ── Junction node ────────────────────────────────────────────────────────
  if (comp.type === 'junction_node') {
    return `<g class="dg-comp" data-id="${comp.id}" style="cursor:move">
      <circle cx="${x+20}" cy="${y+20}" r="8" fill="${sel?'#4a90e2':'#666'}" stroke="${sel?'#6ab':'#444'}" stroke-width="1.5"/>
      ${def.terminals.map(t => renderTermSvg(comp, t)).join('')}
    </g>`
  }

  // ── Text label ───────────────────────────────────────────────────────────
  if (comp.type === 'text_label') {
    return `<g class="dg-comp dg-label-comp" data-id="${comp.id}" style="cursor:move">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${sel?'#1e3a5a':'transparent'}" stroke="${sel?'#4a90e2':'#ffffff22'}" stroke-width="1" stroke-dasharray="4,3" rx="3"/>
      <text x="${x+6}" y="${y+30}" font-family="Inter,sans-serif" font-size="14" fill="#e0e0e0">${esc(comp.label||'Text')}</text>
    </g>`
  }

  // ── Butt connector / splice ───────────────────────────────────────────────
  if (comp.type === 'butt_connector') {
    const cx = x + w/2, cy = y + h/2
    const rw = w*0.38, rh = h*0.28
    return `<g class="dg-comp" data-id="${comp.id}" style="cursor:move">
      <!-- shadow -->
      <ellipse cx="${cx+2}" cy="${cy+2}" rx="${rw}" ry="${rh}" fill="#00000050"/>
      <!-- body: cylindrical butt connector shape -->
      <rect x="${x+6}" y="${cy-rh}" width="${w-12}" height="${rh*2}" rx="4" fill="#8a6000" stroke="${sel?'#4a90e2':'#b88000'}" stroke-width="${sel?2:1}"/>
      <!-- left crimp band -->
      <rect x="${x+6}" y="${cy-rh}" width="10" height="${rh*2}" rx="3" fill="#c8a000" opacity="0.85"/>
      <!-- right crimp band -->
      <rect x="${x+w-16}" y="${cy-rh}" width="10" height="${rh*2}" rx="3" fill="#c8a000" opacity="0.85"/>
      <!-- center insulation -->
      <rect x="${x+22}" y="${cy-rh+2}" width="${w-44}" height="${rh*2-4}" rx="2" fill="#7a5000" opacity="0.7"/>
      <!-- metal glint -->
      <rect x="${x+8}" y="${cy-rh+2}" width="6" height="3" rx="1" fill="#ffe08040"/>
      <rect x="${x+w-14}" y="${cy-rh+2}" width="6" height="3" rx="1" fill="#ffe08040"/>
      <!-- label -->
      <text x="${cx}" y="${cy+rh+13}" font-family="Inter,sans-serif" font-size="9" fill="#e0c060"
        text-anchor="middle">${esc(comp.label||'Splice')}</text>
      ${def.terminals.map(t => renderTermSvg(comp, t)).join('')}
      ${sel?`<rect x="${x+6}" y="${cy-rh}" width="${w-12}" height="${rh*2}" rx="4" fill="none" stroke="#4a90e2" stroke-width="2" opacity="0.6"/>`:''}
    </g>`
  }

  // ── ICT controllers (Protégé WX, Door Expander, Input Expander) ──────────
  if (['ict_wx','ict_door_exp','ict_input_exp'].includes(comp.type)) {
    return renderIctController(comp, def, sel)
  }

  // ── Wiegand/OSDP reader ───────────────────────────────────────────────────
  if (['reader_wiegand','reader_osdp'].includes(comp.type)) {
    return renderIctReader(comp, def, sel)
  }

  // ── PSU ───────────────────────────────────────────────────────────────────
  if (['psu_12v','psu_24v','transformer_24v'].includes(comp.type)) {
    return renderPsu(comp, def, sel)
  }

  // ── Generic component ─────────────────────────────────────────────────────
  return `<g class="dg-comp" data-id="${comp.id}" style="cursor:move" data-type="${comp.type}">
    <rect x="${x+3}" y="${y+3}" width="${w}" height="${h}" rx="6" fill="#00000040"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"
      fill="${BG_COMP}" stroke="${sel?'#4a90e2':'#ffffff22'}" stroke-width="${sel?2:1}"/>
    <rect x="${x}" y="${y}" width="${w}" height="${HEADER_H}" rx="6" fill="${hue}cc"/>
    <rect x="${x}" y="${y+HEADER_H-4}" width="${w}" height="4" fill="${hue}cc"/>
    <text x="${x+w/2}" y="${y+HEADER_H-8}"
      font-family="Inter,sans-serif" font-size="11" font-weight="600"
      fill="#ffffffee" text-anchor="middle" dominant-baseline="middle">
      ${esc(comp.label || def.label)}
    </text>
    ${def.terminals.map(t => renderTermSvg(comp, t)).join('')}
    <!-- Selection glow -->
    ${isSelected ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="none" stroke="#4a90e2" stroke-width="2" opacity="0.5"/>` : ''}
  </g>`
}

function renderTermSvg(comp, term) {
  const { x, y, side } = getTermPos(comp, term.id)
  const LPAD = 8
  const lx = side==='L' ? x-LPAD : side==='R' ? x+LPAD : x
  const ly = side==='T' ? y-LPAD : side==='B' ? y+LPAD : y
  const anchor = side==='L' ? 'end' : side==='R' ? 'start' : 'middle'
  const dyBase = side==='T' ? '-0.4em' : side==='B' ? '0.9em' : '0.35em'

  const isWireActive = _mode==='wire'
  const isFromTerm = _wireStart?.compId===comp.id && _wireStart?.termId===term.id

  return `<g class="dg-term" data-comp="${comp.id}" data-term="${term.id}" style="cursor:crosshair">
    <circle cx="${x}" cy="${y}" r="${TERM_R+4}" fill="transparent"/>
    <circle cx="${x}" cy="${y}" r="${TERM_R}"
      fill="${isFromTerm?'#f59e0b':'#e8b44b'}"
      stroke="${isFromTerm?'#fff':'#2a2a2a'}"
      stroke-width="1.5" opacity="${isWireActive?1:0.8}"/>
    ${term.label ? `<text x="${lx}" y="${ly}"
      font-family="Inter,sans-serif" font-size="9.5" fill="#ffffffaa"
      text-anchor="${anchor}" dominant-baseline="middle">${esc(term.label)}</text>` : ''}
  </g>`
}

function renderWireSvg(wire, isSelected, pts, crossings) {
  if (!pts || pts.length < 2) return ''
  const col = wire.color || '#aaa'
  const pathD = buildWirePath(pts, crossings)

  let handles = ''
  if (isSelected) {
    // Segment-drag handles (squares at midpoints) — skip terminal stubs
    for (let i = 2; i <= pts.length - 2; i++) {
      const [x1, y1] = pts[i - 1], [x2, y2] = pts[i]
      if (Math.abs(x1-x2) < 1 && Math.abs(y1-y2) < 1) continue
      const mx = (x1+x2)/2, my = (y1+y2)/2
      const isH = Math.abs(y1-y2) < 0.5
      handles += `<rect class="dg-wire-handle" data-wire="${wire.id}" data-seg="${i}"
        x="${mx-5}" y="${my-5}" width="10" height="10" rx="2"
        fill="#00b4d8" stroke="#fff" stroke-width="1.5" opacity="0.85"
        style="cursor:${isH?'ns-resize':'ew-resize'}"/>`
    }
    // Vertex handles (circles at corner points) — for precise repositioning
    for (let i = 1; i < pts.length - 1; i++) {
      const [vx, vy] = pts[i]
      handles += `<circle class="dg-wire-vertex" data-wire="${wire.id}" data-pt="${i}"
        cx="${vx}" cy="${vy}" r="5"
        fill="#ff9800" stroke="#fff" stroke-width="1.5" opacity="0.92"
        style="cursor:move"/>`
    }
  }

  const fp = pts[0], tp = pts[pts.length - 1]
  const mid = pts[Math.floor(pts.length / 2)]

  // Flow animation via SMIL (reliable in SVG regardless of CSS context)
  let flowPath = ''
  if (_simulating) {
    const sig = getWireSignalType(wire)
    const a = SIGNAL_ANIM[sig] || SIGNAL_ANIM.generic
    const animCol = a.color || col
    flowPath = `<path d="${pathD}" fill="none" stroke="${animCol}"
      stroke-width="${isSelected?3.5:2.5}" stroke-dasharray="${a.dasharray}"
      stroke-linejoin="round" stroke-linecap="round" opacity="0.85">
      <animate attributeName="stroke-dashoffset" from="0" to="-${a.offset}" dur="${a.dur}" repeatCount="indefinite"/>
    </path>`
  }

  return `<g class="dg-wire" data-id="${wire.id}" style="cursor:pointer">
    <path d="${pathD}" fill="none" stroke="transparent" stroke-width="12" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="${pathD}" fill="none" stroke="#00000080" stroke-width="${isSelected?4:3}" stroke-linejoin="round" stroke-linecap="round" transform="translate(1,1)"/>
    <path d="${pathD}" fill="none" stroke="${col}" stroke-width="${isSelected?3:2}" stroke-linejoin="round" stroke-linecap="round"/>
    ${flowPath}
    ${wire.label ? `<text x="${mid[0]+4}" y="${mid[1]-6}" font-size="9" fill="${col}" font-family="Inter,sans-serif" opacity="0.9">${esc(wire.label)}</text>` : ''}
    <circle cx="${fp[0]}" cy="${fp[1]}" r="3.5" fill="${col}"/>
    <circle cx="${tp[0]}" cy="${tp[1]}" r="3.5" fill="${col}"/>
    ${handles}
  </g>`
}

function renderWirePreviewSvg() {
  if (!_wireStart || !_wirePreview) return ''
  const col = _activeColor || '#f59e0b'
  return `<line
    x1="${_wireStart.x}" y1="${_wireStart.y}"
    x2="${_wirePreview.x}" y2="${_wirePreview.y}"
    stroke="${col}" stroke-width="2" stroke-dasharray="6,4"
    stroke-linecap="round" opacity="0.8"/>`
}

function renderLabelSvg(label, isSelected) {
  return `<g class="dg-label" data-id="${label.id}" style="cursor:move">
    <rect x="${label.x-4}" y="${label.y-label.size-2}" width="${label.text.length*7.5}" height="${label.size+8}"
      fill="${isSelected?'#1e3a5a':'transparent'}" rx="3"
      stroke="${isSelected?'#4a90e2':'transparent'}"/>
    <text x="${label.x}" y="${label.y}" font-family="Inter,sans-serif"
      font-size="${label.size||13}" fill="${label.color||'#e0e0e0'}">${esc(label.text)}</text>
  </g>`
}

// ── SVG Events ─────────────────────────────────────────────────────────────
// Child element listeners are re-bound after every renderCanvas() because
// innerHTML replaces them. SVG-level listeners (mousedown/mousemove/wheel…)
// are guarded by _svgEventsBound so they accumulate only once, not once per
// frame — that was causing the freeze during drag/wire operations.
function bindSvgEvents() {
  if (!_svgEl) return

  // Component drag
  _svgEl.querySelectorAll('.dg-comp').forEach(el => {
    el.addEventListener('mousedown', e => {
      if (_mode !== 'select') return
      e.stopPropagation()
      const id = el.dataset.id
      const comp = _diagram.components.find(c => c.id === id)
      if (!comp) return
      const pos = svgXY(e)
      _drag = { type:'comp', id, ox:comp.x - pos.x, oy:comp.y - pos.y }
      _selected = { type:'comp', id }
      renderCanvas()
      renderProps()
    })
    el.addEventListener('dblclick', e => {
      const id = el.dataset.id
      const comp = _diagram.components.find(c => c.id === id)
      if (!comp) return
      const newLabel = prompt('Название компонента:', comp.label || getCompDef(comp.type)?.label || '')
      if (newLabel !== null) { saveUndo(); comp.label = newLabel; _diagram.modified = true; renderCanvas() }
    })
  })

  // Terminal click (start/end wire)
  _svgEl.querySelectorAll('.dg-term').forEach(el => {
    el.addEventListener('mousedown', e => {
      e.stopPropagation()
      const compId = el.dataset.comp
      const termId = el.dataset.term
      const comp = _diagram.components.find(c => c.id === compId)
      if (!comp) return
      const tp = getTermPos(comp, termId)

      if (_mode === 'select') {
        // Switch to wire mode temporarily
        _mode = 'wire'
        _wireStart = { compId, termId, x: tp.x, y: tp.y, side: tp.side }
        updateToolbar()
        return
      }

      if (_mode === 'wire') {
        if (_wireStart) {
          if (_wireStart.compId === compId && _wireStart.termId === termId) {
            // Cancel wire
            _wireStart = null; _wirePreview = null; _mode = 'select'
            updateToolbar(); renderCanvas(); return
          }
          // Complete wire
          saveUndo()
          _diagram.wires.push({
            id: uid(),
            color: _activeColor,
            label: '',
            from: { compId: _wireStart.compId, termId: _wireStart.termId },
            to:   { compId, termId },
          })
          _diagram.modified = true
          _wireStart = null; _wirePreview = null; _mode = 'select'
          updateToolbar(); renderCanvas(); return
        }
        _wireStart = { compId, termId, x: tp.x, y: tp.y, side: tp.side }
      }
    })
  })

  // Wire selection
  _svgEl.querySelectorAll('.dg-wire').forEach(el => {
    el.addEventListener('click', e => {
      if (_mode !== 'select') return
      e.stopPropagation()
      _selected = { type:'wire', id: el.dataset.id }
      renderCanvas(); renderProps()
    })
  })

  // Wire segment drag handles — perpendicular segment shift
  _svgEl.querySelectorAll('.dg-wire-handle').forEach(el => {
    el.addEventListener('mousedown', e => {
      e.stopPropagation()
      const wireId = el.dataset.wire
      const segIdx = parseInt(el.dataset.seg)
      const wire = _diagram.wires.find(w => w.id === wireId)
      if (!wire) return
      _drag = { type: 'wire-seg', wireId, segIdx, pts: buildWirePts(wire) }
      _selected = { type: 'wire', id: wireId }
    })
  })

  // Wire vertex handles — drag a corner point to reroute
  _svgEl.querySelectorAll('.dg-wire-vertex').forEach(el => {
    el.addEventListener('mousedown', e => {
      e.stopPropagation()
      const wireId = el.dataset.wire
      const ptIdx  = parseInt(el.dataset.pt)
      const wire = _diagram.wires.find(w => w.id === wireId)
      if (!wire) return
      _drag = { type: 'wire-vertex', wireId, ptIdx, pts: buildWirePts(wire).map(p => [...p]) }
      _selected = { type: 'wire', id: wireId }
    })
  })

  // Label drag
  _svgEl.querySelectorAll('.dg-label').forEach(el => {
    el.addEventListener('mousedown', e => {
      if (_mode !== 'select') return
      e.stopPropagation()
      const id = el.dataset.id
      const lbl = _diagram.labels.find(l => l.id === id)
      if (!lbl) return
      const pos = svgXY(e)
      _drag = { type:'label', id, ox: lbl.x - pos.x, oy: lbl.y - pos.y }
      _selected = { type:'label', id }
      renderCanvas(); renderProps()
    })
    el.addEventListener('dblclick', e => {
      const id = el.dataset.id
      const lbl = _diagram.labels.find(l => l.id === id)
      if (!lbl) return
      const t = prompt('Текст метки:', lbl.text)
      if (t !== null) { saveUndo(); lbl.text = t; _diagram.modified = true; renderCanvas() }
    })
  })

  // --- SVG-level events: bind ONCE only (these accumulate across renders) ---
  if (_svgEventsBound) return
  _svgEventsBound = true

  // Canvas pan + wire mouse move
  _svgEl.addEventListener('mousedown', e => {
    if (e.button === 1 || _mode === 'pan' || e.altKey) {
      _drag = { type:'canvas', startX: e.clientX - _pan.x, startY: e.clientY - _pan.y }
      return
    }
    if (_mode === 'select') {
      _selected = null; renderCanvas(); renderProps()
    }
  })

  _svgEl.addEventListener('mousemove', e => {
    if (_drag?.type === 'canvas') {
      _pan.x = e.clientX - _drag.startX
      _pan.y = e.clientY - _drag.startY
      renderCanvas(); return
    }
    if (_drag?.type === 'comp') {
      const comp = _diagram.components.find(c => c.id === _drag.id)
      if (comp) {
        const pos = svgXY(e)
        comp.x = snap(pos.x + _drag.ox)
        comp.y = snap(pos.y + _drag.oy)
        renderCanvas()
      }
      return
    }
    if (_drag?.type === 'label') {
      const lbl = _diagram.labels.find(l => l.id === _drag.id)
      if (lbl) {
        const pos = svgXY(e)
        lbl.x = snap(pos.x + _drag.ox)
        lbl.y = snap(pos.y + _drag.oy)
        renderCanvas()
      }
      return
    }
    if (_drag?.type === 'wire-seg') {
      const wire = _diagram.wires.find(w => w.id === _drag.wireId)
      if (wire) {
        const pos = svgXY(e)
        const si = _drag.segIdx
        const [x1, y1] = _drag.pts[si - 1]
        const [x2, y2] = _drag.pts[si]
        const newPts = _drag.pts.map(p => [...p])
        if (Math.abs(y1 - y2) < 0.5) {
          const newY = snap(pos.y)
          newPts[si - 1][1] = newY; newPts[si][1] = newY
        } else {
          const newX = snap(pos.x)
          newPts[si - 1][0] = newX; newPts[si][0] = newX
        }

        // Repin source and destination stubs so exit/entry side rule is never violated
        const fc = _diagram.components.find(c => c.id === wire.from?.compId)
        const tc = _diagram.components.find(c => c.id === wire.to?.compId)
        if (fc && tc) {
          const fp = getTermPos(fc, wire.from.termId)
          const tp = getTermPos(tc, wire.to.termId)
          const s = STUB
          // Terminal endpoints are immovable
          newPts[0] = [fp.x, fp.y]
          newPts[newPts.length - 1] = [tp.x, tp.y]
          // Source stub: lock perpendicular coord and enforce minimum exit distance
          if (fp.side === 'L' || fp.side === 'R') {
            newPts[1][1] = fp.y   // stub is horizontal — Y must not change
            if (fp.side === 'L' && newPts[1][0] > fp.x - s) newPts[1][0] = fp.x - s
            if (fp.side === 'R' && newPts[1][0] < fp.x + s) newPts[1][0] = fp.x + s
          } else {
            newPts[1][0] = fp.x   // stub is vertical — X must not change
            if (fp.side === 'T' && newPts[1][1] > fp.y - s) newPts[1][1] = fp.y - s
            if (fp.side === 'B' && newPts[1][1] < fp.y + s) newPts[1][1] = fp.y + s
          }
          // Destination stub: same logic
          const n = newPts.length
          if (tp.side === 'L' || tp.side === 'R') {
            newPts[n - 2][1] = tp.y
            if (tp.side === 'L' && newPts[n - 2][0] > tp.x - s) newPts[n - 2][0] = tp.x - s
            if (tp.side === 'R' && newPts[n - 2][0] < tp.x + s) newPts[n - 2][0] = tp.x + s
          } else {
            newPts[n - 2][0] = tp.x
            if (tp.side === 'T' && newPts[n - 2][1] > tp.y - s) newPts[n - 2][1] = tp.y - s
            if (tp.side === 'B' && newPts[n - 2][1] < tp.y + s) newPts[n - 2][1] = tp.y + s
          }
          // Fix any diagonal segments created by stub repinning
          wire.pts = manhattanize(dedupePts(newPts))
        } else {
          wire.pts = newPts
        }
        _diagram.modified = true
        renderCanvas()
      }
      return
    }
    if (_drag?.type === 'wire-vertex') {
      const wire = _diagram.wires.find(w => w.id === _drag.wireId)
      if (wire) {
        const pos = svgXY(e)
        const pi = _drag.ptIdx
        const newPts = _drag.pts.map(p => [...p])
        newPts[pi] = [snap(pos.x), snap(pos.y)]
        // Maintain Manhattan: update adjacent endpoints
        const prev = newPts[pi - 1]
        const nxt  = newPts[pi + 1]
        const origPrev = _drag.pts[pi - 1]
        const origCurr = _drag.pts[pi]
        if (prev) {
          const segBeforeIsH = Math.abs(origPrev[1] - origCurr[1]) < 2
          if (segBeforeIsH) prev[1] = newPts[pi][1]
          else               prev[0] = newPts[pi][0]
        }
        if (nxt) {
          const origNxt = _drag.pts[pi + 1]
          const segAfterIsH = Math.abs(origCurr[1] - origNxt[1]) < 2
          if (segAfterIsH) nxt[1] = newPts[pi][1]
          else              nxt[0] = newPts[pi][0]
        }
        wire.pts = newPts
        _diagram.modified = true
        renderCanvas()
      }
      return
    }
    if (_mode === 'wire' && _wireStart) {
      _wirePreview = svgXY(e)
      renderCanvas()
    }
  })

  _svgEl.addEventListener('mouseup', e => {
    if (_drag?.type === 'comp') {
      _diagram.modified = true
      saveUndo()
      // Clear manually-set wire paths for wires connected to this component
      const movedId = _drag.id
      _diagram.wires.forEach(w => {
        if (w.pts && (w.from?.compId === movedId || w.to?.compId === movedId)) {
          w.pts = null
        }
      })
    }
    if (_drag?.type === 'wire-seg') { saveUndo() }
    if (_drag?.type === 'wire-vertex') {
      const wire = _diagram.wires.find(w => w.id === _drag.wireId)
      if (wire?.pts) wire.pts = manhattanize(wire.pts)
      saveUndo()
    }
    _drag = null
  })

  // Scroll: two-finger swipe = pan canvas; pinch / ctrl+scroll = zoom
  _svgEl.addEventListener('wheel', e => {
    e.preventDefault()
    if (e.ctrlKey) {
      // Pinch-to-zoom or ctrl+scroll
      const delta = e.deltaY < 0 ? 1.1 : 0.91
      const rect = _svgEl.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const newZoom = Math.max(0.2, Math.min(3, _zoom * delta))
      _pan.x = cx - (cx - _pan.x) * (newZoom / _zoom)
      _pan.y = cy - (cy - _pan.y) * (newZoom / _zoom)
      _zoom = newZoom
    } else {
      // Two-finger trackpad swipe — pan
      _pan.x -= e.deltaX
      _pan.y -= e.deltaY
    }
    renderCanvas()
  }, { passive: false })

  // ── Touch: pan (1 finger) + pinch-to-zoom (2 fingers) ──────────────────
  let _touch = null  // { type:'pan'|'pinch', x, y, dist }
  function touchDist(t) {
    const dx = t[0].clientX - t[1].clientX
    const dy = t[0].clientY - t[1].clientY
    return Math.hypot(dx, dy)
  }
  _svgEl.addEventListener('touchstart', e => {
    e.preventDefault()
    if (e.touches.length === 1) {
      _touch = { type: 'pan', x: e.touches[0].clientX, y: e.touches[0].clientY }
    } else if (e.touches.length === 2) {
      _touch = { type: 'pinch', dist: touchDist(e.touches),
        midX: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        midY: (e.touches[0].clientY + e.touches[1].clientY) / 2 }
    }
  }, { passive: false })

  _svgEl.addEventListener('touchmove', e => {
    e.preventDefault()
    if (!_touch) return
    if (_touch.type === 'pan' && e.touches.length === 1) {
      _pan.x += e.touches[0].clientX - _touch.x
      _pan.y += e.touches[0].clientY - _touch.y
      _touch.x = e.touches[0].clientX
      _touch.y = e.touches[0].clientY
      renderCanvas()
    } else if (_touch.type === 'pinch' && e.touches.length === 2) {
      const newDist = touchDist(e.touches)
      const delta = newDist / _touch.dist
      const rect = _svgEl.getBoundingClientRect()
      const cx = _touch.midX - rect.left
      const cy = _touch.midY - rect.top
      const newZoom = Math.max(0.15, Math.min(4, _zoom * delta))
      _pan.x = cx - (cx - _pan.x) * (newZoom / _zoom)
      _pan.y = cy - (cy - _pan.y) * (newZoom / _zoom)
      _zoom = newZoom
      _touch.dist = newDist
      renderCanvas()
    }
  }, { passive: false })

  _svgEl.addEventListener('touchend', e => {
    if (e.touches.length === 0) _touch = null
    else if (e.touches.length === 1 && _touch?.type === 'pinch') {
      _touch = { type: 'pan', x: e.touches[0].clientX, y: e.touches[0].clientY }
    }
  }, { passive: false })

  // Double-click canvas → add text label
  _svgEl.addEventListener('dblclick', e => {
    if (e.target !== _svgEl && !e.target.closest('g')?.classList.contains('dg-comp') === false) return
    if (_mode !== 'select') return
    const pos = svgXY(e)
    const t = prompt('Текст метки:')
    if (!t) return
    saveUndo()
    _diagram.labels.push({ id: uid(), text: t, x: snap(pos.x), y: snap(pos.y), size: 13, color: '#e0e0e0' })
    _diagram.modified = true
    renderCanvas()
  })
}

// ── Drop from library ──────────────────────────────────────────────────────
function dropComponent(type, clientX, clientY) {
  if (!_svgEl) return
  const rect = _svgEl.getBoundingClientRect()
  const wx = (clientX - rect.left - _pan.x) / _zoom
  const wy = (clientY - rect.top  - _pan.y) / _zoom
  saveUndo()
  _diagram.components.push({
    id: uid(),
    type,
    x: snap(wx - (getCompDef(type)?.w || 160) / 2),
    y: snap(wy - (getCompDef(type)?.h || 120) / 2),
    label: '',
  })
  _diagram.modified = true
  renderCanvas()
}

// ── Properties panel ───────────────────────────────────────────────────────
function renderProps() {
  const panel = _el?.querySelector('.dg-props')
  if (!panel) return

  if (!_selected) {
    panel.innerHTML = `<div class="dg-props-empty">
      <i class="ti ti-hand-finger"></i>
      <p>Выберите элемент для настройки</p>
      <p style="font-size:11px;color:var(--text-4);margin-top:4px">Двойной клик по компоненту — переименовать</p>
    </div>`
    return
  }

  if (_selected.type === 'comp') {
    const comp = _diagram.components.find(c => c.id === _selected.id)
    if (!comp) return
    const def = getCompDef(comp.type)
    panel.innerHTML = `
      <div class="dg-props-title"><i class="ti ti-cpu"></i> Компонент</div>
      <div class="ui-form-row" style="margin-bottom:8px">
        <label style="font-size:11px;color:var(--text-4)">Тип</label>
        <div style="font-size:12px;color:var(--text-2)">${def?.label || comp.type}</div>
      </div>
      ${def?.desc ? `<p style="font-size:11px;color:var(--text-4);margin-bottom:10px;line-height:1.5">${esc(def.desc)}</p>` : ''}
      <div class="ui-form-row" style="margin-bottom:8px">
        <label style="font-size:11px;color:var(--text-4)">Название</label>
        <input class="ui-input" id="prop-label" value="${esc(comp.label||'')}">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">
        <div class="ui-form-row">
          <label style="font-size:11px;color:var(--text-4)">X</label>
          <input class="ui-input" type="number" id="prop-x" value="${comp.x}">
        </div>
        <div class="ui-form-row">
          <label style="font-size:11px;color:var(--text-4)">Y</label>
          <input class="ui-input" type="number" id="prop-y" value="${comp.y}">
        </div>
      </div>
      <button class="ui-btn ui-btn--danger" id="prop-delete" style="width:100%;margin-top:8px">
        <i class="ti ti-trash"></i> Удалить
      </button>`

    panel.querySelector('#prop-label')?.addEventListener('change', e => {
      comp.label = e.target.value; _diagram.modified = true; renderCanvas()
    })
    panel.querySelector('#prop-x')?.addEventListener('change', e => {
      comp.x = snap(+e.target.value); _diagram.modified = true; renderCanvas()
    })
    panel.querySelector('#prop-y')?.addEventListener('change', e => {
      comp.y = snap(+e.target.value); _diagram.modified = true; renderCanvas()
    })
    panel.querySelector('#prop-delete')?.addEventListener('click', () => {
      saveUndo()
      _diagram.components = _diagram.components.filter(c => c.id !== _selected.id)
      _diagram.wires = _diagram.wires.filter(w => w.from?.compId !== _selected.id && w.to?.compId !== _selected.id)
      _diagram.modified = true; _selected = null; renderCanvas(); renderProps()
    })
  }

  if (_selected.type === 'wire') {
    const wire = _diagram.wires.find(w => w.id === _selected.id)
    if (!wire) return
    panel.innerHTML = `
      <div class="dg-props-title"><i class="ti ti-minus"></i> Провод</div>
      <div class="ui-form-row" style="margin-bottom:8px">
        <label style="font-size:11px;color:var(--text-4)">Цвет</label>
        <div class="dg-wire-colors">
          ${WIRE_COLORS.map(c => `
            <div class="dg-color-dot ${wire.color===c.hex?'active':''}" data-hex="${c.hex}"
              title="${esc(c.label)}" style="background:${c.hex}"></div>`).join('')}
          <input type="color" class="dg-color-custom" value="${wire.color||'#aaa'}" title="Свой цвет">
        </div>
      </div>
      <div class="ui-form-row" style="margin-bottom:10px">
        <label style="font-size:11px;color:var(--text-4)">Метка провода</label>
        <input class="ui-input" id="prop-wire-label" value="${esc(wire.label||'')}">
      </div>
      <button class="ui-btn" id="prop-wire-reset" style="width:100%;margin-bottom:6px">
        <i class="ti ti-refresh"></i> Сбросить путь (авто)
      </button>
      <button class="ui-btn ui-btn--danger" id="prop-wire-delete" style="width:100%">
        <i class="ti ti-trash"></i> Удалить провод
      </button>`

    panel.querySelectorAll('.dg-color-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        wire.color = dot.dataset.hex
        _diagram.modified = true; renderCanvas(); renderProps()
      })
    })
    panel.querySelector('.dg-color-custom')?.addEventListener('input', e => {
      wire.color = e.target.value; _diagram.modified = true; renderCanvas()
    })
    panel.querySelector('#prop-wire-label')?.addEventListener('change', e => {
      wire.label = e.target.value; _diagram.modified = true; renderCanvas()
    })
    panel.querySelector('#prop-wire-reset')?.addEventListener('click', () => {
      wire.pts = null; wire.waypoints = null; _diagram.modified = true; renderCanvas(); renderProps()
    })
    panel.querySelector('#prop-wire-delete')?.addEventListener('click', () => {
      saveUndo()
      _diagram.wires = _diagram.wires.filter(w => w.id !== _selected.id)
      _diagram.modified = true; _selected = null; renderCanvas(); renderProps()
    })
  }
}

// ── Toolbar ────────────────────────────────────────────────────────────────
function updateToolbar() {
  _el?.querySelectorAll('.dg-tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === _mode)
  })
  const colorEl = _el?.querySelector('.dg-active-color')
  if (colorEl) colorEl.style.background = _activeColor
  const modeEl = _el?.querySelector('.dg-mode-label')
  if (modeEl) modeEl.textContent = ({
    select:'Выбор', wire:'Провод', pan:'Перемещение'
  })[_mode] || _mode
}

// ── Save / Load ────────────────────────────────────────────────────────────
async function saveDiagram() {
  const name = _el?.querySelector('#dg-name')?.value?.trim() || _diagram.name || 'Схема'
  _diagram.name = name

  // Export SVG string from current canvas
  const svgClone = _svgEl?.cloneNode(true)

  const content = `## ${esc(name)}\n\n*Интерактивная схема подключения*\n\n` +
    `\`\`\`json\n${JSON.stringify(_diagram, null, 2)}\n\`\`\``

  try {
    const url = _editId ? `/api/v1/wiki/${_editId}` : '/api/v1/wiki'
    const resp = await apiPost(url, {
      title: name,
      category: 'Схемы',
      pageType: 'schema',
      content,
      metadata: { diagramJson: JSON.stringify(_diagram) },
      tags: ['схема', 'подключение'],
    })
    const data = await resp.json()
    const page = data.page || data
    if (page?.id) _editId = page.id
    _diagram.modified = false
    window.toast?.('Схема сохранена в Wiki', 'success')
    await loadDiagramList()
    renderDiagramList()
  } catch (err) {
    window.toast?.('Ошибка сохранения: ' + err.message, 'error')
  }
}

async function loadDiagramList() {
  try {
    const d = await apiJSON('/api/v1/wiki')
    _diagrams = (d.pages || []).filter(p => p.page_type === 'schema')
  } catch {}
}

async function openDiagram(page) {
  let parsed = null
  try {
    let meta = page.metadata
    if (typeof meta === 'string') meta = JSON.parse(meta)
    if (meta?.diagramJson) parsed = JSON.parse(meta.diagramJson)
  } catch {}

  if (!parsed) {
    // Try extracting from content code block
    const match = (page.content || '').match(/```json\n([\s\S]+?)\n```/)
    if (match) try { parsed = JSON.parse(match[1]) } catch {}
  }

  _diagram = parsed || newDiagram()
  _diagram.name = page.title || _diagram.name
  _diagram.customDefs = _diagram.customDefs || []
  _editId = page.id
  _undoStack = []
  showEditor()
}

// ── Layout render ──────────────────────────────────────────────────────────
function renderDiagramList() {
  const list = _el?.querySelector('.dg-list')
  if (!list) return

  list.innerHTML = !_diagrams.length
    ? `<div class="dg-list-empty">
        <i class="ti ti-schema"></i>
        <p>Нет сохранённых схем. Создайте первую!</p>
       </div>`
    : _diagrams.map(d => `
        <div class="dg-diagram-card" data-id="${esc(d.id)}">
          <div class="dg-diagram-card-icon"><i class="ti ti-schema"></i></div>
          <div class="dg-diagram-card-info">
            <div class="dg-diagram-card-name">${esc(d.title)}</div>
            <div class="dg-diagram-card-meta">${esc(d.updated_by||'')} · ${d.updated_at?.slice(0,10)||''}</div>
          </div>
          <button class="dg-diagram-open" data-id="${esc(d.id)}"><i class="ti ti-arrow-right"></i></button>
        </div>`).join('')

  list.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', e => {
      const id = el.closest('[data-id]')?.dataset?.id || el.dataset.id
      const page = _diagrams.find(d => d.id === id)
      if (page) openDiagram(page)
    })
  })
}

function renderLibraryCustomDefs() {
  const catEl = _el?.querySelector('.dg-lib-cat')
  if (!catEl) return
  const defs = _diagram.customDefs || []
  const items = defs.map(def => `
    <div class="dg-lib-item" draggable="true" data-type="${esc(def.id)}" style="position:relative">
      <i class="ti ti-puzzle" style="color:${esc(def.hue||'#4a90e2')}"></i>
      <span>${esc(def.label)}</span>
      <button class="dg-edit-custom-btn" data-def-id="${esc(def.id)}" title="Редактировать" style="margin-left:auto;padding:2px 5px;background:transparent;border:none;cursor:pointer;color:var(--text-4);font-size:13px">✏️</button>
    </div>`).join('')
  catEl.innerHTML = `
    <div class="dg-lib-cat-label"><i class="ti ti-tools"></i> Кастом</div>
    ${items}
    <button class="dg-add-custom-btn" id="dg-add-custom">
      <i class="ti ti-plus"></i> Новый элемент
    </button>`
  catEl.querySelectorAll('[draggable]').forEach(el => {
    el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', el.dataset.type); _dragType = el.dataset.type })
  })
  catEl.querySelector('#dg-add-custom')?.addEventListener('click', () => openCustomCompModal())
  catEl.querySelectorAll('.dg-edit-custom-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const existingDef = (_diagram.customDefs || []).find(d => d.id === btn.dataset.defId)
      if (existingDef) openCustomCompModal(existingDef)
    })
  })
}

function showEditor() {
  const home = _el?.querySelector('.dg-home')
  const editor = _el?.querySelector('.dg-editor')
  if (home) home.style.display = 'none'
  if (editor) editor.style.display = 'flex'

  const nameEl = _el?.querySelector('#dg-name')
  if (nameEl) nameEl.value = _diagram.name

  _pan = { x: 80, y: 80 }; _zoom = 1
  _mode = 'select'; _wireStart = null; _wirePreview = null; _selected = null

  renderCanvas()
  updateToolbar()
  renderProps()
  renderLibraryCustomDefs()

  // Mobile: show touch hint once
  if (window.innerWidth <= 768 && _svgEl) {
    const hint = document.createElement('div')
    hint.className = 'dg-mobile-hint'
    hint.textContent = '1 палец — сдвиг · 2 пальца — масштаб'
    _svgEl.parentElement?.appendChild(hint)
    setTimeout(() => hint.remove(), 4500)
  }
}

function showHome() {
  const home = _el?.querySelector('.dg-home')
  const editor = _el?.querySelector('.dg-editor')
  if (home) home.style.display = ''
  if (editor) editor.style.display = 'none'
  _editId = null
  renderDiagramList()
}

// ── Main render ────────────────────────────────────────────────────────────
function render() {
  if (!_el) return
  _el.innerHTML = `
    <!-- Home (diagram list) -->
    <div class="dg-home">
      <div class="dg-home-header">
        <div>
          <h1 class="dg-home-title"><i class="ti ti-schema"></i> Схемы подключения</h1>
          <p class="dg-home-sub">Конструктор монтажных схем — ICT Access Control, Low Voltage, HVAC</p>
        </div>
        <button class="ui-btn ui-btn--primary" id="dg-new-btn">
          <i class="ti ti-plus"></i> Новая схема
        </button>
      </div>

      <!-- Component reference -->
      <div class="dg-ref-banner">
        <i class="ti ti-info-circle"></i>
        Доступные компоненты: ICT Protégé WX/GX, Door Expanders, Wiegand/OSDP readers, Electric Strikes, Maglocks, PIR REX, PSU 12/24V, Relays, HVAC terminals
      </div>

      <div class="dg-list" id="dg-list">
        ${loadingSpinner('Загрузка схем…')}
      </div>
    </div>

    <!-- Editor -->
    <div class="dg-editor" style="display:none">
      <!-- Toolbar -->
      <div class="dg-toolbar">
        <button class="dg-back-btn" id="dg-back"><i class="ti ti-arrow-left"></i></button>
        <input class="dg-name-input" id="dg-name" value="${esc(_diagram.name)}" placeholder="Название схемы…">

        <div class="dg-toolbar-sep"></div>

        <!-- Tools -->
        <button class="dg-tool-btn active" data-mode="select" title="Выбор (V)">
          <i class="ti ti-cursor-arrow"></i>
        </button>
        <button class="dg-tool-btn" data-mode="wire" title="Провод (W)">
          <i class="ti ti-minus"></i>
        </button>
        <button class="dg-tool-btn" data-mode="pan" title="Перемещение (Space)">
          <i class="ti ti-hand-grab"></i>
        </button>

        <div class="dg-toolbar-sep"></div>

        <!-- Wire color -->
        <div class="dg-wire-color-picker">
          ${WIRE_COLORS.map(c => `
            <div class="dg-color-dot ${c.hex===_activeColor?'active':''}" data-hex="${c.hex}"
              title="${esc(c.label)}" style="background:${c.hex}"></div>`).join('')}
        </div>

        <div class="dg-toolbar-sep"></div>

        <!-- Actions -->
        <button class="dg-action-btn" id="dg-undo" title="Undo (Ctrl+Z)"><i class="ti ti-arrow-back-up"></i></button>
        <button class="dg-action-btn" id="dg-center" title="По центру"><i class="ti ti-focus-centered"></i></button>
        <button class="dg-action-btn" id="dg-delete-sel" title="Удалить (Del)"><i class="ti ti-trash"></i></button>

        <div class="dg-toolbar-sep"></div>

        <button class="dg-action-btn ${_simulating?'active':''}" id="dg-simulate" title="Симуляция тока (S)" style="${_simulating?'color:#22c55e':''}" >
          <i class="ti ti-bolt"></i>
        </button>

        <span class="dg-mode-label">Выбор</span>
        <button class="ui-btn ui-btn--primary" id="dg-save-btn">
          <i class="ti ti-device-floppy"></i> Сохранить
        </button>
      </div>

      <!-- Main area -->
      <div class="dg-main">
        <!-- Library sidebar -->
        <div class="dg-library">
          <div class="dg-library-title">Компоненты</div>
          <div class="dg-library-scroll">
            <div class="dg-lib-cat">
              <div class="dg-lib-cat-label"><i class="ti ti-tools"></i> Кастом</div>
              ${(_diagram.customDefs || []).map(def => `
                <div class="dg-lib-item" draggable="true" data-type="${esc(def.id)}" style="position:relative">
                  <i class="ti ti-puzzle" style="color:${esc(def.hue||'#4a90e2')}"></i>
                  <span>${esc(def.label)}</span>
                  <button class="dg-edit-custom-btn" data-def-id="${esc(def.id)}" title="Редактировать" style="margin-left:auto;padding:2px 5px;background:transparent;border:none;cursor:pointer;color:var(--text-4);font-size:13px">✏️</button>
                </div>`).join('')}
              <button class="dg-add-custom-btn" id="dg-add-custom">
                <i class="ti ti-plus"></i> Новый элемент
              </button>
            </div>
            ${Object.entries(CATEGORIES).map(([catKey, catDef]) => {
              const items = Object.entries(COMP_DEFS).filter(([,d]) => d.category === catKey)
              if (!items.length) return ''
              return `<div class="dg-lib-cat">
                <div class="dg-lib-cat-label"><i class="ti ${catDef.icon}"></i> ${catDef.label}</div>
                ${items.map(([type, def]) => `
                  <div class="dg-lib-item" draggable="true" data-type="${type}" title="${esc(def.desc||'')}">
                    <i class="ti ${catDef.icon}" style="color:${def.hue};opacity:0.8"></i>
                    <span>${esc(def.label)}</span>
                  </div>`).join('')}
              </div>`
            }).join('')}
          </div>
        </div>

        <!-- Canvas -->
        <svg class="dg-canvas" id="dg-canvas" xmlns="http://www.w3.org/2000/svg"
          style="cursor:${_mode==='pan'?'grab':'default'};touch-action:none">
        </svg>

        <!-- Properties panel -->
        <div class="dg-props">
          <div class="dg-props-title">Свойства</div>
          <div class="dg-props-empty">
            <i class="ti ti-hand-finger"></i>
            <p>Выберите элемент</p>
          </div>
        </div>
      </div>
    </div>`

  // Bind toolbar
  _svgEl = _el.querySelector('#dg-canvas')

  _el.querySelector('#dg-new-btn')?.addEventListener('click', () => {
    _diagram = newDiagram(); _editId = null; _undoStack = []
    showEditor()
  })

  _el.querySelector('#dg-back')?.addEventListener('click', () => {
    if (_diagram.modified && !confirm('Есть несохранённые изменения. Выйти?')) return
    showHome()
  })

  _el.querySelector('#dg-save-btn')?.addEventListener('click', saveDiagram)
  _el.querySelector('#dg-undo')?.addEventListener('click', undo)

  _el.querySelector('#dg-center')?.addEventListener('click', () => {
    _pan = { x: 80, y: 80 }; _zoom = 1; renderCanvas()
  })

  _el.querySelector('#dg-simulate')?.addEventListener('click', () => {
    _simulating = !_simulating
    renderCanvas()
    const btn = _el.querySelector('#dg-simulate')
    if (btn) { btn.classList.toggle('active', _simulating); btn.style.color = _simulating ? '#22c55e' : '' }
  })

  _el.querySelector('#dg-delete-sel')?.addEventListener('click', () => {
    if (!_selected) return
    saveUndo()
    if (_selected.type === 'comp') {
      _diagram.components = _diagram.components.filter(c => c.id !== _selected.id)
      _diagram.wires = _diagram.wires.filter(w => w.from?.compId !== _selected.id && w.to?.compId !== _selected.id)
    }
    if (_selected.type === 'wire') _diagram.wires = _diagram.wires.filter(w => w.id !== _selected.id)
    if (_selected.type === 'label') _diagram.labels = _diagram.labels.filter(l => l.id !== _selected.id)
    _diagram.modified = true; _selected = null; renderCanvas(); renderProps()
  })

  // Tool buttons
  _el.querySelectorAll('.dg-tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _mode = btn.dataset.mode
      if (_mode !== 'wire') { _wireStart = null; _wirePreview = null }
      updateToolbar(); renderCanvas()
      const canvas = _el.querySelector('#dg-canvas')
      if (canvas) canvas.style.cursor = _mode === 'pan' ? 'grab' : 'default'
    })
  })

  // Wire color picker
  _el.querySelectorAll('.dg-wire-color-picker .dg-color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      _activeColor = dot.dataset.hex
      _el.querySelectorAll('.dg-wire-color-picker .dg-color-dot').forEach(d => d.classList.remove('active'))
      dot.classList.add('active')
    })
  })

  // Custom component button
  _el.querySelector('#dg-add-custom')?.addEventListener('click', () => openCustomCompModal())

  // Edit custom component buttons
  _el.querySelectorAll('.dg-edit-custom-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const defId = btn.dataset.defId
      const existingDef = (_diagram.customDefs || []).find(d => d.id === defId)
      if (existingDef) openCustomCompModal(existingDef)
    })
  })

  // Library drag & drop
  _el.querySelectorAll('.dg-lib-item').forEach(item => {
    item.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', item.dataset.type)
    })
  })

  const canvas = _el.querySelector('#dg-canvas')
  canvas?.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' })
  canvas?.addEventListener('drop', e => {
    e.preventDefault()
    const type = e.dataTransfer.getData('text/plain')
    if (type && getCompDef(type)) dropComponent(type, e.clientX, e.clientY)
  })

  // Keyboard shortcuts
  let _modeBeforeSpace = null
  const keyHandler = (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); return }
    if (e.key === 'v' || e.key === 'V') { _mode='select'; updateToolbar() }
    if (e.key === 'w' || e.key === 'W') { _mode='wire'; updateToolbar() }
    if (e.key === 's' || e.key === 'S') { _el?.querySelector('#dg-simulate')?.click() }
    if (e.key === ' ' && !e.repeat) {
      e.preventDefault()
      _modeBeforeSpace = _mode
      _mode = 'pan'
      updateToolbar()
    }
    if (e.key === 'Escape') {
      _wireStart = null; _wirePreview = null; _mode='select'; updateToolbar(); renderCanvas()
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && _selected) {
      _el.querySelector('#dg-delete-sel')?.click()
    }
  }
  const keyUpHandler = (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
    if (e.key === ' ' && _modeBeforeSpace !== null) {
      _mode = _modeBeforeSpace
      _modeBeforeSpace = null
      updateToolbar()
    }
  }
  document.addEventListener('keydown', keyHandler)
  document.addEventListener('keyup', keyUpHandler)
  _el._keyHandler = keyHandler
  _el._keyUpHandler = keyUpHandler

  // Load and show home
  loadDiagramList().then(() => renderDiagramList())
}

// ── Custom component modal ─────────────────────────────────────────────────
function ccTermRow(t, i) {
  return `<div class="cc-term-row" style="display:flex;gap:6px;align-items:center">
    <input class="wo-input cc-term-label" placeholder="Метка" value="${esc(t.label||'')}" style="flex:1;min-width:0">
    <select class="wo-select cc-term-side" style="width:70px">
      <option value="L" ${t.side==='L'?'selected':''}>← L</option>
      <option value="R" ${t.side==='R'?'selected':''}>R →</option>
      <option value="T" ${t.side==='T'?'selected':''}>↑ T</option>
      <option value="B" ${t.side==='B'?'selected':''}>↓ B</option>
    </select>
    <button class="wo-quick-btn cc-term-del" style="padding:4px 6px;color:var(--red)" title="Удалить">
      <i class="ti ti-x"></i>
    </button>
  </div>`
}

function openCustomCompModal(existingDef = null) {
  const isEdit = !!existingDef
  const modal = document.createElement('div')
  modal.className = 'wo-modal-overlay'

  const defaultTerms = existingDef?.terminals || []

  modal.innerHTML = `
    <div class="wo-modal" style="max-width:520px;max-height:90vh;overflow-y:auto">
      <div class="wo-modal-header">
        <h2 class="wo-modal-title">${isEdit ? 'Редактировать элемент' : 'Новый элемент'}</h2>
        <button class="wo-modal-close"><i class="ti ti-x"></i></button>
      </div>
      <div class="wo-modal-body">
        <div class="wo-form-row">
          <div class="wo-form-group wo-form-group--half">
            <label class="wo-label">Название *</label>
            <input class="wo-input" id="cc-name" placeholder="Мой элемент" value="${esc(existingDef?.label||'')}">
          </div>
          <div class="wo-form-group wo-form-group--half">
            <label class="wo-label">Цвет (hex)</label>
            <input class="wo-input" id="cc-hue" placeholder="#2a3a5a" value="${esc(existingDef?.hue||'#2a3a5a')}">
          </div>
        </div>
        <div class="wo-form-row">
          <div class="wo-form-group wo-form-group--half">
            <label class="wo-label">Ширина (px)</label>
            <input class="wo-input" id="cc-w" type="number" min="80" max="400" value="${existingDef?.w||160}">
          </div>
          <div class="wo-form-group wo-form-group--half">
            <label class="wo-label">Высота (px)</label>
            <input class="wo-input" id="cc-h" type="number" min="60" max="600" value="${existingDef?.h||200}">
          </div>
        </div>

        <div style="margin:12px 0 6px;font-size:12px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">
          Терминалы
        </div>
        <div id="cc-terms-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">
          ${defaultTerms.map((t,i) => ccTermRow(t, i)).join('')}
        </div>
        <button class="wo-quick-btn" id="cc-add-term" style="width:100%;justify-content:center">
          <i class="ti ti-plus"></i> Добавить терминал
        </button>
      </div>
      <div class="wo-modal-footer">
        ${isEdit ? `<button class="wo-del-btn" id="cc-delete"><i class="ti ti-trash"></i> Удалить</button>` : '<span></span>'}
        <div class="wo-modal-actions">
          <button class="wo-cancel-btn" id="cc-cancel">Отмена</button>
          <button class="wo-save-btn" id="cc-save"><i class="ti ti-check"></i> Сохранить</button>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(modal)

  const close = () => modal.remove()
  modal.querySelector('.wo-modal-close').addEventListener('click', close)
  modal.querySelector('#cc-cancel').addEventListener('click', close)
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  modal.querySelector('#cc-add-term').addEventListener('click', () => {
    const list = modal.querySelector('#cc-terms-list')
    const idx = list.children.length
    const div = document.createElement('div')
    div.innerHTML = ccTermRow({ id: '', label: '', side: 'L', pos: idx }, idx)
    list.appendChild(div.firstElementChild)
  })

  modal.querySelector('#cc-terms-list').addEventListener('click', e => {
    if (e.target.closest('.cc-term-del')) {
      e.target.closest('.cc-term-row').remove()
    }
  })

  modal.querySelector('#cc-delete')?.addEventListener('click', () => {
    if (!existingDef) return
    _diagram.customDefs = (_diagram.customDefs || []).filter(d => d.id !== existingDef.id)
    // Remove components of this type from diagram
    _diagram.components = _diagram.components.filter(c => c.type !== existingDef.id)
    _diagram.wires = _diagram.wires.filter(w => {
      const fc = _diagram.components.find(c => c.id === w.from?.compId)
      const tc = _diagram.components.find(c => c.id === w.to?.compId)
      return fc && tc
    })
    _diagram.modified = true
    close()
    render()
    showEditor()
  })

  modal.querySelector('#cc-save').addEventListener('click', () => {
    const name = modal.querySelector('#cc-name').value.trim()
    if (!name) { modal.querySelector('#cc-name').focus(); return }
    const w = Math.max(80, Math.min(400, Number(modal.querySelector('#cc-w').value) || 160))
    const h = Math.max(60, Math.min(600, Number(modal.querySelector('#cc-h').value) || 200))
    const hue = modal.querySelector('#cc-hue').value.trim() || '#2a3a5a'

    const termRows = modal.querySelectorAll('.cc-term-row')
    const terminals = []
    termRows.forEach((row, i) => {
      const lbl = row.querySelector('.cc-term-label').value.trim()
      const side = row.querySelector('.cc-term-side').value
      if (!lbl) return
      terminals.push({ id: `t${i}_${lbl.toLowerCase().replace(/\W/g,'_')}`, label: lbl, side, pos: i })
    })

    const id = existingDef?.id || `custom_${Date.now()}`
    const def = { id, label: name, category: 'custom', w, h, hue, terminals }

    if (!_diagram.customDefs) _diagram.customDefs = []
    const idx = _diagram.customDefs.findIndex(d => d.id === id)
    if (idx >= 0) _diagram.customDefs[idx] = def
    else _diagram.customDefs.push(def)

    _diagram.modified = true
    close()
    render()
    showEditor()
    window.toast?.(`Элемент "${name}" сохранён`, 'success')
  })
}

// ── Mount / Unmount ────────────────────────────────────────────────────────
export async function mount() {
  _el = document.querySelector('[data-view="diagrams"]')
  if (!_el) return unmount
  render()

  // Handle diagram generated by Wiki AI assistant
  if (window._rpPendingDiagram) {
    const gen = window._rpPendingDiagram
    window._rpPendingDiagram = null
    _diagram = { name: gen.name || 'Новая схема', components: gen.components || [], wires: gen.wires || [], labels: gen.labels || [], customDefs: gen.customDefs || [], modified: true }
    _editId = null
    _undoStack = []
    await loadDiagramList()
    setTimeout(() => showEditor(), 40)
    return unmount
  }

  // Handle "open specific diagram" from Wiki schema embed
  if (window._rpPendingDiagramId) {
    const id = window._rpPendingDiagramId
    window._rpPendingDiagramId = null
    await loadDiagramList()
    const page = _diagrams.find(d => d.id === id)
    if (page) { await openDiagram(page) } else { renderDiagramList() }
    return unmount
  }

  return unmount
}

export function unmount() {
  if (_el?._keyHandler)   document.removeEventListener('keydown', _el._keyHandler)
  if (_el?._keyUpHandler) document.removeEventListener('keyup',   _el._keyUpHandler)
  _el = null
  _svgEl = null
  _svgEventsBound = false
}
