import { expect, mock, test } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 11 }, view: {} } } as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

test('hiding drops everything beneath and keeps the button; showing brings it back', async ($, on) => {
  mock.store(on, {})
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="other">other mod</Text>
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const texts = async () => {
      const ui = await $.ui.mount({ plugin: 'claude-mod-hider', surface, ...BAND })
      const all = JSON.stringify(await ui.findAll({ type: 'Text' })) + JSON.stringify(await ui.findAll({ type: 'Button' } as never))
      await ui.unmount()
      return all
    }
    expect(await texts()).toContain('other mod')
    await $.command.run({ ...RUN, command: 'hide-mods', args: '' })
    const hiddenView = await texts()
    expect(hiddenView).not.toContain('other mod')
    expect(hiddenView).toContain('▸ mods')
    await $.command.run({ ...RUN, command: 'hide-mods', args: '' })
    expect(await texts()).toContain('other mod')
  }
})
