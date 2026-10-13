// Claude Push Guard's type contract.
/** True while the person has paused the guard for this session with /push-guard off. */
export type Paused = boolean

declare module 'claude-code' {
  interface PluginState {
    'push-guard': {
      paused: Paused
    }
  }
}
