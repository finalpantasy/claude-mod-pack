import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Hours, Ledger, ModInfo, Reading, TaskList, Turn, UsageSnap } from '../types'
import { ROWS } from './mods'
import {
  BAR_H, BAR_W, CONTEXT_COMPACT, RING, WORK_STATE, activityProfile, addActivity, addCall, addCost, addReading, addTokens, applyWorkState, barSvg, blankSvg, contextColor,
  dayKey, dollars, duration, emptyLedger, forecast, fromTodos, isEmptyTurn, levelColor, lineTotals, newTurn, parseHistory, parseLedger,
  resetsIn, ringSvg, short, snapOf, taskSummary, tokensShort, totalsOf, turnTokens, turnUnits, weekPace,
} from './logic'

// One band above the prompt, rows in a fixed order: week, 5-hour, context, spend, tokens, last turn, tasks.
// It reads on events (session start, each prompt, each turn's end) and every 30 seconds for the usage row;
// a reading that changed nothing redraws nothing.

const usage = atom({ plugin: 'status-band', key: 'usage' } as const, null as UsageSnap | null)
const readings = atom({ plugin: 'status-band', key: 'readings' } as const, [] as Reading[])
const turn = atom({ plugin: 'status-band', key: 'turn' } as const, null as Turn | null)
const lastTurn = atom({ plugin: 'status-band', key: 'lastTurn' } as const, null as Turn | null)
const tasks = atom({ plugin: 'status-band', key: 'tasks' } as const, null as TaskList | null)
const isHidden = atom({ plugin: 'status-band', key: 'isHidden' } as const, false)
const rowsOff = atom({ plugin: 'status-band', key: 'rowsOff' } as const, [] as string[])
const mods = atom({ plugin: 'status-band', key: 'mods' } as const, null as ModInfo[] | null)
const ledger = atom({ plugin: 'status-band', key: 'ledger' } as const, emptyLedger() as Ledger)
const others = atom({ plugin: 'status-band', key: 'others' } as const, {} as Record<string, { mtimeMs: number; ledger: Ledger }>)
const compactState = atom({ plugin: 'status-band', key: 'compact' } as const, 'idle' as 'idle' | 'queued' | 'running')
// Claude Mod Hider's switch: while it is on, the band passes so nothing of ours shows.
const modsHidden = atom({ plugin: 'claude-mod-hider', key: 'hidden' } as const, false)
// Mods draw in an order nobody sets, so Claude Mod Hider's arrow could land under the band: the band draws it instead.
const hiderArrow = atom({ plugin: 'status-band', key: 'hiderArrow' } as const, false)
const history = atom({ plugin: 'status-band', key: 'history' } as const, null as { until: number; hours: Hours } | null)
const handoffState = atom({ plugin: 'status-band', key: 'handoff' } as const, 'idle' as 'idle' | 'queued' | 'running')
const MODS_PANE = 'status-band-mods'

const LABEL_W = 9 // cells of the label column, so every row's value starts at the same place
const MUTED = '#888780'
const GREEN = '#1D9E75'
const RED = '#E24B4A'
const BLUE = '#378ADD'
const REFRESH_MS = 30_000
const TILE = 'rgba(136, 135, 128, 0.16)'
const TILE_W = 12 // cells, so the four tiles are even

async function readUsage($: EngineInterface, withReading: boolean): Promise<void> {
  const u = await $.session.usage()
  const snap = snapOf(u.rateLimits ?? [], u.cost?.usd ?? 0)
  if (JSON.stringify(snap) !== JSON.stringify(await read($, usage))) await update($, usage, () => snap)
  await saveCost($, snap.usd)
  const c = u.context
  const tokens = c?.tokens ?? 0
  if (withReading && c && c.window && tokens > 0) {
    const window = c.window
    const percent = Math.round(c.percent ?? (tokens / window) * 100)
    await update($, readings, list => addReading(list, { tokens, window, percent }))
  }
}

// Compact now. The engine refuses to compact while a turn runs and any hook may veto it, so a press
// during a turn waits for the turn to end, and every outcome says so in a toast instead of vanishing.
async function compactNow($: EngineInterface): Promise<void> {
  if ((await read($, compactState)) !== 'idle') return
  if (await read($, turn)) {
    await update($, compactState, () => 'queued')
    $.ui.toast('Claude is working. The chat compacts as soon as this turn ends.')
    // Checked once a second, only while queued; the turn's end clears the band's running turn.
    const wait = $.clock.every(1000, () => {
      void (async () => {
        if ((await read($, compactState)) !== 'queued') return wait.cancel()
        if (await read($, turn)) return
        wait.cancel()
        await runCompact($, 3)
      })().catch(() => undefined)
    })
    return
  }
  await runCompact($, 1)
}

// The desktop app and other SDK hosts have no between-turns compaction for a plugin yet: there the
// /compact command does it, run as the person would type it. Once seen, the button goes straight to it.
let compactByPrompt = false
const NO_PLUGIN_COMPACT = /headless|not available/i

async function compactWithPrompt($: EngineInterface): Promise<void> {
  try {
    await $.command.run({ command: 'compact' })
    $.ui.toast('Compacting: /compact is running in this chat.')
  } catch (err) {
    $.ui.toast(`Could not compact (${err instanceof Error ? err.message : String(err)}). Type /compact to compact this chat.`)
  }
}

async function runCompact($: EngineInterface, tries: number): Promise<void> {
  await update($, compactState, () => 'running')
  if (compactByPrompt) {
    await compactWithPrompt($)
    await update($, compactState, () => 'idle')
    return
  }
  try {
    const r = await $.session.compact()
    $.ui.toast('skip' in r && typeof r.skip === 'string' ? `Not compacted: ${r.skip}` : 'Compacted. The next turns are cheaper.')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (NO_PLUGIN_COMPACT.test(message)) {
      compactByPrompt = true
      await compactWithPrompt($)
    } else if (tries > 1) {
      // Just after a turn the engine can still count it as running for a moment: try again shortly.
      await $.clock.sleep(1500)
      return runCompact($, tries - 1)
    } else {
      $.ui.toast(`Could not compact: ${message}`)
    }
  }
  await update($, compactState, () => 'idle')
}

const compactLabel = (s: 'idle' | 'queued' | 'running') => (s === 'queued' ? 'Compact queued: after this turn' : s === 'running' ? 'Compacting…' : 'Compact now')
const handoffLabel = (s: 'idle' | 'queued' | 'running') => (s === 'queued' ? 'Handoff queued' : s === 'running' ? 'Handing off…' : 'Handoff')

// Handoff. A prompt that has Claude write a handoff packet and move the work on: to the
// coordinator that started this chat, or to a fresh chat on the model and effort the rest of the work needs.
// The engine runs a plugin's prompt once the session is idle, so a press mid-turn queues it.
export const HANDOFF_PROMPT = [
  'Hand off this chat.',
  '1. Write a handoff packet: the goal, what is done (with evidence), what is open, the next concrete step, files and branches touched, decisions made, and anything blocked. Save it with work_state_write when that tool is available, otherwise in HANDOFF.md at the repo root. If a git repo has uncommitted changes, make a WIP commit (do not push).',
  '2. If a coordinator started this chat, send it the packet with SendMessage and stop there.',
  '3. Otherwise open a fresh chat to continue: start_session when it is available, else a spawn_task chip. Pick the cheapest model and effort that will finish the rest (Sonnet, medium effort by default; Opus only when the work needs it, and say why). Put the whole packet in its first prompt so it continues without this chat, then open it in split view.',
  '4. Reply with one line: where the work went, and a link to the new chat.',
].join('\n')

const isHandoff = (text: unknown) => typeof text === 'string' && text.startsWith('Hand off this chat.')

// Two quick presses both read 'idle' before either writes, so a plain flag takes the press first.
let isHandoffPressed = false

async function handoffNow($: EngineInterface): Promise<void> {
  if (isHandoffPressed) return
  isHandoffPressed = true
  try {
    if ((await read($, handoffState)) !== 'idle') return
    await update($, handoffState, () => 'queued')
  } finally {
    isHandoffPressed = false
  }
  $.ui.toast((await read($, turn)) ? 'Handoff queued: it starts as soon as this turn ends.' : 'Handing off: Claude writes the packet and opens the next chat.')
  try {
    await $.prompt.submit({ text: HANDOFF_PROMPT, asUser: true })
  } catch (err) {
    await update($, handoffState, () => 'idle')
    $.ui.toast(`Could not hand off: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// The week's pace in the person's own hours: the seed mined from past transcripts, then every session's
// ledger from where the seed stops.
async function profileOf($: EngineInterface, now: number) {
  const seed = await read($, history)
  const mine = await read($, ledger)
  const rest = Object.values(await read($, others)).map(o => o.ledger)
  const from = seed?.until ?? 0
  return activityProfile([
    ...(seed ? [{ hours: seed.hours, before: seed.until }] : []),
    ...[mine, ...rest].map(l => ({ hours: l.hours ?? {}, from })),
  ], now)
}

// The spend ledger: a file per session under ~/.claude/status-band/spend, written only when it changed.
async function spendDir($: EngineInterface): Promise<string> {
  const home = slash((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '')
  return `${home}/.claude/status-band/spend`
}

async function writeLedger($: EngineInterface, next: Ledger): Promise<void> {
  await update($, ledger, () => next)
  await $.fs.write(`${await spendDir($)}/${await $.session.id()}.json`, JSON.stringify(next)).catch(() => undefined)
}

async function saveCost($: EngineInterface, usd: number): Promise<void> {
  const was = await read($, ledger)
  const next = addCost(was, usd, dayKey(await $.clock.now()))
  if (next !== was) await writeLedger($, next)
}

/** Reads the other sessions' ledgers, only the files that changed since they were last read; this session's own on the first read. */
async function readOthers($: EngineInterface, isFirst: boolean): Promise<void> {
  const dir = await spendDir($)
  const mine = `${await $.session.id()}.json`
  const entries = await $.fs.list(dir).catch(() => [])
  const had = await read($, others)
  const next: Record<string, { mtimeMs: number; ledger: Ledger }> = {}
  let changed = false
  for (const f of entries) {
    if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
    if (f.name === mine) {
      // A resumed session carries on from its own file.
      if (isFirst) {
        const own = parseLedger(await $.fs.read(`${dir}/${f.name}`).catch(() => ''))
        if (own) await update($, ledger, () => own)
      }
      continue
    }
    const old = had[f.name]
    if (old && old.mtimeMs === f.mtimeMs) {
      next[f.name] = old
      continue
    }
    const l = parseLedger(await $.fs.read(`${dir}/${f.name}`).catch(() => ''))
    if (l) next[f.name] = { mtimeMs: f.mtimeMs, ledger: l }
    changed = true
  }
  if (changed || Object.keys(next).length !== Object.keys(had).length) await update($, others, () => next)
}

// /mods: read only when the panel opens; a switch runs `claude plugin enable|disable` once, when pressed.
type Installed = { plugins?: Record<string, { installPath?: string }[]> }

const slash = (p: string) => p.replace(/\\/g, '/')

/** Mods are plugins whose hooks.json names a hooks module; skills-only plugins are left out. */
export async function listMods($: EngineInterface): Promise<ModInfo[]> {
  const home = slash((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '')
  const settings = await $.settings.read()
  const enabled = (settings.enabledPlugins ?? {}) as Record<string, unknown>
  let installed: Installed = {}
  try {
    installed = JSON.parse(await $.fs.read(`${home}/.claude/plugins/installed_plugins.json`)) as Installed
  } catch {
    return []
  }
  const mods: ModInfo[] = []
  for (const [id, installs] of Object.entries(installed.plugins ?? {})) {
    const root = installs?.[0]?.installPath
    if (!root) continue
    const dir = slash(root)
    try {
      const hooks = JSON.parse(await $.fs.read(`${dir}/hooks/hooks.json`)) as { modules?: unknown }
      if (!Array.isArray(hooks.modules) || hooks.modules.length === 0) continue
    } catch {
      continue
    }
    let description = ''
    try {
      description = String((JSON.parse(await $.fs.read(`${dir}/.claude-plugin/plugin.json`)) as { description?: unknown }).description ?? '')
    } catch {
      // a manifest that will not read leaves the line empty
    }
    mods.push({ id, name: id.split('@')[0] ?? id, description, isOn: enabled[id] === true, pending: null })
  }
  return mods.sort((a, b) => a.name.localeCompare(b.name))
}

/** Turns a mod on or off for the next session; the error's first line on failure. */
export async function switchMod($: EngineInterface, id: string, on: boolean): Promise<string | null> {
  try {
    const run = await $.process.run(['claude', 'plugin', on ? 'enable' : 'disable', id], { timeoutMs: 60_000 })
    return run.exitCode === 0 ? null : (run.stderr || run.stdout).trim().split('\n')[0] || `exit ${run.exitCode}`
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A session with no interactive terminal (the desktop app, the SDK, -p) compacts through a /compact prompt.
    compactByPrompt = (e as { isInteractive?: boolean }).isInteractive === false
    // A compact cut off by a reload must not leave the button stuck.
    if ((await read($, compactState)) !== 'idle') await update($, compactState, () => 'idle')
    if ((await read($, handoffState)) !== 'idle') await update($, handoffState, () => 'idle')
    await $.command.register({ name: 'band', description: 'Status band above the prompt: /band hides or shows it' })
    await $.command.register({ name: 'mods', description: 'Switch mods and the status band rows on or off' })
    const enabled = ((await $.settings.read().catch(() => ({}))) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {}
    await update($, hiderArrow, () => Object.entries(enabled).some(([id, isEnabled]) => id.startsWith('claude-mod-hider@') && isEnabled === true))
    // The row switches kept from earlier sessions; none kept, every row shows.
    const saved = await $.store.get('rowsOff').catch(() => undefined)
    if (Array.isArray(saved)) await update($, rowsOff, () => saved.filter((k): k is string => typeof k === 'string'))
    await readOthers($, true).catch(() => undefined)
    const seed = parseHistory(await $.fs.read(`${(await spendDir($)).replace(/spend$/, 'activity')}/history.json`).catch(() => ''))
    await update($, history, () => seed)
    await readUsage($, true).catch(() => undefined)
    $.clock.every(REFRESH_MS, () => void readUsage($, false).catch(() => undefined))
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    void readUsage($, false).catch(() => undefined)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if ((e as { agentId?: string }).agentId === undefined) {
      const now = await $.clock.now()
      await update($, turn, () => newTurn(now))
      if (isHandoff((e as { text?: unknown }).text)) await update($, handoffState, () => 'running')
    }
    return next(e)
  })

  // Every call once it has run, subagents' included; a refused call did nothing.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const { tool, tool_use_id: _, agentId, ...input } = e as unknown as Record<string, unknown> & { tool: string; agentId?: string }
    const isError = ran.isError === true
    if (!isError && WORK_STATE.test(tool)) await update($, tasks, was => applyWorkState(was, input))
    else if (!isError && tool === 'TodoWrite') {
      const list = fromTodos(input.todos)
      if (list) await update($, tasks, () => list)
    }
    const was = await read($, turn)
    if (was && was.durationMs === null) {
      await update($, turn, () => addCall(was, { tool, input, result: ran.result, isError }, agentId === undefined))
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // Every turn's tokens count, a subagent's too.
    const turnUsage = (e as { usage?: Parameters<typeof turnTokens>[0] }).usage
    const used = turnTokens(turnUsage)
    if (used > 0) {
      const at = await $.clock.now()
      // The hour it ran in feeds the activity profile the week's pace is measured in.
      await writeLedger($, addActivity(addTokens(await read($, ledger), used, dayKey(at)), turnUnits(turnUsage), at))
    }
    if (e.agentId !== undefined) return done
    if ((await read($, handoffState)) === 'running') await update($, handoffState, () => 'idle')
    const was = await read($, turn)
    if (was) {
      const finished = { ...was, durationMs: e.durationMs ?? (await $.clock.now()) - was.startedAt }
      if (!isEmptyTurn(finished)) await update($, lastTurn, () => finished)
      await update($, turn, () => null)
    }
    await readUsage($, true).catch(() => undefined)
    await readOthers($, false).catch(() => undefined)
    return done
  })

  on('command.run', { command: 'mods' }, async $ => {
    await update($, mods, () => null)
    await $.ui.open({ id: MODS_PANE, title: 'Mods', focus: true })
    const list = await listMods($)
    await update($, mods, () => list)
    return { text: `Mods panel opened: ${list.length} mods.` }
  })

  on('ui.render', { component: 'Pane', requestId: MODS_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const off = await read($, rowsOff)
    const list = await read($, mods)
    const toggleRow = async (key: string) => {
      const next = off.includes(key) ? off.filter(k => k !== key) : [...off, key]
      await update($, rowsOff, () => next)
      await $.store.set('rowsOff', next)
    }
    const toggleMod = async (m: ModInfo) => {
      const turnOn = !m.isOn
      const error = await switchMod($, m.id, turnOn)
      await update($, mods, ms =>
        (ms ?? []).map((x): ModInfo => (x.id !== m.id ? x : error ? { ...x, pending: 'failed', error } : { ...x, isOn: turnOn, pending: turnOn ? 'on' : 'off' })))
    }
    const state = (isOn: boolean) => <Text color={isOn ? GREEN : MUTED} bold>{isOn ? 'on ' : 'off'}</Text>
    const cState = await read($, compactState)
    const hState = await read($, handoffState)
    const learned = await profileOf($, await $.clock.now())
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>This chat</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="p-compact" label={compactLabel(cState)} plain onPress={() => void compactNow($)} />
            <Button key="p-handoff" label={handoffLabel(hState)} plain onPress={() => void handoffNow($)} />
          </Box>
          <Text dimColor>{learned.days > 0 ? `Week pace: learned from ${learned.days} days of your activity, recent weeks counting most.` : 'Week pace: midnight to 8am counted as quiet until it has 3 days of your activity.'}</Text>
        </Box>
        <Box flexDirection="column">
          <Text bold>Band rows</Text>
          <Text dimColor>Change right away.</Text>
          {ROWS.map(r => (
            <Box key={`row-${r.key}`} flexDirection="row" gap={1}>
              <Button key={`r-${r.key}`} label={off.includes(r.key) ? 'Turn on' : 'Turn off'} plain onPress={() => void toggleRow(r.key)} />
              {state(!off.includes(r.key))}
              <Text>{r.label}</Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>Mods</Text>
          <Text dimColor>Switches apply from your next session.</Text>
          {list === null ? <Text dimColor>Reading your mods…</Text> : null}
          {list?.length === 0 ? <Text dimColor>No mods found.</Text> : null}
          {(list ?? []).map(m => (
            <Box key={`mod-${m.id}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Button key={`m-${m.id}`} label={m.isOn ? 'Turn off' : 'Turn on'} plain onPress={() => void toggleMod(m)} />
                {state(m.isOn)}
                <Text bold>{m.name}</Text>
                {m.pending === 'on' || m.pending === 'off' ? <Text color={BLUE}>{`(${m.pending} next session)`}</Text> : null}
                {m.pending === 'failed' ? <Text color={RED}>{`could not switch: ${m.error ?? ''}`}</Text> : null}
              </Box>
              {m.description ? (
                <Box marginLeft={5}>
                  <Text dimColor wrap="wrap">{m.description}</Text>
                </Box>
              ) : null}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'band' }, async $ => {
    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)
    return { text: hidden ? 'Status band hidden. /band brings it back.' : 'Status band shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden)) || (await read($, modsHidden))) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const Svg = e.surface === 'desktop' && 'Svg' in ui ? ui.Svg : null
    const Button = 'Button' in ui ? ui.Button : null
    const now = await $.clock.now()
    const u = await read($, usage)
    const rs = await read($, readings)
    const t = await read($, lastTurn)
    const todo = taskSummary(await read($, tasks))
    const off = await read($, rowsOff)
    const isOn = (key: string) => !off.includes(key)

    const row = (key: string, label: string, ...cells: RenderChildren[]) => (
      <Box key={key} flexDirection="row" gap={1} alignItems="center">
        <Box width={LABEL_W} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        {cells}
      </Box>
    )
    // Every row's bar is the same size; a row with no bar keeps the space, so the text lines up.
    const bar = (key: string, source: string | null, alt: string) =>
      Svg ? <Svg key={key} source={source ?? blankSvg()} alt={alt} width={BAR_W} height={BAR_H} /> : null
    const dot = (k: string) => <Text key={k} color={MUTED}>{' · '}</Text>
    const rows: RenderChildren[] = []

    const last = rs[rs.length - 1]
    const mine = await read($, ledger)
    const rest = Object.values(await read($, others)).map(o => o.ledger)
    const sum = totalsOf([mine, ...rest], now)
    const isFull = !!last && last.percent >= CONTEXT_COMPACT
    const cState = await read($, compactState)
    const hState = await read($, handoffState)
    // Compact now and Handoff always show; Compact now is the loud one once the context is full.
    const actions = Button
      ? [
        <Button key="compact" label={compactLabel(cState)} variant={isFull && cState === 'idle' ? 'primary' : 'secondary'} onPress={() => void compactNow($)} />,
        <Button key="handoff" label={handoffLabel(hState)} variant="secondary" onPress={() => void handoffNow($)} />,
      ]
      : null
    let isActionsPlaced = false

    if (Svg) {
      // The desktop: three rings, four money tiles, and a line under them only when something needs you.
      const ring = (key: string, source: string, alt: string, label: string, sub: string, color?: string) => (
        <Box key={key} flexDirection="column" alignItems="center">
          <Svg source={source} alt={alt} width={RING} height={RING} />
          <Text color={color ?? MUTED} bold={color !== undefined}>{label}</Text>
          {sub ? <Text color={MUTED}>{sub}</Text> : null}
        </Box>
      )
      const rings: RenderChildren[] = []
      const pace = u && u.week >= 0 ? weekPace(u.week, u.weekResets, now, await profileOf($, now)) : null
      const weekLeft = u ? resetsIn(u.weekResets, now) : ''
      if (isOn('week') && u && pace) {
        rings.push(ring('rw', ringSvg(u.week, pace.color, [{ at: pace.elapsed, color: '#D3D1C7' }]), `weekly limit ${Math.round(u.week)}% used`,
          pace.level === 'ok' ? 'week' : 'week ⚠', weekLeft ? `resets ${weekLeft}` : '', pace.level === 'ok' ? undefined : pace.color))
      }
      if (isOn('usage') && u && u.fiveHour >= 0) {
        const five = resetsIn(u.fiveResets, now)
        rings.push(ring('r5', ringSvg(u.fiveHour, levelColor(u.fiveHour)), `5-hour window ${Math.round(u.fiveHour)}% used`, '5-hour', five ? `resets ${five}` : ''))
      }
      if (isOn('context') && last) {
        rings.push(ring('rc', ringSvg(last.percent, contextColor(last.percent), [{ at: CONTEXT_COMPACT, color: '#E24B4A' }]), `context ${last.percent}% full`,
          isFull ? 'context ⚠' : 'context', `${short(last.tokens)} / ${short(last.window)}`, isFull ? RED : undefined))
      }
      const showSpend = isOn('spend') && !!u
      const showTokens = isOn('tokens')
      const tile = (key: string, label: string, usd: number, tokens: number) => (
        <Box key={key} flexDirection="column" paddingX={1} backgroundColor={TILE} minWidth={TILE_W}>
          <Text color={MUTED}>{label}</Text>
          {showSpend ? <Text bold>{dollars(usd)}</Text> : null}
          {showTokens ? <Text color={MUTED}>{`${tokensShort(tokens)} tok`}</Text> : null}
        </Box>
      )
      const tiles = showSpend || showTokens
        ? [tile('t0', 'this chat', u ? u.usd : 0, mine.tokens), tile('t1', 'today', sum.today.usd, sum.today.tokens),
          tile('t2', '7 days', sum.week.usd, sum.week.tokens), tile('t3', 'all time', sum.all.usd, sum.all.tokens)]
        : []
      if (rings.length || tiles.length) {
        rows.push(
          <Box key="dash" flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
            {rings.length ? <Box key="rings" flexDirection="row" gap={2}>{rings}</Box> : null}
            {tiles.length ? <Box key="tiles" flexDirection="row" gap={1}>{tiles}</Box> : null}
            {actions}
          </Box>,
        )
        isActionsPlaced = true
      }
      if (isOn('week') && pace && pace.level !== 'ok') {
        rows.push(<Text key="wwarn" color={pace.color} wrap="truncate-end">{`⚠ Week: ${pace.word}${weekLeft ? ` · resets in ${weekLeft}` : ''}`}</Text>)
      }
      if (isOn('context') && isFull && last) {
        rows.push(<Text key="cwarn" color={RED} wrap="truncate-end">{`⚠ Context ${last.percent}% full: compact to keep the next turns cheap`}</Text>)
      }
    } else {
    // The weekly limit leads: it is the one that runs out for days.
    if (isOn('week') && u && u.week >= 0) {
      const pace = weekPace(u.week, u.weekResets, now, await profileOf($, now))
      const week = resetsIn(u.weekResets, now)
      rows.push(row('week', 'week',
        bar('bw', barSvg(u.week, pace.color, [{ at: pace.elapsed, color: '#D3D1C7' }]), `weekly limit ${Math.round(u.week)}% used`),
        <Text key="wk" wrap="truncate-end">
          <Text color={pace.color} bold>{`${Math.round(u.week)}% used`}</Text>
          <Text color={pace.level === 'ok' ? MUTED : pace.color} bold={pace.level !== 'ok'}>{`  ${pace.level === 'ok' ? '' : '⚠ '}${pace.word}`}</Text>
          {week ? <Text color={MUTED}>{` · resets in ${week}`}</Text> : null}
        </Text>,
      ))
    }

    if (isOn('usage') && u && u.fiveHour >= 0) {
      const five = resetsIn(u.fiveResets, now)
      rows.push(row('usage', '5-hour',
        bar('b5', barSvg(u.fiveHour, levelColor(u.fiveHour)), `5-hour window ${Math.round(u.fiveHour)}%`),
        <Text key="use" wrap="truncate-end">
          <Text color={levelColor(u.fiveHour)} bold>{`${Math.round(u.fiveHour)}% used`}</Text>
          {five ? <Text color={MUTED}>{`  resets in ${five}`}</Text> : null}
        </Text>,
      ))
    }

    if (isOn('context') && last) {
      const prev = rs[rs.length - 2]
      const delta = prev ? last.tokens - prev.tokens : 0
      const color = contextColor(last.percent)
      rows.push(row('context', 'context',
        bar('bc', barSvg(last.percent, color, [{ at: CONTEXT_COMPACT, color: '#E24B4A' }]), `context ${last.percent}% full`),
        <Text key="ctx" wrap="truncate-end">
          <Text color={color} bold>{`${last.percent}% full`}</Text>
          <Text color={MUTED}>{`  ${short(last.tokens)} / ${short(last.window)}`}</Text>
          {delta !== 0 ? <Text color={MUTED}>{`  ${delta > 0 ? '▲ +' : '▼ '}${short(Math.abs(delta))} last turn`}</Text> : null}
          <Text color={isFull ? RED : MUTED} bold={isFull}>{`  ${isFull ? '⚠ ' : ''}${forecast(last.percent)}`}</Text>
        </Text>,
        actions,
      ))
      isActionsPlaced = true
    }

    if (isOn('spend') && u) {
      rows.push(row('spend', 'spend', bar('bs', null, ''),
        <Text key="sp" wrap="truncate-end">
          <Text bold>{dollars(u.usd)}</Text><Text color={MUTED}>{' this chat'}</Text>{dot('s1')}
          <Text bold>{dollars(sum.today.usd)}</Text><Text color={MUTED}>{' today'}</Text>{dot('s2')}
          <Text bold>{dollars(sum.week.usd)}</Text><Text color={MUTED}>{' 7d'}</Text>{dot('s3')}
          <Text bold>{dollars(sum.all.usd)}</Text><Text color={MUTED}>{' all time'}</Text>
        </Text>,
      ))
    }
    if (isOn('tokens') && sum.all.tokens > 0) {
      rows.push(row('tokens', 'tokens', bar('bt', null, ''),
        <Text key="tk" wrap="truncate-end">
          <Text bold>{tokensShort(mine.tokens)}</Text><Text color={MUTED}>{' this chat'}</Text>{dot('t1')}
          <Text bold>{tokensShort(sum.today.tokens)}</Text><Text color={MUTED}>{' today'}</Text>{dot('t2')}
          <Text bold>{tokensShort(sum.week.tokens)}</Text><Text color={MUTED}>{' 7d'}</Text>{dot('t3')}
          <Text bold>{tokensShort(sum.all.tokens)}</Text><Text color={MUTED}>{' all time'}</Text>
        </Text>,
      ))
    }

    }

    if (isOn('turn') && t) {
      const { added, removed } = lineTotals(t)
      const parts: RenderChildren[] = [<Text key="ok" color={t.failed ? RED : GREEN}>{t.failed ? '! ' : '✓ '}</Text>, <Text key="d">{duration(t.durationMs ?? 0)}</Text>]
      if (t.files.length) {
        parts.push(dot('d1'), <Text key="ed">{`edited ${t.files.length} `}</Text>, <Text key="ad" color={GREEN}>{`+${added}`}</Text>, <Text key="rm" color={RED}>{` −${removed}`}</Text>)
      }
      if (t.commands) parts.push(dot('d2'), <Text key="cm">{`${t.commands} command${t.commands === 1 ? '' : 's'}`}</Text>)
      if (t.failed) parts.push(dot('d3'), <Text key="fl" color={RED}>{`${t.failed} failed`}</Text>)
      if (t.reads) parts.push(dot('d4'), <Text key="rd" color={MUTED}>{`${t.reads} read${t.reads === 1 ? '' : 's'}`}</Text>)
      if (t.agents) parts.push(dot('d5'), <Text key="ag" color={MUTED}>{`${t.agents} agent${t.agents === 1 ? '' : 's'}`}</Text>)
      rows.push(row('turn', 'last turn', bar('bl', null, ''), <Text key="tl" wrap="truncate-end">{parts}</Text>))
    }

    if (isOn('tasks') && todo) {
      rows.push(row('tasks', 'tasks',
        bar('bk', barSvg((todo.done / todo.total) * 100, BLUE), `${todo.done} of ${todo.total} done`),
        <Text key="tk" wrap="truncate-end">
          <Text color={BLUE}>{'● '}</Text>
          <Text bold>{`${todo.done}/${todo.total}`}</Text>
          <Text color={MUTED}>{` ${todo.list} · `}</Text>
          <Text>{todo.current}</Text>
          {todo.next ? <Text color={MUTED}>{` · next: ${todo.next}`}</Text> : null}
        </Text>,
      ))
    }

    // No row took the buttons (context row off, or no reading yet): they get a row of their own.
    if (actions && !isActionsPlaced) rows.push(row('chat', 'chat', bar('ba', null, ''), <Box key="acts" flexDirection="row" gap={1}>{actions}</Box>))

    const below = await next(e).catch(() => null)
    const arrow = (await read($, hiderArrow))
      ? Button
        ? <Button key="hide-mods" label="▾" plain onPress={() => void $.command.run({ command: 'hide-mods' }).catch(() => undefined)} />
        : <Text key="hide-mods" dimColor>▾</Text>
      : null
    if (rows.length === 0 && !arrow) return <Box flexDirection="column">{below}</Box>
    const band = <Box flexDirection="column" paddingX={1}>{rows}</Box>
    return (
      <Box flexDirection="column">
        {arrow ? (
          <Box flexDirection="row">
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>{band}</Box>
            <Box flexShrink={0} marginLeft={1} alignSelf="flex-start">{arrow}</Box>
          </Box>
        ) : band}
        {below}
      </Box>
    )
  })
}
