import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { FLAT_PROFILE, activityProfile, addActivity, addCost, applyWorkState, dayKey, emptyLedger, resetsIn, taskSummary, totalsOf, weekPace } from './logic'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 140, scroll: { offset: 0, bodyRows: 11 }, view: {} },
} as const
const USAGE = { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 9_490, model: 'claude-opus-5-5' }
const DONE = { answer: 'ok', durationMs: 316_000, isAborted: false, turnId: 't1', reason: 'answer', usage: USAGE } as const
const WS = 'mcp__plugin_claude-mem_mcp-search__work_state_write'

let tokens = 0
let usd = 7.9
let failing = new Set<string>()
let toasts: string[] = []
let disk: Record<string, { text: string; mtimeMs: number }> = {}
let compacted = 0
let veto: string | undefined
const SPEND = 'C:/Users/me/.claude/status-band/spend'

function host(on: On) {
  tokens = 100_000
  usd = 7.9
  failing = new Set()
  toasts = []
  disk = {}
  compacted = 0
  veto = undefined
  // A file system in memory: the band's ledgers never reach the real disk.
  on('env.get', ($, e) => ({ value: (e as { name: string }).name === 'USERPROFILE' ? 'C:/Users/me' : undefined }) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  // A compaction that stands hands up the conversation after it; a veto, its reason.
  on('session.compact', () => (compacted++, veto === undefined ? { messages: [{ role: 'user', text: 'summary', toolUses: [] }] } : { skip: veto }) as never)
  on('fs.write', ($, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    disk[path.split(String.fromCharCode(92)).join('/')] = { text, mtimeMs: Object.keys(disk).length + 1 }
    return { value: undefined } as never
  })
  on('fs.list', ($, e) => {
    const dir = String((e as { path?: string }).path ?? '').split(String.fromCharCode(92)).join('/')
    const value = Object.entries(disk)
      .filter(([k]) => k.startsWith(`${dir}/`))
      .map(([k, v]) => ({ name: k.slice(dir.length + 1), kind: 'file', size: v.text.length, mtimeMs: v.mtimeMs, isLink: false }))
    return { value } as never
  })
  on('fs.read', ($, e) => {
    const path = (e as { path: string }).path.split(String.fromCharCode(92)).join('/')
    if (path in disk) return { value: disk[path]!.text } as never
    if (path in FILES) return { value: FILES[path] } as never
    throw new Error(`missing ${path}`)
  })
  on('ui.toast', ($, e) => (toasts.push(String((e as { text: string }).text)), { value: undefined }) as never)
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {})
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { tokens, window: 1_000_000, percent: tokens / 10_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 11, resetsAt: new Date(NOW + (3 * 60 + 55) * 60_000).toISOString() },
        { kind: 'seven_day', percentUsed: 36, resetsAt: new Date(NOW + (4 * 24 + 17) * 3_600_000).toISOString() },
      ],
      cost: { usd },
    },
  }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool === 'Bash' && failing.has(String(input.command))) return { isError: true, result: 'exit 1', text: 'exit 1' } as never
    if (e.tool === 'Edit') return { result: { structuredPatch: [{ lines: ['-a', '+b', '+c'] }] }, text: 'ok' } as never
    return { result: 'ok', text: 'ok' } as never
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="core" />
  })
  return { clock }
}

// The band's text, row by row: each row's label followed by what it says.
async function band($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'status-band', surface, ...BAND })
  const texts = ((await ui.findAll({ type: 'Text' })) as { text?: string }[]).map(t => t.text ?? '')
  const svgs = surface === 'desktop' ? ((await ui.findAll({ type: 'Svg' } as never)) as unknown[]).length : 0
  await ui.unmount()
  return { all: texts.join('\n'), svgs }
}

test('usage, context and the last turn each get a labelled row', async ($, on) => {
  const { clock } = host(on)
  await $.session.start(START)
  await clock.settle()
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/b.ts' } as never)
  failing.add('npm test')
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  tokens = 363_500
  await $.turn.complete(DONE)
  const { all } = await band($)
  expect(all).toContain('5-hour')
  expect(all).toContain('11% used')
  expect(all).toContain('resets in 3h 55m')
  expect(all).toContain('36% used')
  expect(all).toContain('runs out ~')
  expect(all).toContain('resets in 4d 17h')
  expect(all).toContain('$7.90')
  expect(all).toContain('Cloudy')
  expect(all).toContain('! 5m 16s')
  expect(all).toContain('363.5k / 1M')
  expect(all).toContain('▲ +263.5k last turn')
  expect(all).toContain('last turn')
  expect(all).toContain('5m 16s')
  expect(all).toContain('edited 1 ')
  expect(all).toContain('+2')
  expect(all).toContain('2 commands')
  expect(all).toContain('1 failed')
})

test('the usage row reads again every 30 seconds without a turn', async ($, on) => {
  const { clock } = host(on)
  await $.session.start(START)
  await clock.settle()
  expect((await band($)).all).toContain('$7.90')
  usd = 9.25
  await clock.advance(30_000)
  expect((await band($)).all).toContain('$9.25')
})

test('claude-mem work state shows as the tasks row until the list is closed', async ($, on) => {
  const { clock } = host(on)
  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: WS, list: 'band', fields: { task: 'Write logic', status: 'done' } } as never)
  await $.tool.call({ tool: WS, list: 'band', fields: { task: 'Write tests', status: 'doing' } } as never)
  await $.tool.call({ tool: WS, list: 'band', fields: { task: 'Install', status: 'todo' } } as never)
  const shown = (await band($)).all
  expect(shown).toContain('tasks')
  expect(shown).toContain('1/3')
  expect(shown).toContain('Write tests')
  expect(shown).toContain('next: Install')
  await $.tool.call({ tool: WS, list: 'band', fields: { status: 'done' } } as never)
  expect((await band($)).all).not.toContain('tasks')
})

test('the desktop draws meters and weather; the terminal draws text alone', async ($, on) => {
  const { clock } = host(on)
  await $.session.start(START)
  await clock.settle()
  expect((await band($, 'desktop')).svgs).toBeGreaterThan(1)
  expect((await band($, 'terminal')).all).toContain('11% used')
})

test('/band hides the band and brings it back', async ($, on) => {
  const { clock } = host(on)
  await $.session.start(START)
  await clock.settle()
  const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
  await $.command.run({ ...RUN, command: 'band', args: '' })
  expect((await band($)).all).not.toContain('5-hour')
  await $.command.run({ ...RUN, command: 'band', args: '' })
  expect((await band($)).all).toContain('5-hour')
})

test('pure helpers: reset times and task summaries', () => {
  expect(resetsIn(new Date(NOW + 61 * 60_000).toISOString(), NOW)).toBe('1h 1m')
  expect(resetsIn('', NOW)).toBe('')
  let t = applyWorkState(null, { list: 'x', fields: { task: 'a', status: 'dropped' } })
  t = applyWorkState(t, { list: 'x', fields: { task: 'b', status: 'todo' } })
  expect(taskSummary(t)).toEqual({ list: 'x', done: 0, total: 1, current: 'b', next: '' })
  expect(taskSummary(applyWorkState(t, { list: 'x', fields: { task: 'b', status: 'done' } }))).toBeNull()
})

const HOME = 'C:/Users/me'
const FILES: Record<string, string> = {
  [`${HOME}/.claude/plugins/installed_plugins.json`]: JSON.stringify({
    plugins: {
      'status-band@claude-mod-pack': [{ installPath: 'C:/mods/status-band' }],
      'reflect-mod@x': [{ installPath: 'C:/mods/reflect' }],
      'skills-only@x': [{ installPath: 'C:/mods/skills' }],
    },
  }),
  'C:/mods/status-band/hooks/hooks.json': '{ "modules": ["./register.tsx"] }',
  'C:/mods/status-band/.claude-plugin/plugin.json': '{ "description": "One tidy band" }',
  'C:/mods/reflect/hooks/hooks.json': '{ "modules": ["./register.tsx"] }',
  'C:/mods/reflect/.claude-plugin/plugin.json': '{ "description": "Save rules" }',
  'C:/mods/skills/.claude-plugin/plugin.json': '{ "description": "Skills only" }',
}

test('/mods lists mods with their switches; a row switch hides that row at once', async ($, on) => {
  const ran: string[][] = []
  const { clock } = host(on)
  on('settings.read', () => ({ value: { enabledPlugins: { 'status-band@claude-mod-pack': true, 'reflect-mod@x': true } } }) as never)
  on('process.run', ($, e) => (ran.push([...(e as { argv: string[] }).argv]), { value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  await $.session.start(START)
  await clock.settle()
  const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
  expect((await $.command.run({ ...RUN, command: 'mods', args: '' })).text).toBe('Mods panel opened: 2 mods.')
  const pane = await $.ui.mount({ plugin: 'status-band', surface: 'terminal', component: 'Pane', requestId: 'status-band-mods', props: { title: 'Mods', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as never)
  const texts = ((await pane.findAll({ type: 'Text' })) as { text?: string }[]).map(t => t.text ?? '').join('\n')
  expect(texts).toContain('reflect-mod')
  expect(texts).toContain('Save rules')
  // A description wraps to as many lines as it needs, never cut to one.
  const desc = ((await pane.findAll({ type: 'Text' })) as { text?: string; props?: { wrap?: string } }[]).find(t => t.text === 'Save rules')
  expect(desc?.props?.wrap).toBe('wrap')
  expect(texts).not.toContain('skills-only')
  await pane.press({ key: 'r-usage' })
  await pane.press({ key: 'm-reflect-mod@x' })
  const after = ((await pane.findAll({ type: 'Text' })) as { text?: string }[]).map(t => t.text ?? '').join('\n')
  await pane.unmount()
  expect(after).toContain('(off next session)')
  expect(ran).toEqual([['claude', 'plugin', 'disable', 'reflect-mod@x']])
  const shown = (await band($)).all
  expect(shown).not.toContain('5-hour')
  expect(shown).toContain('context')
})

test('the weekly pace: on pace, ahead of it, nearly out', () => {
  const resets = (h: number) => new Date(NOW + h * 3_600_000).toISOString()
  // Halfway through the week with 30% used: lasts, about 60% by the reset.
  expect(weekPace(30, resets(84), NOW, FLAT_PROFILE).word).toBe('on pace, ~60% by reset')
  // Halfway with 60% used: out in 56 hours, before the reset in 84.
  const ahead = weekPace(60, resets(84), NOW, FLAT_PROFILE)
  expect(ahead.level).toBe('ahead')
  expect(ahead.word).toContain('in 2d 8h')
  expect(weekPace(92, resets(84), NOW).level).toBe('low')
  expect(weekPace(100, resets(84), NOW).level).toBe('out')
  // Too early in the week to judge.
  expect(weekPace(5, resets(167), NOW).word).toBe('on pace')
})

test('no pop-up for the weekly limit, however far ahead of pace', async ($, on) => {
  const { clock } = host(on)
  await $.session.start(START)
  await clock.settle()
  await clock.advance(90_000)
  await clock.settle()
  expect(toasts).toEqual([])
})

test('spend and tokens: this chat, today, 7 days and all time, other sessions included', async ($, on) => {
  const { clock } = host(on)
  // Another session spent $2 today and $5 ten days ago.
  const day = (ago: number) => dayKey(NOW - ago * 86_400_000)
  disk[`${SPEND}/other.json`] = {
    text: JSON.stringify({ days: { [day(0)]: { usd: 2, tokens: 1_000_000 }, [day(10)]: { usd: 5, tokens: 3_000_000 } }, usd: 7, tokens: 4_000_000 }),
    mtimeMs: 1,
  }
  await $.session.start(START)
  await clock.settle()
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(DONE)
  const { all } = await band($)
  expect(all).toContain('spend')
  expect(all).toContain('$7.90 this chat')
  expect(all).toContain('$9.90 today')
  expect(all).toContain('$9.90 7d')
  expect(all).toContain('$14.90 all time')
  expect(all).toContain('100k this chat')
  expect(all).toContain('1.1M today')
  expect(all).toContain('4.1M all time')
  const desk = (await band($, 'desktop')).all
  expect(desk).toContain('this chat')
  expect(desk).toContain('$9.90')
  expect(desk).toContain('4.1M tok')
  expect(desk).toContain('⚠ Week: runs out ~')
  // This session's own ledger is on disk for the others to read.
  expect(JSON.parse(disk[`${SPEND}/s1.json`]!.text).usd).toBe(7.9)
})

test('the ledger counts only what the session spent since the last reading', () => {
  const d = dayKey(NOW)
  let l = addCost(emptyLedger(), 3, d)
  l = addCost(l, 5, d)
  l = addCost(l, 5, d)
  // The session cleared: its total starts again, nothing is taken off.
  l = addCost(l, 1, d)
  l = addCost(l, 1.5, d)
  expect(totalsOf([l], NOW).today.usd).toBe(5.5)
})

test('context turns yellow at 50%, red at 75% with Compact now', async ($, on) => {
  const { clock } = host(on)
  await $.session.start(START)
  await clock.settle()
  tokens = 800_000
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(DONE)
  const ui = await $.ui.mount({ plugin: 'status-band', surface: 'desktop', ...BAND })
  const texts = ((await ui.findAll({ type: 'Text' })) as { text?: string }[]).map(t => t.text ?? '').join(String.fromCharCode(10))
  expect(texts).toContain('Context 80% full')
  expect(texts).toContain('context ⚠')
  await ui.press({ key: 'compact' })
  await ui.unmount()
  expect(compacted).toBe(1)
})

test('Compact now pressed during a turn waits for the turn to end, then compacts and says so', async ($, on) => {
  const { clock } = host(on)
  await $.session.start(START)
  await clock.settle()
  tokens = 800_000
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(DONE)
  await $.turn.start({ text: 'more', turnId: 't2' })
  const ui = await $.ui.mount({ plugin: 'status-band', surface: 'desktop', ...BAND })
  await ui.press({ key: 'compact' })
  await clock.settle()
  expect(compacted).toBe(0)
  expect(toasts.join(' ')).toContain('compacts as soon as this turn ends')
  const queued = JSON.stringify(await ui.findAll({ type: 'Button' } as never))
  expect(queued).toContain('Compact queued')
  await ui.unmount()
  await $.turn.complete({ ...DONE, turnId: 't2' })
  await clock.advance(1100)
  await clock.settle()
  expect(compacted).toBe(1)
  expect(toasts.join(' ')).toContain('Compacted.')
})

test('Compact now and Handoff show at any context fill, even with the context row off', async ($, on) => {
  const { clock } = host(on)
  await $.session.start(START)
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'status-band', surface, ...BAND })
    const buttons = JSON.stringify(await ui.findAll({ type: 'Button' } as never))
    expect(buttons).toContain('Compact now')
    expect(buttons).toContain('Handoff')
    await ui.press({ key: 'compact' })
    await clock.settle()
    await ui.unmount()
  }
  expect(compacted).toBe(2)
})

test('Handoff submits the handoff prompt once, as the person, and frees the button when that turn ends', async ($, on) => {
  const { clock } = host(on)
  const sent: { text: string; origin?: { asUser?: boolean } }[] = []
  on('prompt.submit', ($, e) => (sent.push(e as never), { text: e.text }) as never)
  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'status-band', surface: 'terminal', ...BAND })
  await ui.press({ key: 'handoff' })
  await ui.press({ key: 'handoff' })
  await clock.settle()
  expect(sent.length).toBe(1)
  expect(sent[0]!.text).toContain('Hand off this chat.')
  expect(sent[0]!.text).toContain('start_session')
  expect(sent[0]!.origin?.asUser).toBe(true)
  expect(JSON.stringify(await ui.findAll({ type: 'Button' } as never))).toContain('Handoff queued')
  await ui.unmount()
  await $.turn.start({ text: sent[0]!.text, turnId: 'h1' })
  await $.turn.complete({ ...DONE, turnId: 'h1' })
  const after = await $.ui.mount({ plugin: 'status-band', surface: 'terminal', ...BAND })
  const label = JSON.stringify(await after.findAll({ type: 'Button' } as never))
  await after.unmount()
  expect(label).not.toContain('Handoff queued')
  expect(label).not.toContain('Handing off')
})

test('a compact a hook vetoes says why instead of doing nothing', async ($, on) => {
  const { clock } = host(on)
  await $.session.start(START)
  await clock.settle()
  tokens = 800_000
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(DONE)
  veto = 'a PreCompact hook said no'
  const ui = await $.ui.mount({ plugin: 'status-band', surface: 'desktop', ...BAND })
  await ui.press({ key: 'compact' })
  await clock.settle()
  await ui.unmount()
  expect(compacted).toBe(1)
  expect(toasts.join(' ')).toContain('Not compacted: a PreCompact hook said no')
})

test('in a session with no terminal of its own (the desktop app), Compact now runs /compact instead', async ($, on) => {
  const { clock } = host(on)
  const ran: string[] = []
  on('command.run', ($, e) => (ran.push(`/${e.command} ${e.args}`.trim()), { text: 'Compacted' }) as never)
  await $.session.start({ ...START, surface: 'desktop', isInteractive: false })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'status-band', surface: 'desktop', ...BAND })
  await ui.press({ key: 'compact' })
  await clock.settle()
  expect(JSON.stringify(await ui.findAll({ type: 'Button' } as never))).toContain('Compact now')
  await ui.unmount()
  expect(compacted).toBe(0)
  expect(ran).toEqual(['/compact'])
  expect(toasts.join(' ')).toContain('/compact is running')
})

test('with Claude Mod Hider on, the band draws its arrow in its own corner and the arrow runs /hide-mods', async ($, on) => {
  const { clock } = host(on)
  const ran: string[] = []
  on('settings.read', () => ({ value: { enabledPlugins: { 'claude-mod-hider@claude-mod-pack': true } } }) as never)
  on('command.run', ($, e) => (ran.push(e.command), { text: 'ok' }) as never)
  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'status-band', surface: 'desktop', ...BAND })
  expect(JSON.stringify(await ui.findAll({ type: 'Button' } as never))).toContain('hide-mods')
  await ui.press({ key: 'hide-mods' })
  await ui.unmount()
  expect(ran).toEqual(['hide-mods'])
})

test('the week pace learns quiet hours: a night asleep is not counted as burn', () => {
  // Three weeks of activity from 9am to 11pm local, nothing overnight.
  let l = emptyLedger()
  for (let day = 1; day <= 21; day++) {
    const midnight = new Date(NOW - day * 86_400_000)
    midnight.setHours(0, 0, 0, 0)
    for (let h = 9; h < 23; h++) l = addActivity(l, 1000, midnight.getTime() + h * 3_600_000)
  }
  const learned = activityProfile([{ hours: l.hours ?? {} }], NOW)
  expect(learned.days).toBe(21)
  const at = (h: number) => learned.weights[new Date(NOW).getDay() * 24 + h]!
  expect(at(3)).toBeLessThan(at(14) / 10)
  // 11pm, 75% used, two days to the reset: the flat pace counts tonight's sleep; the learned one does not.
  const night = new Date(NOW)
  night.setHours(23, 0, 0, 0)
  const resets = new Date(night.getTime() + 48 * 3_600_000).toISOString()
  const flat = weekPace(75, resets, night.getTime(), FLAT_PROFILE)
  const mine = weekPace(75, resets, night.getTime(), learned)
  expect(flat.level).toBe('ahead')
  expect(mine.word).not.toBe(flat.word)
})

test('the seed and the live ledgers never count the same hour twice', () => {
  const h = Math.floor(NOW / 3_600_000) - 30
  const seed = { hours: { [h]: 500 }, before: h + 1 }
  const live = { hours: { [h]: 500 }, from: h + 1 }
  const both = activityProfile([seed, live, { hours: { [h - 24]: 1, [h - 48]: 1 } }], NOW)
  const one = activityProfile([seed, { hours: { [h - 24]: 1, [h - 48]: 1 } }], NOW)
  expect(both.weights).toEqual(one.weights)
})
