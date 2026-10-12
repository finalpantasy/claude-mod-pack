// The band's rows that the /mods panel can switch off.
/** The band's rows the /mods panel can switch off, in the order they draw. */
export const ROWS = [
  { key: 'week', label: 'Week: weekly limit and pace' },
  { key: 'usage', label: '5-hour: the 5-hour window' },
  { key: 'context', label: 'Context: fill and forecast (red from 75%)' },
  { key: 'spend', label: 'Spend: this chat, today, 7 days, all time' },
  { key: 'tokens', label: 'Tokens: this chat, today, 7 days, all time' },
  { key: 'turn', label: 'Last turn: what it did' },
  { key: 'tasks', label: 'Tasks: open work-state list' },
  { key: 'agents', label: 'Agents: the crabs (savvy-progress)' },
] as const
