// Pure helpers for the band: no `$`, so the tests call them directly.
// changeOf and the turn counting are adapted from receipt by hoobnn (MIT).
import type { DayTotal, FileChange, Hours, Ledger, Reading, TaskItem, TaskList, Turn, UsageSnap } from '../types'

export const WORK_STATE = /work_state_write$/

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])
const SHELLS = new Set(['Bash', 'PowerShell'])
const AGENTS = new Set(['Agent', 'Task'])

const str = (v: unknown) => (typeof v === 'string' ? v : '')

type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export const snapOf = (limits: readonly Limit[], usd: number): UsageSnap => {
  const find = (kind: string) => limits.find(l => l.kind === kind)
  const five = find('five_hour')
  const week = find('seven_day')
  return {
    fiveHour: five ? five.percentUsed : -1,
    week: week ? week.percentUsed : -1,
    fiveResets: five?.resetsAt ?? '',
    weekResets: week?.resetsAt ?? '',
    usd,
  }
}

/** `3h 55m`, `4d 17h`, `12m`; '' when unknown or past. */
export const resetsIn = (iso: string, now: number) => {
  const ms = iso ? Date.parse(iso) - now : NaN
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const m = Math.floor(ms / 60_000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`
}


/** `842`, `84.2k`, `1.2M`. */
export const short = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `${Math.round(n)}`

/** `42s`, `5m 16s`, `1h 3m`. */
export const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

const WEEK_MS = 7 * 86_400_000
const DAY_MS = 86_400_000

export type WeekPace = {
  /** How far through the week we are, 0 to 100. */
  elapsed: number
  /** ok: lasts to the reset; ahead: runs out before it; low: 90% or more; out: none left. */
  level: 'ok' | 'ahead' | 'low' | 'out'
  word: string
  color: string
}

// The week's pace, measured in the person's own hours. An activity profile gives each hour of the week
// (Sunday 00:00 is slot 0, local time) a weight: how much of the limit that hour usually burns. It is
// learned from past transcripts (the seed) and from every turn since, recent weeks counting more, so the
// pace stops treating a night asleep as hours of burn and keeps adjusting as the person's habits change.

const HOUR_MS = 3_600_000
/** A week ago counts half as much as today; two weeks ago, a quarter. */
const HALF_LIFE_DAYS = 7
const LOOKBACK_DAYS = 56
/** Days of activity before the learned profile replaces the default one. */
const MIN_DAYS = 3
/** Typical hours that must have passed this week before the pace means anything. */
const MIN_ACTIVE = 6
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** The local hour of the week, 0 (Sunday 00:00) to 167. */
const slotOf = (ms: number) => {
  const d = new Date(ms)
  return d.getDay() * 24 + d.getHours()
}

const normalize = (raw: readonly number[]): number[] => {
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length
  if (!(mean > 0)) return raw.map(() => 1)
  // No hour is ever quite zero: a night owl session still counts.
  const floored = raw.map(v => Math.max(v, 0.03 * mean))
  const m = floored.reduce((a, b) => a + b, 0) / floored.length
  return floored.map(v => v / m)
}

export type Profile = {
  /** 168 weights, one per local hour of the week, averaging 1. */
  weights: number[]
  /** Days of activity it was learned from; 0 for the default. */
  days: number
}

/** Before there is anything to learn from: midnight to 8am is quiet, the rest even. */
export const DEFAULT_PROFILE: Profile = { weights: normalize(Array.from({ length: 168 }, (_, s) => (s % 24 < 8 ? 0.1 : 1))), days: 0 }
/** Every hour the same: the plain wall-clock pace. */
export const FLAT_PROFILE: Profile = { weights: Array.from({ length: 168 }, () => 1), days: 0 }

/** Roughly what a turn costs against the limit: cache reads are cheap, everything else full price. */
export const turnUnits = (u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined) =>
  u ? (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0) : 0

/** Adds a turn's units to the ledger's hour it ran in. */
export const addActivity = (l: Ledger, units: number, now: number): Ledger => {
  if (!(units > 0)) return l
  const h = String(Math.floor(now / HOUR_MS))
  const hours = l.hours ?? {}
  return { ...l, hours: { ...hours, [h]: (hours[h] ?? 0) + Math.round(units) } }
}

/** Activity by epoch hour, counted only from `from` (inclusive) to `before` (exclusive), so the seed and the live ledgers never overlap. */
export type ActivitySource = { hours: Hours; from?: number; before?: number }

/** The activity profile: recent weeks weigh more, each slot leaning on its hour of the day while data is thin. */
export const activityProfile = (sources: readonly ActivitySource[], now: number): Profile => {
  const nowH = Math.floor(now / HOUR_MS)
  const slots = Array.from({ length: 168 }, () => 0)
  const days = new Set<string>()
  for (const src of sources) {
    for (const [k, v] of Object.entries(src.hours)) {
      const h = Number(k)
      if (!Number.isFinite(h) || !(v > 0)) continue
      if (src.from !== undefined && h < src.from) continue
      if (src.before !== undefined && h >= src.before) continue
      const age = (nowH - h) / 24
      if (age < 0 || age > LOOKBACK_DAYS) continue
      const s = slotOf(h * HOUR_MS)
      slots[s] = (slots[s] ?? 0) + v * 0.5 ** (age / HALF_LIFE_DAYS)
      days.add(dayKey(h * HOUR_MS))
    }
  }
  if (days.size < MIN_DAYS) return DEFAULT_PROFILE
  const byHour = Array.from({ length: 24 }, (_, x) => {
    let sum = 0
    for (let d = 0; d < 7; d++) sum += slots[d * 24 + x] ?? 0
    return sum / 7
  })
  return { weights: normalize(slots.map((v, s) => (v + (byHour[s % 24] ?? 0)) / 2)), days: days.size }
}

/** The profile's weight between two times: typical hours, a quiet hour counting for little. */
const weightBetween = (a: number, b: number, w: readonly number[]) => {
  let total = 0
  for (let t = a; t < b;) {
    const next = Math.min(b, (Math.floor(t / HOUR_MS) + 1) * HOUR_MS)
    total += ((next - t) / HOUR_MS) * (w[slotOf(t)] ?? 1)
    t = next
  }
  return total
}

/** When `need` percent more is used at `rate` percent per typical hour, or null when that is not before `limit`. */
const runOutAt = (from: number, need: number, rate: number, w: readonly number[], limit: number): number | null => {
  let left = need
  for (let t = from; t < limit;) {
    const next = Math.min(limit, (Math.floor(t / HOUR_MS) + 1) * HOUR_MS)
    const burn = rate * ((next - t) / HOUR_MS) * (w[slotOf(t)] ?? 1)
    if (burn >= left) return t + (next - t) * (left / burn)
    left -= burn
    t = next
  }
  return null
}

/** `today 5pm`, `tomorrow 9am`, `Thu 2pm`, local time. */
export const clockLabel = (ms: number, now: number) => {
  const d = new Date(ms)
  const h = d.getHours()
  const time = `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`
  const day = dayKey(ms) === dayKey(now) ? 'today' : dayKey(ms) === dayKey(now + DAY_MS) ? 'tomorrow' : WEEKDAYS[d.getDay()]
  return `${day} ${time}`
}

/** Whether the weekly limit lasts until it resets, at the pace used so far this week, in the person's own hours. */
export const weekPace = (used: number, resetsIso: string, now: number, profile: Profile = DEFAULT_PROFILE): WeekPace => {
  const reset = resetsIso ? Date.parse(resetsIso) : NaN
  const w = profile.weights
  const start = reset - WEEK_MS
  const past = Number.isFinite(reset) ? weightBetween(start, Math.min(now, reset), w) : 0
  const ahead = Number.isFinite(reset) ? weightBetween(Math.max(now, start), reset, w) : 0
  // How far through the week's typical activity we are: where the usage would sit if it kept to pace.
  const elapsed = past + ahead > 0 ? (past / (past + ahead)) * 100 : 0
  if (used >= 100) return { elapsed, level: 'out', word: 'limit reached', color: '#E24B4A' }
  // Too early in the week for the pace to mean anything.
  if (past < MIN_ACTIVE || used <= 0 || !Number.isFinite(reset)) {
    return used >= 90 ? { elapsed, level: 'low', word: 'nearly out', color: '#E24B4A' } : { elapsed, level: 'ok', word: 'on pace', color: '#1D9E75' }
  }
  const rate = used / past
  const at = runOutAt(now, 100 - used, rate, w, reset)
  const when = at === null ? '' : `${clockLabel(at, now)}, in ${resetsIn(new Date(at).toISOString(), now) || '<1m'}`
  if (used >= 90) return { elapsed, level: 'low', word: at === null ? 'nearly out, lasts to reset' : `nearly out, runs out ~${when}`, color: '#E24B4A' }
  if (at !== null) return { elapsed, level: 'ahead', word: `runs out ~${when}`, color: at - now < DAY_MS ? '#E24B4A' : '#EF9F27' }
  const byReset = Math.round(used + rate * ahead)
  return { elapsed, level: 'ok', word: `on pace, ~${byReset}% by reset`, color: used >= 75 ? '#EF9F27' : '#1D9E75' }
}

/** Green, then amber, then red as a share fills. */
export const levelColor = (percent: number) => (percent < 50 ? '#1D9E75' : percent < 80 ? '#EF9F27' : '#E24B4A')

/** Where the context bar warns: yellow from here, */
export const CONTEXT_WARN = 50
/** and red from here, with the red line and the Compact now button. */
export const CONTEXT_COMPACT = 75

/** The context window: green, yellow from half full, red from three quarters. */
export const contextColor = (percent: number) =>
  percent < CONTEXT_WARN ? '#1D9E75' : percent < CONTEXT_COMPACT ? '#E8C547' : '#E24B4A'

/** The context window as weather: clear skies while it is empty, a storm as it fills. */
export const forecast = (percent: number) =>
  percent < 25 ? 'Clear'
  : percent < CONTEXT_WARN ? 'Cloudy'
  : percent < CONTEXT_COMPACT ? 'Showers'
  : percent < 90 ? 'Storm'
  : 'Compact soon'

export const addReading = (readings: readonly Reading[], next: Reading, keep = 8): Reading[] => {
  const kept = readings.filter(r => r.tokens > 0)
  if (kept[kept.length - 1]?.tokens === next.tokens) return kept
  return [...kept, next].slice(-keep)
}

export const newTurn = (now: number): Turn => ({ startedAt: now, durationMs: null, files: [], commands: 0, failed: 0, reads: 0, agents: 0 })

export type Call = { tool: string; input: Record<string, unknown>; result: unknown; isError: boolean }

/** Lines an edit added and removed: git's count, else the patch's, else a new file's length. */
export const changeOf = (call: Call): FileChange | null => {
  if (!EDITS.has(call.tool) || call.isError) return null
  const path = str(call.input.file_path) || str(call.input.notebook_path)
  if (!path) return null
  const result = (call.result ?? {}) as Record<string, unknown>
  const git = result.gitDiff as { additions?: unknown; deletions?: unknown } | undefined
  if (typeof git?.additions === 'number' && typeof git.deletions === 'number') return { path, added: git.additions, removed: git.deletions }
  let added = 0
  let removed = 0
  for (const hunk of Array.isArray(result.structuredPatch) ? (result.structuredPatch as { lines?: unknown }[]) : []) {
    for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  if (added === 0 && removed === 0) added = (str(result.content) || str(call.input.content)).split('\n').length
  return { path, added, removed }
}

export const addCall = (turn: Turn, call: Call, isMain: boolean): Turn => {
  const change = changeOf(call)
  if (change) {
    const had = turn.files.find(f => f.path === change.path)
    return {
      ...turn,
      files: had
        ? turn.files.map(f => (f === had ? { ...f, added: f.added + change.added, removed: f.removed + change.removed } : f))
        : [...turn.files, change],
    }
  }
  if (SHELLS.has(call.tool)) return { ...turn, commands: turn.commands + 1, failed: turn.failed + (call.isError ? 1 : 0) }
  if (READS.has(call.tool)) return { ...turn, reads: turn.reads + 1 }
  if (AGENTS.has(call.tool) && isMain) return { ...turn, agents: turn.agents + 1 }
  return turn
}

export const isEmptyTurn = (t: Turn) => t.files.length === 0 && t.commands === 0 && t.reads === 0 && t.agents === 0

export const lineTotals = (t: Turn) =>
  t.files.reduce((s, f) => ({ added: s.added + f.added, removed: s.removed + f.removed }), { added: 0, removed: 0 })

/** One work_state_write call folded into the list it names; another list's call starts that list afresh. */
export const applyWorkState = (was: TaskList | null, input: { list?: unknown; fields?: unknown }): TaskList | null => {
  const list = str(input.list)
  const fields = (input.fields ?? {}) as Record<string, unknown>
  if (!list) return was
  const base: TaskList = was && was.list === list ? was : { list, items: [], isClosed: false }
  const task = str(fields.task)
  if (task) {
    const status = str(fields.status) || 'todo'
    const items = base.items.some(i => i.task === task)
      ? base.items.map(i => (i.task === task ? { task, status } : i))
      : [...base.items, { task, status }]
    return { ...base, items, isClosed: false }
  }
  if (fields.status === 'done') return { ...base, isClosed: true }
  return base
}

/** The built-in TodoWrite: the whole list each call. */
export const fromTodos = (todos: unknown): TaskList | null => {
  if (!Array.isArray(todos)) return null
  const items: TaskItem[] = todos.map(t => {
    const o = (t ?? {}) as Record<string, unknown>
    const status = str(o.status) === 'in_progress' ? 'doing' : str(o.status) === 'completed' ? 'done' : 'todo'
    return { task: str(o.activeForm) && status === 'doing' ? str(o.activeForm) : str(o.content), status }
  })
  return { list: 'to-dos', items, isClosed: false }
}

/** What the tasks row says, or null when there is nothing open to show. */
export const taskSummary = (t: TaskList | null) => {
  if (!t || t.isClosed) return null
  const live = t.items.filter(i => i.status !== 'dropped')
  const done = live.filter(i => i.status === 'done').length
  if (live.length === 0 || done === live.length) return null
  const current = live.find(i => i.status === 'doing') ?? live.find(i => i.status === 'todo')
  const next = live.filter(i => i.status === 'todo' && i !== current)[0]
  return { list: t.list, done, total: live.length, current: current?.task ?? '', next: next?.task ?? '' }
}

// Spend and tokens across sessions: each session keeps a ledger file of its own, by local day,
// so open sessions never write over each other; the band adds the files up.

/** The local calendar day, `2026-10-12`. */
export const dayKey = (now: number) => {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const emptyLedger = (): Ledger => ({ days: {}, usd: 0, tokens: 0 })

const bump = (l: Ledger, day: string, usd: number, tokens: number): Ledger => {
  const was = l.days[day] ?? { usd: 0, tokens: 0 }
  return { ...l, days: { ...l.days, [day]: { usd: was.usd + usd, tokens: was.tokens + tokens } } }
}

/**
 * Folds the session's running cost into its ledger: what it grew by since the last reading counts to today.
 * A total that fell (the session cleared or restarted) starts the count again from there.
 */
export const addCost = (l: Ledger, usdNow: number, day: string): Ledger => {
  if (usdNow < l.usd) return { ...l, usd: usdNow }
  if (usdNow === l.usd) return l
  return { ...bump(l, day, usdNow - l.usd, 0), usd: usdNow }
}

/** A turn's tokens: what it sent, wrote to and read from the cache, and what came back. */
export const turnTokens = (u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined) =>
  u ? (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0

export const addTokens = (l: Ledger, tokens: number, day: string): Ledger =>
  tokens > 0 ? { ...bump(l, day, 0, tokens), tokens: l.tokens + tokens } : l

export type Totals = { today: DayTotal; week: DayTotal; all: DayTotal }

/** Today, the last 7 days (today among them) and every day, over all the ledgers. */
export const totalsOf = (ledgers: readonly Ledger[], now: number): Totals => {
  const today = dayKey(now)
  const week = new Set(Array.from({ length: 7 }, (_, i) => dayKey(now - i * 86_400_000)))
  const t: Totals = { today: { usd: 0, tokens: 0 }, week: { usd: 0, tokens: 0 }, all: { usd: 0, tokens: 0 } }
  for (const l of ledgers) {
    for (const [day, v] of Object.entries(l.days)) {
      const add = (into: DayTotal) => { into.usd += v.usd; into.tokens += v.tokens }
      add(t.all)
      if (week.has(day)) add(t.week)
      if (day === today) add(t.today)
    }
  }
  return t
}

/** A ledger file's text as a ledger, or null when it will not read as one. */
export const parseLedger = (text: string): Ledger | null => {
  try {
    const v = JSON.parse(text) as Partial<Ledger>
    if (!v || typeof v !== 'object' || !v.days || typeof v.days !== 'object') return null
    const hours = v.hours && typeof v.hours === 'object' ? v.hours : undefined
    return { days: v.days, usd: Number(v.usd) || 0, tokens: Number(v.tokens) || 0, ...(hours ? { hours } : {}) }
  } catch {
    return null
  }
}

/** The seed file's text (history.json, from tools/seed_activity.py), or null when it will not read as one. */
export const parseHistory = (text: string): { until: number; hours: Hours } | null => {
  try {
    const v = JSON.parse(text) as { until?: unknown; hours?: unknown }
    if (typeof v.until !== 'number' || !v.hours || typeof v.hours !== 'object') return null
    return { until: v.until, hours: v.hours as Hours }
  } catch {
    return null
  }
}

/** `$1,234`, `$56.70`. */
export const dollars = (usd: number) =>
  usd >= 1000 ? `$${Math.round(usd).toLocaleString('en-US')}` : `$${usd.toFixed(2)}`

/** `950`, `45.2k`, `12.3M`, `1.4B`. */
export const tokensShort = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : short(n)

// One drawing for every row on the desktop surface: the same bar, the same size.
export const BAR_W = 120
export const BAR_H = 14

const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

/** A mark across the bar at a share of it: the week's even pace, the context's compact line. */
export type Mark = { at: number; color: string }

/** The bar: the share filled in its colour, with marks across it. */
export const barSvg = (percent: number, color: string, marks: readonly Mark[] = [], w = BAR_W, h = BAR_H) => {
  const bar = 8
  const y = (h - bar) / 2
  const p = Math.max(0, Math.min(100, percent))
  const fill = Math.round((w * p) / 100)
  const lines = marks
    .filter(m => m.at > 0 && m.at < 100)
    .map(m => `<rect x="${Math.max(0, Math.min(w - 2, Math.round((w * m.at) / 100) - 1))}" width="2" height="${h}" rx="1" fill="${m.color}"/>`)
  return svg(w, h, `<rect y="${y}" width="${w}" height="${bar}" rx="${bar / 2}" fill="#888780" opacity="0.25"/>` +
    (fill > 0 ? `<rect y="${y}" width="${Math.max(fill, bar)}" height="${bar}" rx="${bar / 2}" fill="${color}"/>` : '') +
    lines.join(''))
}

/** The bar's space with nothing in it, for a row with no bar, so its text lines up with the rest. */
export const blankSvg = () => svg(BAR_W, BAR_H, '')

export const RING = 52

/** A ring: the share filled round from the top, the number in the middle, marks across it. */
export const ringSvg = (percent: number, color: string, marks: readonly Mark[] = [], size = RING) => {
  const r = 21
  const c = 2 * Math.PI * r
  const mid = size / 2
  const p = Math.max(0, Math.min(100, percent))
  const len = (c * p) / 100
  const ticks = marks
    .filter(m => m.at > 0 && m.at < 100)
    .map(m => {
      const a = (m.at / 100) * 2 * Math.PI - Math.PI / 2
      const at = (d: number) => `${(mid + d * Math.cos(a)).toFixed(1)}`
      const atY = (d: number) => `${(mid + d * Math.sin(a)).toFixed(1)}`
      return `<line x1="${at(r - 5)}" y1="${atY(r - 5)}" x2="${at(r + 5)}" y2="${atY(r + 5)}" stroke="${m.color}" stroke-width="2" stroke-linecap="round"/>`
    })
  return svg(size, size,
    `<circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="#888780" stroke-opacity="0.25" stroke-width="6"/>` +
    (len > 0 ? `<circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${len.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${mid} ${mid})"/>` : '') +
    ticks.join('') +
    `<text x="${mid}" y="${mid + 4}" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="12" font-weight="600" fill="${color}">${Math.round(p)}%</text>`)
}
