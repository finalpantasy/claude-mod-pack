// Claude Mod Hider's type contract: the one switch other mods read.

/** True while mods above the prompt are hidden; any mod drawing there reads it and passes. */
export type Hidden = boolean

declare module 'claude-code' {
  interface PluginState {
    'claude-mod-hider': {
      hidden: Hidden
    }
  }
}
