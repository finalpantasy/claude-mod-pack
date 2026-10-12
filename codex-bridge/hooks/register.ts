import type { EngineInterface, Register, TurnStepChunk, TurnStepInput, TurnStepResult, TurnUsage } from 'claude-code'

// codex-bridge: OpenAI Codex as a native Claude Code subagent.
//
// Each Codex model is registered as an agent type, so the Agent tool spawns a
// real subagent loop: task row, timer, background notice, SendMessage and the
// agent's transcript all come from Claude Code itself. Every model request
// that loop makes (turn.step) is answered here from `codex exec --json`
// instead of from the API. Each Codex command, patch, MCP call or search is
// replayed as a tool call of the subagent (answered from what Codex already
// did), so the agent's tool count and tool rows match a native agent's. Codex
// reasoning streams as live thinking; the final Codex message is the agent's
// answer; Codex's token usage is reported on the closing step.

const TOOLS = {
  shell: 'mcp__codex-bridge__shell',
  patch: 'mcp__codex-bridge__patch',
  tool: 'mcp__codex-bridge__tool',
  search: 'mcp__codex-bridge__search',
} as const
const TOOL_NAMES: string[] = Object.values(TOOLS)
const OUTPUT_CAP = 20000

type AgentType = { name: string; model: string; label: string; sandbox: 'workspace-write' | 'read-only' }
type CodexEvent = { type: string; [k: string]: unknown }
type CodexItem = { id?: string; type: string; [k: string]: unknown }
type Pull = IteratorResult<{ stream: 'stdout' | 'stderr'; text: string }, { code: number | null; signal: string | null } | void>
type Run = {
  iter: AsyncIterator<{ stream: 'stdout' | 'stderr'; text: string }, unknown>
  buf: string
  lines: string[]
  stderr: string
  exited: boolean
  exitCode: number | null
  done: boolean
  type: AgentType
}

const types = new Map<string, AgentType>() // `codex-bridge:<name>` -> type
const agentTypeOf = new Map<string, AgentType | null>() // agentId -> its codex type, null when not codex
const runs = new Map<string, Run>() // agentId -> the Codex process serving it
const threads = new Map<string, string>() // agentId -> Codex thread id, for follow-ups
const stash = new Map<string, string>() // tool_use_id -> what Codex already got from that call
const activity = new Map<string, string>() // agentId -> what its Codex is doing, for the status line
let resolvedCommand: string[] | undefined
let seq = 0

function showStatus($: EngineInterface) {
  const lines = [...activity.values()]
  $.ui.status(lines.length === 0 ? undefined : lines.length === 1 ? lines[0] : `codex: ${lines.length} agents running · ${lines[lines.length - 1]}`)
}

function parseModels(spec: string): AgentType[] {
  const out: AgentType[] = []
  for (const pair of spec.split(',')) {
    const [rawName, rawModel] = pair.split('=').map(s => s.trim())
    if (!rawName || !rawModel || !/^[A-Za-z0-9_-]{1,60}$/.test(rawName)) continue
    out.push({ name: rawName, model: rawModel, label: rawName, sandbox: 'workspace-write' })
    out.push({ name: `${rawName}-ro`, model: rawModel, label: `${rawName} (read-only)`, sandbox: 'read-only' })
  }
  return out
}

const AGENT_PROMPT =
  'This agent is answered by OpenAI Codex through the codex-bridge mod. If you are reading this, ' +
  "the bridge did not run. Reply exactly: 'codex-bridge: the Codex hook did not run, so no work was done.' and stop."

function describe(t: AgentType): string {
  const edits = t.sandbox === 'read-only'
    ? 'Read-only sandbox: reads files and runs commands, cannot edit.'
    : 'Workspace-write sandbox: can read, run commands and edit files in the working directory.'
  return `OpenAI Codex running ${t.model}, a non-Claude model with its own tools, as a subagent. ${edits} ` +
    'Use for a second opinion from a different model family, independent review, or parallel work. ' +
    'Give it a self-contained prompt: it does not see this conversation.'
}

const stripReminders = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
const cap = (s: string) => (s.length > OUTPUT_CAP ? `${s.slice(0, OUTPUT_CAP)}\n[... ${s.length - OUTPUT_CAP} more characters cut by codex-bridge]` : s)
const oneLine = (s: string, n = 80) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }

// What the Codex agent was asked since its last answer: the opening prompt, or
// the SendMessage follow-ups that woke it.
async function pendingPrompt($: EngineInterface, agentId: string): Promise<string> {
  const rows = await $.session.messages({ agentId })
  if (!Array.isArray(rows)) return ''
  let last = -1
  rows.forEach((r, i) => { if (r.role === 'assistant') last = i })
  const asked = rows.slice(last + 1).filter(r => r.role === 'user' && !(r.toolResults?.length)).map(r => stripReminders(r.text)).filter(Boolean)
  if (asked.length) return asked.join('\n\n')
  return rows.filter(r => r.role === 'user').map(r => stripReminders(r.text)).filter(Boolean).join('\n\n')
}

async function codexTypeOf($: EngineInterface, agentId: string): Promise<AgentType | null> {
  if (agentTypeOf.has(agentId)) return agentTypeOf.get(agentId) ?? null
  for (let attempt = 0; attempt < 10; attempt++) {
    const found = (await $.agent.list()).find(a => a.id === agentId)
    if (found) {
      const t = types.get(found.type) ?? null
      agentTypeOf.set(agentId, t)
      return t
    }
    await $.clock.sleep(100)
  }
  return null
}

function ingest(run: Run, r: Pull) {
  if (r.done) {
    run.exited = true
    const v = r.value as { code?: number | null } | undefined
    run.exitCode = v?.code ?? null
    if (run.buf.trim()) run.lines.push(run.buf)
    run.buf = ''
    return
  }
  const { stream, text } = r.value
  if (stream === 'stderr') { run.stderr = (run.stderr + text).slice(-4000); return }
  run.buf += text
  const parts = run.buf.split('\n')
  run.buf = parts.pop() ?? ''
  for (const p of parts) if (p.trim()) run.lines.push(p)
}

async function nextEvent(run: Run): Promise<CodexEvent> {
  while (run.lines.length === 0) {
    if (run.exited) return { type: '__exit' }
    ingest(run, (await run.iter.next()) as Pull)
  }
  const line = run.lines.shift() as string
  try { return JSON.parse(line) as CodexEvent } catch { return { type: '__raw', text: line } }
}

function effortFlag(effort: TurnStepInput['effort']): string[] {
  if (typeof effort !== 'string') return []
  const level = effort === 'max' ? 'xhigh' : effort
  return ['-c', `model_reasoning_effort="${level}"`]
}

// How to start Codex: the configured command, else `codex` on PATH, else (on
// Windows, where the npm shim is a .cmd no shell-less spawn runs) its codex.js.
async function commandCandidate($: EngineInterface, configured: string, attempt: number): Promise<string[] | undefined> {
  if (resolvedCommand) return attempt === 0 ? resolvedCommand : undefined
  if (configured.trim()) return attempt === 0 ? configured.trim().split(/\s+/) : undefined
  if (attempt === 0) return ['codex']
  if (attempt > 1) return undefined
  const appData = await $.env.get('APPDATA')
  return appData ? ['node', `${appData}\\npm\\node_modules\\@openai\\codex\\bin\\codex.js`] : undefined
}

async function startRun($: EngineInterface, agentId: string, type: AgentType, prompt: string, effort: TurnStepInput['effort'], configured: string): Promise<Run> {
  const thread = threads.get(agentId)
  const args = [
    'exec', '--json', '--skip-git-repo-check',
    '-m', type.model, '-s', type.sandbox,
    '-c', 'approval_policy="never"',
    ...effortFlag(effort),
    ...(thread ? ['resume', thread, '-'] : ['-']),
  ]
  let lastError = ''
  for (let attempt = 0; ; attempt++) {
    const cmd = await commandCandidate($, configured, attempt)
    if (!cmd) break
    const iter = $.process.spawn({ argv: [...cmd, ...args], input: prompt })[Symbol.asyncIterator]()
    const run: Run = { iter, buf: '', lines: [], stderr: '', exited: false, exitCode: null, done: false, type }
    try {
      ingest(run, (await iter.next()) as Pull)
    } catch (err) {
      lastError = String(err)
      continue
    }
    resolvedCommand = cmd
    return run
  }
  throw new Error(`could not start Codex (${lastError}). Set the codexCommand option of codex-bridge.`)
}

function kill(run: Run | undefined) {
  if (!run || run.done) return
  run.done = true
  void run.iter.return?.(undefined)
}

function usageOf(u: unknown, model: string): TurnUsage | null {
  if (!u || typeof u !== 'object') return null
  const n = (k: string) => Number((u as Record<string, unknown>)[k] ?? 0) || 0
  const cached = n('cached_input_tokens')
  return {
    model,
    input_tokens: Math.max(0, n('input_tokens') - cached),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: n('cache_write_input_tokens'),
    output_tokens: n('output_tokens'),
  }
}

// One finished Codex action as the subagent's tool call: the tool, its input,
// and what Codex got back.
function asToolCall(item: CodexItem): { name: string; input: Record<string, unknown>; output: string } | undefined {
  const s = (k: string) => (typeof item[k] === 'string' ? (item[k] as string) : '')
  switch (item.type) {
    case 'command_execution': {
      const code = item.exit_code
      return {
        name: TOOLS.shell,
        input: { command: s('command'), exit_code: typeof code === 'number' ? code : null },
        output: cap(`${s('aggregated_output')}${typeof code === 'number' && code !== 0 ? `\n[exit code ${code}]` : ''}`) || '(no output)',
      }
    }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? (item.changes as { path?: string; kind?: string }[]) : []
      return {
        name: TOOLS.patch,
        input: { changes: changes.map(c => ({ path: c.path ?? '', kind: c.kind ?? '' })) },
        output: `${s('status') || 'applied'}: ${changes.map(c => `${c.kind ?? 'edit'} ${c.path ?? ''}`).join(', ')}`,
      }
    }
    case 'mcp_tool_call': {
      const result = item.error ?? item.result ?? ''
      return {
        name: TOOLS.tool,
        input: { server: s('server'), tool: s('tool'), arguments: item.arguments ?? {} },
        output: cap(typeof result === 'string' ? result : JSON.stringify(result)) || s('status') || 'done',
      }
    }
    case 'web_search':
      return { name: TOOLS.search, input: { query: s('query') }, output: s('query') ? `searched: ${s('query')}` : 'searched' }
    default:
      return undefined
  }
}

function thoughtOf(item: CodexItem): string | undefined {
  switch (item.type) {
    case 'reasoning': return typeof item.text === 'string' ? item.text : undefined
    case 'error': return `codex warning: ${String(item.message ?? '')}`
    case 'todo_list': {
      const items = Array.isArray(item.items) ? (item.items as { text?: string; completed?: boolean }[]) : []
      return `plan:\n${items.map(i => `${i.completed ? '[x]' : '[ ]'} ${i.text ?? ''}`).join('\n')}`
    }
    default: return `codex ${item.type}`
  }
}

export const register: Register = (on, options) => {
  const configured = typeof options.codexCommand === 'string' ? options.codexCommand : ''
  for (const t of parseModels(String(options.models ?? ''))) types.set(`codex-bridge:${t.name}`, t)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const toolSpec = (name: string, description: string, properties: Record<string, unknown>) =>
      $.tool.register({ name, description, inputSchema: { type: 'object', properties }, isDeferred: true })
    await toolSpec('shell', 'Record of a shell command a Codex subagent ran. Codex subagents only; not callable directly.', {
      command: { type: 'string' }, exit_code: { type: ['number', 'null'] },
    })
    await toolSpec('patch', 'Record of file edits a Codex subagent applied. Codex subagents only; not callable directly.', {
      changes: { type: 'array', items: { type: 'object' } },
    })
    await toolSpec('tool', 'Record of an MCP tool call a Codex subagent made. Codex subagents only; not callable directly.', {
      server: { type: 'string' }, tool: { type: 'string' }, arguments: {},
    })
    await toolSpec('search', 'Record of a web search a Codex subagent ran. Codex subagents only; not callable directly.', {
      query: { type: 'string' },
    })
    for (const t of types.values()) {
      await $.agent.register({
        name: t.name,
        description: describe(t),
        prompt: AGENT_PROMPT,
        tools: TOOL_NAMES,
        model: 'sonnet',
        omitClaudeMd: true,
      })
    }
    return started
  })

  // The replayed calls ran inside Codex already: allow them, answer them from the stash.
  on('tool.check', { tool: /^mcp__codex-bridge__(shell|patch|tool|search)$/ }, () => ({ decision: 'allow' as const }))
  on('tool.call', { tool: /^mcp__codex-bridge__(shell|patch|tool|search)$/ }, ($, e) => {
    const out = stash.get(e.tool_use_id)
    if (out === undefined) return { deny: 'codex-bridge: this tool records work a Codex subagent already did; it cannot be called directly.' }
    stash.delete(e.tool_use_id)
    return { result: out }
  })

  on('turn.step', async function* ($, e, next): AsyncGenerator<TurnStepChunk, TurnStepResult | void> {
    const agentId = e.agentId
    const type = agentId ? await codexTypeOf($, agentId) : null
    if (!agentId || !type) return yield* next(e)

    let block = 0
    const finish = function* (answer: string, stopReason: 'end_turn' | 'tool_use', usage: TurnUsage | null): Generator<TurnStepChunk, TurnStepResult> {
      if (answer) yield { kind: 'text', index: block++, text: answer }
      yield { kind: 'stop', stopReason, usage }
      return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason, usage }
    }

    let run = runs.get(agentId)
    try {
      if (!run || run.done) {
        const prompt = await pendingPrompt($, agentId)
        if (!prompt) return yield* finish('codex-bridge: no prompt to send to Codex.', 'end_turn', null)
        run = await startRun($, agentId, type, prompt, e.effort, configured)
        runs.set(agentId, run)
        activity.set(agentId, `codex ${type.label}: starting`)
        showStatus($)
      }
    } catch (err) {
      return yield* finish(`codex-bridge: ${String(err)}`, 'end_turn', null)
    }

    const current = run
    const onAbort = () => { kill(current); activity.delete(agentId); showStatus($) }
    next.signal.addEventListener('abort', onAbort)
    let text = ''
    try {
      for (;;) {
        const ev = await nextEvent(current)
        switch (ev.type) {
          case 'thread.started':
            if (typeof ev.thread_id === 'string') threads.set(agentId, ev.thread_id)
            break
          case 'item.started': {
            const item = ev.item as CodexItem
            if (item?.type === 'command_execution') {
              activity.set(agentId, `codex ${type.label}: ${oneLine(String(item.command ?? ''), 60)}`)
              showStatus($)
              yield { kind: 'thinking', index: block++, text: `running: ${oneLine(String(item.command ?? ''), 200)}` }
            }
            break
          }
          case 'item.completed': {
            const item = ev.item as CodexItem
            if (!item) break
            if (item.type === 'agent_message') {
              const t = typeof item.text === 'string' ? item.text : ''
              text = text ? `${text}\n\n${t}` : t
              break
            }
            const call = asToolCall(item)
            if (!call) {
              const thought = thoughtOf(item)
              if (thought) yield { kind: 'thinking', index: block++, text: thought }
              break
            }
            if (text) yield { kind: 'text', index: block++, text }
            const id = `toolu_codex_${Date.now().toString(36)}${(seq++).toString(36)}`
            stash.set(id, call.output)
            yield { kind: 'tool', index: block, id, name: call.name }
            yield { kind: 'input', index: block, json: JSON.stringify(call.input) }
            block++
            yield { kind: 'stop', stopReason: 'tool_use', usage: null }
            return { turnId: e.turnId, index: e.index, answer: text, toolUses: [{ name: call.name, input: call.input }], stopReason: 'tool_use', usage: null }
          }
          case 'turn.completed': {
            current.done = true
            activity.delete(agentId)
            showStatus($)
            return yield* finish(text || '(Codex finished without a message.)', 'end_turn', usageOf(ev.usage, type.model))
          }
          case 'turn.failed': {
            kill(current)
            activity.delete(agentId)
            showStatus($)
            const err = ev.error as { message?: string } | undefined
            return yield* finish(`${text ? `${text}\n\n` : ''}Codex failed: ${err?.message ?? 'unknown error'}`, 'end_turn', null)
          }
          case 'error':
            yield { kind: 'thinking', index: block++, text: `codex: ${String(ev.message ?? '')}` }
            break
          case '__raw':
            yield { kind: 'thinking', index: block++, text: String(ev.text ?? '') }
            break
          case '__exit': {
            current.done = true
            activity.delete(agentId)
            showStatus($)
            const tail = current.stderr.trim().split('\n').slice(-6).join('\n')
            return yield* finish(`${text ? `${text}\n\n` : ''}Codex exited (code ${current.exitCode}) before finishing.${tail ? `\n${tail}` : ''}`, 'end_turn', null)
          }
          default:
            break
        }
      }
    } finally {
      next.signal.removeEventListener('abort', onAbort)
    }
  })

  on('session.end', ($, e, next) => {
    for (const run of runs.values()) kill(run)
    return next(e)
  })
}
