# Claude Mod Hider

Part of [Claude Mod Pack](../README.md).

**One tiny button that hides every Claude Code mod above your prompt, and brings them all back.**

Running a few Claude Code mods (status bands, agent trackers, idle games) is great until you shrink the window and they push your prompt halfway up the screen. Claude Mod Hider puts a single arrow in the top-right corner of the band above the prompt, beside your mods, so it never adds a line. Click it and every mod there folds away; click again and they are back. It remembers your choice across sessions.

![Claude Mod Hider in Claude Code: the arrow (boxed) sits in the top-right corner of the mod band, adding no extra line](docs/shown.png)

Click the arrow and the whole band folds down to a single **▸ mods** button.

## Install

```
/plugin marketplace add finalpantasy/claude-mod-pack
/plugin install claude-mod-hider@claude-mod-pack
```

Restart Claude Code. Click the small **▾** in the top-right corner of the band above the prompt, or type `/hide-mods`. Click **▸ mods**, or type `/hide-mods` again, to bring them back.

## Works with every mod, best with ones that opt in

While hidden, Claude Mod Hider draws only its arrow and does not hand the band on, so every mod drawn beneath it disappears. Claude Code does not document the order mods draw in, so a mod drawn above it can still show. Mod authors can make their mod hide reliably with two lines:

```tsx
const modsHidden = atom({ plugin: 'claude-mod-hider', key: 'hidden' } as const, false)

on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
  if (e.props.hasSurvey || (await read($, modsHidden))) return next(e)
  // ...draw as usual
})
```

and in your mod's type contract, inside `interface PluginState`:

```ts
'claude-mod-hider': { hidden: boolean }
```

A survey always gets the band, hidden or not.

With [Claude Status Band](../README.md#claude-status-band-status-band) installed, the band draws the arrow in its own top-right corner, so it sits in the same place whichever order Claude Code draws the mods in.

## License

MIT
