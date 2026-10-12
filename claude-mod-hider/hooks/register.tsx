import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// One button above the prompt that hides or shows every mod drawn there, and stays itself.
// Hidden, this hook draws only the button and does not hand the band on, so mods beneath it never draw;
// mods above it in the chain read the same switch and pass. The choice is kept across sessions.

const hidden = atom({ plugin: 'claude-mod-hider', key: 'hidden' } as const, false)

async function toggle($: EngineInterface) {
  const next = !(await read($, hidden))
  await update($, hidden, () => next)
  await $.store.set('hidden', next)
  return next
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'hide-mods', description: 'Hide or show everything mods draw above the prompt' })
    const saved = await $.store.get('hidden').catch(() => undefined)
    if (typeof saved === 'boolean') await update($, hidden, () => saved)
    return started
  })

  on('command.run', { command: 'hide-mods' }, async $ => {
    const isHidden = await toggle($)
    return { text: isHidden ? 'Mods above the prompt hidden. /hide-mods or the button brings them back.' : 'Mods above the prompt shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A survey always gets the band.
    if (e.props.hasSurvey) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const Button = 'Button' in ui ? ui.Button : null
    const isHidden = await read($, hidden)
    const control = Button
      ? <Button key="hide-mods" label={isHidden ? '▸ mods' : '▾'} plain onPress={() => void toggle($)} />
      : <Text key="hide-mods" dimColor>{isHidden ? '▸ mods (/hide-mods)' : '▾'}</Text>
    if (isHidden) return <Box flexDirection="row">{control}</Box>
    // Shown, the arrow takes a narrow column beside the other mods, in the top-right corner, not a row of its own:
    // the band is no taller than the mods make it.
    const below = await next(e).catch(() => null)
    return (
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>{below}</Box>
        <Box flexShrink={0} marginLeft={1} alignSelf="flex-start">{control}</Box>
      </Box>
    )
  })
}
