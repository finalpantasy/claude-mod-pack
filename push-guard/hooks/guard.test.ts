import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { needles, pushTargets } from './scan'

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const FS = '\x1f'
const RS = '\x1e'

type Repo = {
  commits: { sha: string; author: string; email: string; message: string }[]
  patch: string
  global?: { name: string; email: string }
  url?: string
  isPrivate?: boolean
  home?: string
}

// A repo the guard reads through git and gh, all answered here; nothing runs for real.
function repo(on: On, r: Repo) {
  const ran: string[][] = []
  let pushed = 0
  on('env.get', ($, e) => ({ value: (e as { name: string }).name === 'USERPROFILE' ? (r.home ?? 'C:\\Users\\alex') : undefined }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('process.run', ($, e) => {
    const argv = [...(e as { argv: string[] }).argv]
    ran.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } }) as never
    const a = argv.join(' ')
    if (a.startsWith('git rev-parse')) return { value: { exitCode: 128, stdout: '', stderr: 'no upstream' } } as never
    if (a.startsWith('git remote get-url')) return ok(`${r.url ?? 'https://github.com/someone/project.git'}\n`)
    if (a.startsWith('gh api')) return ok(r.isPrivate ? 'true\n' : 'false\n')
    if (a.startsWith('git config --global user.name')) return ok(`${r.global?.name ?? ''}\n`)
    if (a.startsWith('git config --global user.email')) return ok(`${r.global?.email ?? ''}\n`)
    if (a.startsWith('git log -p')) return ok(r.patch)
    if (a.startsWith('git log')) return ok(r.commits.map(c => `${c.sha}${FS}${c.author}${FS}${c.email}${FS}${c.author}${FS}${c.email}${FS}${c.message}\n${RS}\n`).join(''))
    return { value: { exitCode: 1, stdout: '', stderr: `unexpected ${a}` } } as never
  })
  on('tool.call', () => (pushed++, { result: 'pushed', text: 'pushed' }) as never)
  return { ran, pushes: () => pushed }
}

// A stopped push answers the caller with its reason.
const denied = (res: unknown) => (res as { deny?: string }).deny

const patch = (file: string, line: number, ...added: string[]) =>
  `${RS}abc1234\ndiff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +${line},${added.length} @@\n${added.map(l => `+${l}`).join('\n')}\n`

const PSEUDONYM = { sha: 'abc1234def', author: 'pixelfox', email: '123+pixelfox@users.noreply.github.com', message: 'Add the login helper' }

test('a word from the settings in a new line stops the push and says where', { options: { words: 'Alex Rivera, rivera.alex@mail.test' } }, async ($, on) => {
  const r = repo(on, { commits: [PSEUDONYM], patch: patch('README.md', 12, '# Login', 'Made by Alex Rivera') })
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(denied(res)).toBeDefined()
  expect(String(denied(res))).toContain('README.md:13: "Alex Rivera"')
  expect(r.pushes()).toBe(0)
})

test('the home folder path is caught with no settings at all, in any spelling', async ($, on) => {
  const r = repo(on, { commits: [PSEUDONYM], patch: patch('config.json', 3, '{ "cache": "C:\\\\Users\\\\alex\\\\AppData" }') })
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(String(denied(res))).toContain('config.json:3: your home folder path')
  expect(r.pushes()).toBe(0)
})

test('pushing under another identity protects the everyday git name; the same identity does not block itself', async ($, on) => {
  const leak = { ...PSEUDONYM, message: 'Fix tests (Alex Rivera)' }
  const r = repo(on, { commits: [leak], patch: patch('a.ts', 1, 'export {}'), global: { name: 'Alex Rivera', email: 'alex@mail.test' } })
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(String(denied(res))).toContain('message: your git name "Alex Rivera"')
  expect(r.pushes()).toBe(0)
})

test('commits made under the everyday identity itself push normally', async ($, on) => {
  const own = { sha: 'abc1234def', author: 'Alex Rivera', email: 'alex@mail.test', message: 'Work' }
  const r = repo(on, { commits: [own], patch: patch('a.ts', 1, 'export {}'), global: { name: 'Alex Rivera', email: 'alex@mail.test' } })
  await $.session.start(START)
  const res = await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(denied(res)).toBeUndefined()
  expect(r.pushes()).toBe(1)
})

test('a private GitHub repo is skipped; /push-guard off lets a push through; other commands are untouched', { options: { words: 'Alex Rivera' } }, async ($, on) => {
  const leaky = { commits: [PSEUDONYM], patch: patch('README.md', 1, 'Alex Rivera') }
  const r = repo(on, { ...leaky, isPrivate: true })
  await $.session.start(START)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git push' } as never))).toBeUndefined()
  await $.tool.call({ tool: 'Bash', command: 'ls -la' } as never)
  expect(r.ran.some(a => a[0] === 'gh')).toBe(true)
  expect(r.pushes()).toBe(2)
})

test('/push-guard off and on', { options: { words: 'Alex Rivera', onlyPublic: false } }, async ($, on) => {
  const r = repo(on, { commits: [PSEUDONYM], patch: patch('README.md', 1, 'Alex Rivera') })
  await $.session.start(START)
  const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const
  expect((await $.command.run({ ...RUN, command: 'push-guard', args: '' } as never)).text).toContain('1 word from your settings')
  await $.command.run({ ...RUN, command: 'push-guard', args: 'off' } as never)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git push' } as never))).toBeUndefined()
  await $.command.run({ ...RUN, command: 'push-guard', args: 'on' } as never)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git push' } as never))).toBeDefined()
  expect(r.pushes()).toBe(1)
})

test('em dashes are blocked only when asked', { options: { emDashes: true } }, async ($, on) => {
  repo(on, { commits: [PSEUDONYM], patch: patch('notes.md', 4, 'Fast \u2014 and small') })
  await $.session.start(START)
  expect(String(denied(await $.tool.call({ tool: 'Bash', command: 'git push' } as never)))).toContain('notes.md:4: an em dash')
})

test('finds pushes behind cd, git options with quoted values, and gh repo create --push', () => {
  expect(pushTargets('cd /work/app && git -c credential.helper= -c "credential.helper=!f() { echo x; }; f" push -u origin main')).toEqual([{ kind: 'git', dir: '/work/app', remote: 'origin' }])
  expect(pushTargets('git -C site push')).toEqual([{ kind: 'git', dir: 'site' }])
  expect(pushTargets('gh repo create me/app --public --source=. --push')).toEqual([{ kind: 'gh', dir: '.' }])
  expect(pushTargets('echo push && git status && git pull')).toEqual([])
})

test('the home folder needle is built from whoever runs it', () => {
  expect(needles([], 'C:\\Users\\sam', undefined)).toEqual([{ label: 'your home folder path', text: 'users/sam' }])
  expect(needles([], '/home/kim', undefined)).toEqual([{ label: 'your home folder path', text: 'home/kim' }])
})
