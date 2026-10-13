/** The subscription windows and the session's spend, as last read. */
export type UsageSnap = {
  /** 0..100, or -1 with no reading (API key, before the first response). */
  fiveHour: number
  week: number
  /** ISO 8601, or '' unknown. */
  fiveResets: string
  weekResets: string
  usd: number
}

/** Spend and tokens over a span. */
export type DayTotal = { usd: number; tokens: number }

/** Weighted tokens by epoch hour (`Math.floor(ms / 3_600_000)`, as a string): when the limit was being used. */
export type Hours = Record<string, number>

/** One session's ledger file: spend and tokens by local day, the running totals last seen, and its activity by hour. */
export type Ledger = { days: Record<string, DayTotal>; usd: number; tokens: number; hours?: Hours }

/** The context window at the end of a turn. */
export type Reading = { tokens: number; window: number; percent: number }

export type FileChange = { path: string; added: number; removed: number }

/** What a turn did, counted from its tool calls. */
export type Turn = {
  startedAt: number
  durationMs: number | null
  files: FileChange[]
  commands: number
  failed: number
  reads: number
  agents: number
}

export type TaskItem = { task: string; status: string }

/** The to-do list touched last: claude-mem's work state, or the built-in TodoWrite. */
export type TaskList = { list: string; items: TaskItem[]; isClosed: boolean }

/** One installed mod as the /mods panel lists it. */
export type ModInfo = {
  id: string
  name: string
  description: string
  isOn: boolean
  /** A switch pressed this session: it applies from the next session. */
  pending: 'on' | 'off' | 'failed' | null
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    /** Claude Mod Hider's switch, read here so the band passes while mods are hidden. */
    'claude-mod-hider': { hidden: boolean }
    'status-band': {
      usage: UsageSnap | null
      readings: Reading[]
      turn: Turn | null
      lastTurn: Turn | null
      tasks: TaskList | null
      isHidden: boolean
      /** True when Claude Mod Hider is on: the band draws its arrow in its own corner, and Mod Hider draws none beside it. */
      hiderArrow: boolean
      /** Band rows switched off in /mods ('week', 'usage', 'context', 'spend', 'tokens', 'turn', 'tasks', 'agents'); kept across sessions. */
      rowsOff: string[]
      /** The /mods panel's list, read when it opens. */
      mods: ModInfo[] | null
      /** This session's own ledger. */
      ledger: Ledger
      /** Every other session's ledger, by file name, with the time it was read at. */
      others: Record<string, { mtimeMs: number; ledger: Ledger }>
      /** The Compact now button: idle, queued until the running turn ends, or compacting. */
      compact: 'idle' | 'queued' | 'running'
      /** The Handoff button: idle, queued until the session is idle, or the handoff turn running. */
      handoff: 'idle' | 'queued' | 'running'
      /** Activity mined from past transcripts, up to the epoch hour `until`; null until read or when there is none. */
      history: { until: number; hours: Hours } | null
    }
  }
}
