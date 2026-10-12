import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { dayKey } from './logic'

// Sample data for the README screenshots: the band and the /mods panel as the desktop app
// would be handed them. tools/shots.py turns the printed trees into pictures.

const NOW = Date.parse('2026-10-12T15:00:00Z')
const HOME = 'C:/Users/me'
const START = { cwd: '/repo', surface: 'desktop', isInteractive: true } as const
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 14, bodyColumns: 120, scroll: { offset: 0, bodyRows: 13 }, view: {} },
} as const
const USAGE = { input_tokens: 40, output_tokens: 2_100, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 12_000, model: 'claude-opus-5-5' }
const WS = 'mcp__plugin_claude-mem_mcp-search__work_state_write'

const MODS: Record<string, string> = {
  'status-band@claude-mod-pack': 'Claude Status Band: usage limits with a pace that learns your hours, spend, context, last turn and tasks above the prompt, Compact and Handoff buttons, and a /mods panel to switch mods on or off.',
  'claude-mod-hider@claude-mod-pack': 'Claude Mod Hider: one tiny button that hides or shows every Claude Code mod above the prompt, remembered across sessions.',
  'codex-bridge@claude-mod-pack': 'Claude Codex Bridge: OpenAI Codex models as native Claude Code subagents, with the same task rows, timers, token counts, tool rows, background notices and SendMessage follow-ups.',
  'focus-timer@example': 'A pomodoro timer above the prompt that pauses itself while Claude is working and tells you when a break is due.',
  'pixel-pet@example': 'A small pixel pet that sleeps while you type, wakes when a turn finishes and gets grumpy when tests fail.',
}
const FILES: Record<string, string> = {
  [`${HOME}/.claude/plugins/installed_plugins.json`]: JSON.stringify({
    plugins: Object.fromEntries(Object.keys(MODS).map(id => [id, [{ installPath: `C:/mods/${id.split('@')[0]}` }]])),
  }),
  ...Object.fromEntries(Object.entries(MODS).flatMap(([id, description]) => {
    const dir = `C:/mods/${id.split('@')[0]}`
    return [[`${dir}/hooks/hooks.json`, '{ "modules": ["./register.tsx"] }'], [`${dir}/.claude-plugin/plugin.json`, JSON.stringify({ description })]]
  })),
}

function host(on: On) {
  const disk: Record<string, { text: string; mtimeMs: number }> = {}
  // Two other chats' ledgers, so today, 7 days and all time differ from this chat.
  const day = (n: number) => dayKey(NOW - n * 86_400_000)
  const other = (days: Record<string, [number, number]>) =>
    JSON.stringify({ days: Object.fromEntries(Object.entries(days).map(([d, [usd, tokens]]) => [d, { usd, tokens }])), usd: 0, tokens: 0 })
  disk[`${HOME}/.claude/status-band/spend/older.json`] = { text: other({ [day(0)]: [6.85, 2_310_000], [day(2)]: [11.4, 3_920_000], [day(5)]: [8.2, 2_750_000], [day(12)]: [19.75, 6_880_000], [day(30)]: [24.1, 8_400_000] }), mtimeMs: 1 }
  disk[`${HOME}/.claude/status-band/spend/side.json`] = { text: other({ [day(1)]: [3.3, 1_180_000], [day(3)]: [5.05, 1_640_000] }), mtimeMs: 2 }
  const slash = (p: string) => p.split(String.fromCharCode(92)).join('/')
  on('env.get', ($, e) => ({ value: (e as { name: string }).name === 'USERPROFILE' ? HOME : undefined }) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('fs.write', ($, e) => {
    const { path, text } = e as unknown as { path: string; text: string }
    disk[slash(path)] = { text, mtimeMs: Object.keys(disk).length + 1 }
    return { value: undefined } as never
  })
  on('fs.list', ($, e) => {
    const dir = slash(String((e as { path?: string }).path ?? ''))
    const value = Object.entries(disk)
      .filter(([k]) => k.startsWith(`${dir}/`))
      .map(([k, v]) => ({ name: k.slice(dir.length + 1), kind: 'file', size: v.text.length, mtimeMs: v.mtimeMs, isLink: false }))
    return { value } as never
  })
  on('fs.read', ($, e) => {
    const path = slash((e as { path: string }).path)
    if (path in disk) return { value: disk[path]!.text } as never
    if (path in FILES) return { value: FILES[path] } as never
    throw new Error(`missing ${path}`)
  })
  on('settings.read', () => ({ value: { enabledPlugins: { 'status-band@claude-mod-pack': true, 'claude-mod-hider@claude-mod-pack': true, 'codex-bridge@claude-mod-pack': true, 'pixel-pet@example': true } } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {})
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 3_600_000,
      context: { tokens: 412_000, window: 1_000_000, percent: 41.2 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 38, resetsAt: new Date(NOW + (2 * 60 + 10) * 60_000).toISOString() },
        { kind: 'seven_day', percentUsed: 52, resetsAt: new Date(NOW + (3 * 24 + 9) * 3_600_000).toISOString() },
      ],
      cost: { usd: 4.12 },
    },
  }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Edit') return { result: { structuredPatch: [{ lines: ['-a', '+b', '+c', '+d', '+e'] }] }, text: 'ok' } as never
    return { result: 'ok', text: 'ok' } as never
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="core" />
  })
  return { clock }
}

test('screenshots: the band and the /mods panel with sample data', async ($, on) => {
  const { clock } = host(on)
  await $.session.start(START)
  await clock.settle()
  await $.turn.start({ text: 'fix the flaky login test', turnId: 't1' })
  await $.tool.call({ tool: WS, list: 'login-fix', fields: { task: 'Reproduce the flaky test', status: 'done' } } as never)
  await $.tool.call({ tool: WS, list: 'login-fix', fields: { task: 'Fix the race in the session check', status: 'doing' } } as never)
  await $.tool.call({ tool: WS, list: 'login-fix', fields: { task: 'Run the suite 20 times', status: 'todo' } } as never)
  for (const f of ['auth.ts', 'session.ts']) await $.tool.call({ tool: 'Edit', file_path: `/repo/${f}`, old_string: 'a', new_string: 'b' } as never)
  for (const c of ['npm test', 'npm test -- --repeat 20', 'git diff']) await $.tool.call({ tool: 'Bash', command: c } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/login.test.ts' } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 154_000, isAborted: false, turnId: 't1', reason: 'answer', usage: USAGE } as never)

  const band = await $.ui.mount({ plugin: 'status-band', surface: 'desktop', ...BAND })
  const bandTree = await band.drawn()
  await band.unmount()

  await $.command.run({ origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 }, command: 'mods', args: '' } as never)
  const pane = await $.ui.mount({ plugin: 'status-band', surface: 'desktop', component: 'Pane', requestId: 'status-band-mods', props: { title: 'Mods', isFocused: true, bodyColumns: 78, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } } as never)
  const paneTree = await pane.drawn()
  await pane.unmount()

  expect(bandTree).toMatchObject({ type: 'Box' })
  expect(paneTree).toMatchObject({ type: 'Box' })
  console.log(`SHOT band ${JSON.stringify(bandTree)}`)
  console.log(`SHOT mods ${JSON.stringify(paneTree)}`)
})
