// What Push Guard reads and looks for, as plain functions: no engine calls here.

export type Commit = { sha: string; author: string; email: string; committer: string; committerEmail: string; message: string }
export type Added = { sha: string; file: string; line: number; text: string }
export type Needle = { label: string; text: string }
export type Hit = { where: string; found: string }
export type PushTarget = { dir?: string; remote?: string; kind: 'git' | 'gh' }

const FS = '\x1f'
const RS = '\x1e'

/** `git log` format for parseCommits: one record per commit. */
export const COMMIT_FORMAT = `--format=%H${FS}%an${FS}%ae${FS}%cn${FS}%ce${FS}%B${RS}`
/** `git log -p` format for parseAdded: a marker line with the commit before each patch. */
export const PATCH_FORMAT = `--format=${RS}%H`

export function parseCommits(out: string): Commit[] {
  return out
    .split(RS)
    .map(r => r.replace(/^\s+/, ''))
    .filter(r => r.includes(FS))
    .map(r => {
      const [sha = '', author = '', email = '', committer = '', committerEmail = '', message = ''] = r.split(FS)
      return { sha, author, email, committer, committerEmail, message: message.trim() }
    })
}

/** The lines each commit adds, with the file and the line number they land on. */
export function parseAdded(out: string): Added[] {
  const added: Added[] = []
  let sha = ''
  let file = ''
  let line = 0
  for (const raw of out.split('\n')) {
    const l = raw.replace(/\r$/, '')
    if (l.startsWith(RS)) {
      sha = l.slice(1).trim()
      continue
    }
    if (l.startsWith('+++ ')) {
      file = l === '+++ /dev/null' ? '' : l.slice(4).replace(/^b\//, '')
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (l.startsWith('+') && file) {
      added.push({ sha, file, line, text: l.slice(1) })
      line++
    }
  }
  return added
}

/** Lowercased, with every backslash run turned into one forward slash, so any spelling of a path matches. */
const fold = (s: string) => s.toLowerCase().replace(/\\+/g, '/')

/** The needles for this person: their words, their home folder, and their everyday identity when asked. */
export function needles(words: readonly string[], home: string | undefined, identity: { name?: string; email?: string } | undefined): Needle[] {
  const out: Needle[] = []
  for (const w of words) if (w.trim().length >= 2) out.push({ label: `"${w.trim()}"`, text: fold(w.trim()) })
  // The last two parts of the home folder (Users/alex, home/alex) match it in any form: C:\Users\alex, /c/Users/alex, escaped JSON.
  const parts = (home ?? '').replace(/\\+/g, '/').split('/').filter(Boolean)
  if (parts.length >= 2) out.push({ label: 'your home folder path', text: fold(parts.slice(-2).join('/')) })
  if (identity?.name && identity.name.trim().length >= 3) out.push({ label: `your git name "${identity.name.trim()}"`, text: fold(identity.name.trim()) })
  if (identity?.email && identity.email.includes('@')) {
    const email = identity.email.trim()
    out.push({ label: `your git email "${email}"`, text: fold(email) })
    const local = email.split('@')[0] ?? ''
    if (local.length >= 4) out.push({ label: `your email name "${local}"`, text: fold(local) })
  }
  return out
}

const EM_DASH = '\u2014'

/** Every place a needle (or an em dash, when asked) shows up in what would be pushed. */
export function findHits(commits: readonly Commit[], added: readonly Added[], list: readonly Needle[], emDashes: boolean): Hit[] {
  const hits: Hit[] = []
  const seen = new Set<string>()
  const look = (where: string, text: string, withDash: boolean) => {
    const folded = fold(text)
    for (const n of list) {
      const key = `${where}|${n.label}`
      if (folded.includes(n.text) && !seen.has(key)) {
        seen.add(key)
        hits.push({ where, found: n.label })
      }
    }
    if (withDash && emDashes && text.includes(EM_DASH) && !seen.has(`${where}|dash`)) {
      seen.add(`${where}|dash`)
      hits.push({ where, found: 'an em dash' })
    }
  }
  for (const c of commits) {
    const id = c.sha.slice(0, 7)
    look(`commit ${id} author`, `${c.author} ${c.email}`, false)
    look(`commit ${id} committer`, `${c.committer} ${c.committerEmail}`, false)
    look(`commit ${id} message`, c.message, true)
  }
  const files = new Set<string>()
  for (const a of added) {
    if (!files.has(a.file)) {
      files.add(a.file)
      look(`file name ${a.file}`, a.file, false)
    }
    look(`${a.file}:${a.line}`, a.text, true)
  }
  return hits
}

/** A command split into words the way a shell would, with `;`, `&&`, `||` and `|` as their own words. */
export function words(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i]
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
      continue
    }
    if (/\s/.test(ch)) {
      if (has) out.push(cur)
      cur = ''
      has = false
      continue
    }
    if (ch === ';' || ch === '&' || ch === '|') {
      if (has) out.push(cur)
      let op = ch
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) op += command[++i]
      out.push(op)
      cur = ''
      has = false
      continue
    }
    cur += ch
    has = true
  }
  if (has) out.push(cur)
  return out
}

const SEPARATORS = new Set([';', '&&', '||', '|', '&'])
// git's own options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
// git push options that take the next word as their value.
const PUSH_VALUE_OPTIONS = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option', '--recurse-submodules'])

/** A folder as a shell wrote it, as the process runner needs it: Git Bash's /c/... becomes C:/... on Windows-style paths. */
export function nativeDir(dir: string): string {
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(dir)
  return m ? `${m[1]!.toUpperCase()}:${m[2] ?? '/'}` : dir
}

/** Every push in a command: git push, or gh repo create with --push; where it runs and to which remote. */
export function pushTargets(command: string): PushTarget[] {
  const all = words(command)
  const targets: PushTarget[] = []
  let dir: string | undefined
  let seg: string[] = []
  const flush = () => {
    const s = seg
    seg = []
    if (s.length === 0) return
    const prog = (s[0] ?? '').replace(/\\/g, '/').split('/').pop()?.replace(/\.exe$/i, '')
    if (prog === 'cd' && s[1]) {
      dir = s[1]
      return
    }
    if (prog === 'git') {
      let i = 1
      let at = dir
      while (i < s.length && s[i]!.startsWith('-')) {
        const opt = s[i]!
        if (opt === '-C') at = s[i + 1]
        if (GIT_VALUE_OPTIONS.has(opt)) i += 2
        else i++
      }
      if (s[i] !== 'push') return
      let remote: string | undefined
      for (let j = i + 1; j < s.length; j++) {
        const w = s[j]!
        if (PUSH_VALUE_OPTIONS.has(w)) {
          j++
          continue
        }
        if (w.startsWith('-')) continue
        remote = w
        break
      }
      targets.push({ kind: 'git', ...(at ? { dir: at } : {}), ...(remote ? { remote } : {}) })
      return
    }
    if (prog === 'gh' && s[1] === 'repo' && s[2] === 'create' && s.includes('--push')) {
      const source = s.find(w => w.startsWith('--source='))?.slice(9) ?? (s.includes('--source') ? s[s.indexOf('--source') + 1] : undefined)
      const at = source ?? dir
      targets.push({ kind: 'gh', ...(at ? { dir: at } : {}) })
    }
  }
  for (const w of all) {
    if (SEPARATORS.has(w)) flush()
    else seg.push(w)
  }
  flush()
  return targets
}

/** owner/repo for a GitHub remote URL, or null for any other host. */
export function githubRepo(url: string): string | null {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/** The message Claude reads when a push is stopped. */
export function denyText(hits: readonly Hit[]): string {
  const shown = hits.slice(0, 12).map(h => `- ${h.where}: ${h.found}`)
  if (hits.length > 12) shown.push(`- and ${hits.length - 12} more`)
  return [
    `Push Guard stopped this push: ${hits.length === 1 ? 'one place' : `${hits.length} places`} in the commits would publish something private.`,
    ...shown,
    'Remove it from the files and from the commit history (amend or rebase the commits, and fix author names with the repo\'s own git identity), then push again.',
    'If it is meant to be public, the person can run /push-guard off to push without the check for this session.',
  ].join('\n')
}
