import { test, expect } from 'claude-code/testing'
import type { TurnStepChunk } from 'claude-code'

// A real `codex exec --json` run (gpt-6-luna, 2026-10-07), commands shortened.
const CODEX_RUN = [
  { type: 'thread.started', thread_id: '01a118d8-8d34-7ae3-bfce-a463acb2f0bb' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Exceeded skills context budget.' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: '**Preparing file overview**' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'I will list tools and read check.sh.' } },
  { type: 'item.started', item: { id: 'item_3', type: 'command_execution', command: 'ls tools', aggregated_output: '', exit_code: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: 'ls tools', aggregated_output: 'check.sh\nclip.sh\n', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_4', type: 'reasoning', text: '**Reading the script**' } },
  { type: 'item.started', item: { id: 'item_5', type: 'command_execution', command: 'head -5 tools/check.sh', aggregated_output: '', exit_code: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_5', type: 'command_execution', command: 'head -5 tools/check.sh', aggregated_output: '#!/usr/bin/env bash\n', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_7', type: 'agent_message', text: '`tools/check.sh` runs the headless project checks.' } },
  { type: 'turn.completed', usage: { input_tokens: 94006, cached_input_tokens: 61696, cache_write_input_tokens: 0, output_tokens: 877, reasoning_output_tokens: 581 } },
].map(e => JSON.stringify(e)).join('\n') + '\n'

test('a Codex run becomes native subagent steps: tool calls, then the answer with usage', async ($, on) => {
  const spawned: string[][] = []
  on('agent.list', () => ({ value: [{ id: 'agent-1', type: 'codex-bridge:luna-ro', description: 'smoke', status: 'running' as const }] }))
  on('session.messages', () => ({ value: [{ role: 'user' as const, text: 'List tools and explain check.sh.', toolUses: [] }] }))
  on('process.spawn', async function* (_$, e) {
    spawned.push([...e.argv])
    // Split mid-line to prove lines are reassembled across pieces.
    yield { stream: 'stdout' as const, text: CODEX_RUN.slice(0, 333) }
    yield { stream: 'stdout' as const, text: CODEX_RUN.slice(333) }
    return { value: { code: 0, signal: null } }
  })

  const step = async (index: number) => {
    const chunks: TurnStepChunk[] = []
    const stream = $.turn.step({ turnId: 'turn-1', index, model: 'sonnet', messageCount: 1, agentId: 'agent-1' })
    for (;;) {
      const n = await stream.next()
      if (n.done) return { chunks, result: n.value }
      chunks.push(n.value)
    }
  }

  const first = await step(0)
  expect(spawned.length).toBe(1)
  expect(spawned[0]).toContain('gpt-6-luna')
  expect(spawned[0]).toContain('read-only')
  expect(first.result.stopReason).toBe('tool_use')
  expect(first.result.toolUses[0]?.name).toBe('mcp__codex-bridge__shell')
  expect(first.result.toolUses[0]?.input).toEqual({ command: 'ls tools', exit_code: 0 })
  expect(first.result.answer).toBe('I will list tools and read check.sh.')
  expect(first.chunks.some(c => c.kind === 'thinking' && c.text.includes('Preparing'))).toBe(true)
  expect(first.chunks[first.chunks.length - 1]?.kind).toBe('stop')

  const second = await step(1)
  expect(spawned.length).toBe(1) // the same Codex process continues
  expect(second.result.stopReason).toBe('tool_use')
  expect(second.result.toolUses[0]?.input).toEqual({ command: 'head -5 tools/check.sh', exit_code: 0 })

  const third = await step(2)
  expect(third.result.stopReason).toBe('end_turn')
  expect(third.result.toolUses.length).toBe(0)
  expect(third.result.answer).toBe('`tools/check.sh` runs the headless project checks.')
  expect(third.result.usage).toEqual({
    model: 'gpt-6-luna',
    input_tokens: 94006 - 61696,
    cache_read_input_tokens: 61696,
    cache_creation_input_tokens: 0,
    output_tokens: 877,
  })

  // A SendMessage follow-up resumes the same Codex thread.
  await step(3)
  expect(spawned.length).toBe(2)
  expect(spawned[1]).toContain('resume')
  expect(spawned[1]).toContain('01a118d8-8d34-7ae3-bfce-a463acb2f0bb')
})

test('steps of other agents and of the main loop pass through untouched', async ($, on) => {
  let spawnedCodex = false
  on('agent.list', () => ({ value: [{ id: 'agent-2', type: 'Explore', description: 'x', status: 'running' as const }] }))
  on('process.spawn', async function* () { spawnedCodex = true; return { value: { code: 0, signal: null } } })
  on('turn.step', async function* () {
    yield { kind: 'text' as const, index: 0, text: 'native' }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    return { turnId: 't', index: 0, answer: 'native', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  for (const agentId of ['agent-2', undefined]) {
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'sonnet', messageCount: 1, ...(agentId ? { agentId } : {}) })
    let n = await stream.next()
    while (!n.done) n = await stream.next()
    expect(n.value.answer).toBe('native')
  }
  expect(spawnedCodex).toBe(false)
})

test('the record tools refuse a direct call', async $ => {
  const r = await $.tool.call({ tool: 'mcp__codex-bridge__shell', command: 'rm -rf /' } as never)
  expect(r.deny).toContain('cannot be called directly')
})
