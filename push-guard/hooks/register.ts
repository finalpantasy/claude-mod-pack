import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import { COMMIT_FORMAT, PATCH_FORMAT, denyText, findHits, githubRepo, needles, parseAdded, parseCommits, pushTargets } from './scan'
import type { PushTarget } from './scan'

// Claude Push Guard: before a git push Claude runs, read the commits about to leave and stop the push
// when they hold the person's own private words. Nothing about any one person is written here: the
// words come from the person's settings, the home folder and git identity from their machine.

const paused = atom({ plugin: 'push-guard', key: 'paused' } as const, false)

type Options = { words: string[]; protectGitIdentity: boolean; onlyPublic: boolean; emDashes: boolean }

async function run($: EngineInterface, argv: string[], cwd?: string) {
  try {
    const r = await $.process.run(argv, { ...(cwd ? { cwd } : {}), timeoutMs: 30_000 })
    return { ok: r.exitCode === 0, out: r.stdout ?? '', err: (r.stderr || r.stdout || '').trim().split('\n')[0] ?? '' }
  } catch (err) {
    return { ok: false, out: '', err: err instanceof Error ? err.message : String(err) }
  }
}

/** Why this push must not go ahead, or null when it may. */
async function check($: EngineInterface, target: PushTarget, o: Options): Promise<string | null> {
  const cwd = target.dir
  const git = (...args: string[]) => run($, ['git', ...args], cwd)

  const upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
  const remote = target.remote ?? (upstream.ok ? upstream.out.trim().split('/')[0] : undefined) ?? 'origin'

  if (o.onlyPublic) {
    const url = await git('remote', 'get-url', remote)
    const repo = url.ok ? githubRepo(url.out) : null
    if (repo) {
      const vis = await run($, ['gh', 'api', `repos/${repo}`, '--jq', '.private'])
      if (vis.ok && vis.out.trim() === 'true') return null
    }
  }

  const range = upstream.ok && !target.remote ? [`${upstream.out.trim()}..HEAD`] : ['HEAD', '--not', `--remotes=${remote}`]
  const log = await git('log', COMMIT_FORMAT, ...range)
  if (!log.ok) return `Push Guard could not read the commits this push would send (${log.err}), so it stopped the push. The person can run /push-guard off to push without the check.`
  const commits = parseCommits(log.out)
  if (commits.length === 0) return null
  const patch = await git('log', '-p', '--no-color', '--unified=0', PATCH_FORMAT, ...range)
  if (!patch.ok) return `Push Guard could not read the changes this push would send (${patch.err}), so it stopped the push. The person can run /push-guard off to push without the check.`

  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  let identity: { name?: string; email?: string } | undefined
  if (o.protectGitIdentity) {
    const name = (await git('config', '--global', 'user.name')).out.trim()
    const email = (await git('config', '--global', 'user.email')).out.trim()
    // Only when these commits are made under another identity: then the everyday one must not show up in them.
    const other = email !== '' && commits.every(c => c.email.toLowerCase() !== email.toLowerCase())
    if (other) identity = { name, email }
  }
  const hits = findHits(commits, parseAdded(patch.out), needles(o.words, home, identity), o.emDashes)
  return hits.length ? denyText(hits) : null
}

export const register: Register = (on, options) => {
  const o: Options = {
    words: String(options.words ?? '').split(',').map(w => w.trim()).filter(w => w.length >= 2),
    protectGitIdentity: options.protectGitIdentity !== false,
    onlyPublic: options.onlyPublic !== false,
    emDashes: options.emDashes === true,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'push-guard', description: 'Push Guard: what it checks; /push-guard off or on pauses it for this session' })
    return started
  })

  on('command.run', { command: 'push-guard' }, async ($, e) => {
    const arg = String((e as { args?: unknown }).args ?? '').trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      await update($, paused, () => arg === 'off')
      return { text: arg === 'off' ? 'Push Guard is off for this session. /push-guard on turns it back on.' : 'Push Guard is on.' }
    }
    const state = (await read($, paused)) ? 'off for this session' : 'on'
    const list = o.words.length ? `${o.words.length} word${o.words.length === 1 ? '' : 's'} from your settings` : 'no words of your own yet (add them in the plugin settings)'
    return {
      text: `Push Guard is ${state}. Before each git push it checks the new commits for ${list}, your home folder path${o.protectGitIdentity ? ', your everyday git name and email when the commits use another identity' : ''}${o.emDashes ? ', and em dashes' : ''}.${o.onlyPublic ? ' Private GitHub repos are skipped.' : ''}`,
    }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const targets = pushTargets(String((e as { command?: unknown }).command ?? ''))
    if (targets.length === 0 || (await read($, paused))) return next(e)
    for (const t of targets) {
      const why = await check($, t, o)
      if (why) {
        $.ui.toast('Push Guard stopped a push: private words in the commits.')
        return { deny: why }
      }
    }
    return next(e)
  })
}
