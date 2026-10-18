import { expect, mock, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { countChanges } from './diff'
import { folderId, idOf } from './ids'
import { deleteTargets, isReadOnlyCommand } from './commands'
import { foldIn, mergeShards, parseCatFileBatch, pruneTombstones, refFor } from './persist'
import type { Event } from './persist'

const CWD = '/repo'
const TMP = '/tmp/claude-pending-changes/s1'

/** The kit hands fs hooks native paths (`C:\repo\a.txt` on Windows): key the disk by the POSIX spelling. */
const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const GIT_DIR = '/repo/.git'
const SHARDS = `${GIT_DIR}/pending-changes`

/** A stand-in for git's SHA: deterministic, 40 hex digits, different for different texts. */
function fakeSha(text: string, salt = 'blob'): string {
  let out = ''
  for (let seed = 0; out.length < 40; seed++) {
    let h = 0x811c9dc5 ^ seed
    for (const ch of `${salt}\0${text}`) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0
    out += h.toString(16).padStart(8, '0')
  }
  return out.slice(0, 40)
}

const bytes = (text: string) => new TextEncoder().encode(text).length

/** git's object store and refs, in memory: what the persistence plumbing writes and reads. */
type GitStore = {
  objects: Map<string, string>
  trees: Map<string, string[]>
  refs: Map<string, string>
  /** The next n `update-ref` swaps lose, as if another session moved the ref first. */
  loseSwaps: number
  /** `update-ref` fails on a stale lock file. */
  lockError: boolean
  /** The next n `hash-object` calls fail. */
  failHash: number
  /** `cat-file --batch` output is cut at this many bytes, as process.run's cap would. */
  stdoutCap: number
  /** `cat-file --batch` fails for these SHAs. */
  failCat: Set<string>
}

/** Answers the git commands the mod runs, for a work tree at /repo whose HEAD is `head`. */
function gitAnswer(argv: string[], stdin: string, disk: Map<string, string>, head: Record<string, string>, store: GitStore) {
  const [cmd, ...args] = argv
  if (cmd !== 'git') return undefined
  const ok = (stdout: string, extra: { isStdoutTruncated?: boolean } = {}) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: extra.isStdoutTruncated ?? false })
  const fail = (stderr = '') => ({ exitCode: 128, stdout: '', stderr, isStdoutTruncated: false })
  if (args[0] === 'rev-parse') {
    if (args.includes('--path-format=absolute')) {
      return ok(`${TOPLEVEL.value}\n${GIT_DIR}\n${GIT_DIR}\nsha1\n${PREFIX.value}\n`)
    }
    if (args[1] === '-q' && args[2] === '--verify') {
      const sha = store.refs.get(args[3]!)
      return sha ? ok(`${sha}\n`) : fail()
    }
    return ok('/repo\n')
  }
  if (args[0] === 'status') {
    const inTree = (p: string) => p.startsWith('/repo/') && !p.startsWith(`${GIT_DIR}/`)
    const paths = new Set([...Object.keys(head), ...disk.keys()].filter(inTree))
    let out = ''
    for (const path of [...paths].sort()) {
      const rel = path.slice('/repo/'.length)
      if (!(path in head)) out += `?? ${rel}\0`
      else if (!disk.has(path)) out += ` D ${rel}\0`
      else if (disk.get(path) !== head[path]) out += ` M ${rel}\0`
    }
    return ok(out)
  }
  if (args[0] === 'cat-file' && args[1] === '--batch') {
    let out = ''
    let truncated = false
    for (const sha of stdin.split('\n').filter(Boolean)) {
      const text = store.failCat.has(sha) ? undefined : store.objects.get(sha)
      const record = text === undefined ? `${sha} missing\n` : `${sha} blob ${bytes(text)}\n${text}\n`
      if (bytes(out) + bytes(record) > store.stdoutCap) {
        out = `${out}${record}`.slice(0, store.stdoutCap)
        truncated = true
        break
      }
      out += record
    }
    return ok(out, { isStdoutTruncated: truncated })
  }
  if (args[0] === 'cat-file') {
    const path = `/repo/${args[2]!.slice('HEAD:'.length)}`
    return path in head ? ok(head[path]!) : fail()
  }
  if (args[0] === 'ls-files') {
    const dir = norm(args[2]!)
    return ok(Object.keys(head).filter(p => p.startsWith(`${dir}/`)).join('\n'))
  }
  if (args[0] === 'hash-object') {
    if (store.failHash > 0) {
      store.failHash--
      return fail('fatal: unable to write object')
    }
    const shas: string[] = []
    for (const path of stdin.split('\n').filter(Boolean)) {
      const text = disk.get(norm(path))
      if (text === undefined) return fail(`fatal: could not open '${path}'`)
      const sha = fakeSha(text)
      store.objects.set(sha, text)
      shas.push(sha)
    }
    return ok(`${shas.join('\n')}\n`)
  }
  if (args[0] === 'mktree') {
    const shas = stdin
      .split('\n')
      .filter(Boolean)
      .map(line => line.split('\t')[1]!)
    if (!args.includes('--missing') && shas.some(sha => !store.objects.has(sha))) return fail('fatal: entry is missing')
    const sha = fakeSha(shas.join(','), 'tree')
    store.trees.set(sha, shas)
    return ok(`${sha}\n`)
  }
  if (args[0] === 'ls-tree') {
    const shas = store.trees.get(args[1]!)
    return shas ? ok(shas.map(s => `100644 blob ${s}\t${s}\n`).join('')) : fail()
  }
  if (args[0] === 'update-ref') {
    if (args[1] === '-d') {
      store.refs.delete(args[2]!)
      return ok('')
    }
    const [ref, next, old] = args.slice(1) as [string, string, string]
    if (store.lockError) return fail(`fatal: Unable to create '${GIT_DIR}/${ref}.lock': File exists.`)
    const now = store.refs.get(ref) ?? '0'.repeat(40)
    if (store.loseSwaps > 0 || now !== old) {
      if (store.loseSwaps > 0) {
        store.loseSwaps--
        // Another session moved the ref meanwhile: keep its tree's SHAs, as a real peer's tree would.
        const theirs = fakeSha(`${now}+peer`, 'tree')
        store.trees.set(theirs, [...(store.trees.get(now) ?? [])])
        store.refs.set(ref, theirs)
      }
      return fail(`fatal: cannot lock ref '${ref}': is at ${now} but expected ${old}`)
    }
    store.refs.set(ref, next)
    return ok('')
  }
  if (args[0] === 'for-each-ref') {
    const prefix = args[2]!
    return ok([...store.refs.keys()].filter(r => r.startsWith(prefix)).map(r => `${r}\n`).join(''))
  }
  return ok('')
}

/** The cwd's prefix inside the work tree, as `rev-parse --show-prefix` prints it (`sub/` for a session in /repo/sub). */
const PREFIX = { value: '' }
/** What `rev-parse --show-toplevel` prints: /repo, or its resolved form for a symlinked cwd. */
const TOPLEVEL = { value: '/repo' }

type HostOptions = {
  /** Committed content by absolute path. */
  head?: Record<string, string>
  /** The folder isn't a git work tree (the default is one at /repo, with nothing committed unless `head` says). */
  outsideGit?: boolean
  /** What each Bash command does to the disk, by its exact text. */
  shell?: Record<string, (disk: Map<string, string>, put: (path: string, text: string) => void) => void | Promise<void>>
  /** A terminal too narrow to seat a pane the mod opens unasked. */
  narrow?: boolean
  /** The session's working directory (default /repo). */
  cwd?: string
  /** The session id `session.id` answers at first. */
  id?: string
  /** A git store to share, standing in for one repo across two hosts. */
  store?: GitStore
  /** The top level git reports, when the cwd reaches the repo through a link. */
  toplevel?: string
}

/** Whether the next host is outside git: set by `both` for its second run. */
let outsideByDefault = false

/** An in-memory host: files and folders with mtimes, `rm -rf`, `code --diff`, git, and Edit/Write applied to the files. */
function host(on: On, initial: Record<string, string> = {}, options: HostOptions = {}) {
  const outsideGit = options.outsideGit ?? (options.head === undefined && outsideByDefault)
  const head = outsideGit ? undefined : (options.head ?? {})
  const cwd = options.cwd ?? CWD
  PREFIX.value = cwd === '/repo' ? '' : `${cwd.slice('/repo/'.length)}/`
  TOPLEVEL.value = options.toplevel ?? '/repo'
  const disk = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const dirs = new Set<string>(['/repo'])
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'))
  const clock = mock.clock(on, { now: 1_000_000 })
  let tick = 0
  const stamp = () => clock.now() + ++tick / 1000
  const put = (path: string, text: string) => {
    disk.set(path, text)
    mtimes.set(path, stamp())
    for (let dir = parentOf(path); dir.length > 0; dir = parentOf(dir)) dirs.add(dir)
  }
  for (const [path, text] of Object.entries(initial)) put(path, text)
  if (head) put(`${GIT_DIR}/HEAD`, 'ref: refs/heads/main\n')
  const store: GitStore = options.store ?? {
    objects: new Map(),
    trees: new Map(),
    refs: new Map(),
    loseSwaps: 0,
    lockError: false,
    failHash: 0,
    stdoutCap: Infinity,
    failCat: new Set(),
  }
  const ran: string[][] = []
  const reads: string[] = []
  const failing = new Set<string>()
  const holds = new Map<string, { promise: Promise<void>; release: () => void }>()
  const session = { id: options.id ?? 's1' }
  let onToolRun: (() => void | Promise<void>) | undefined
  const tool = { outcome: 'ok' as 'ok' | 'deny' | 'error' }
  const fsFails = (path: string) => [...failing].some(prefix => norm(path).startsWith(prefix))
  /** Listings of the shard folder to let through, then to fail. */
  const listFails = { skip: 0, count: 0 }
  mock.env(on, { TMPDIR: '/tmp', PENDING_CHANGES_TEST: '1' })
  on('session.cwd', () => ({ value: cwd }))
  on('session.id', () => ({ value: session.id }))
  on('fs.exists', ($, e) => ({ value: disk.has(norm(e.path)) || dirs.has(norm(e.path)) }))
  on('fs.read', ($, e) => {
    if (fsFails(e.path)) throw new Error(`EACCES ${e.path}`)
    reads.push(norm(e.path))
    const text = disk.get(norm(e.path))
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    if (fsFails(e.path)) throw new Error(`EACCES ${e.path}`)
    put(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.stat', ($, e) => {
    const path = norm(e.path)
    const isFile = disk.has(path)
    return { value: { kind: isFile ? ('file' as const) : ('dir' as const), size: isFile ? disk.get(path)!.length : 0, mtimeMs: mtimes.get(path) ?? 0, isLink: false } }
  })
  on('fs.list', ($, e) => {
    if (fsFails(e.path)) throw new Error(`EACCES ${e.path}`)
    if (norm(e.path) === SHARDS && listFails.count > 0) {
      if (listFails.skip > 0) listFails.skip--
      else {
        listFails.count--
        throw new Error('EBUSY list')
      }
    }
    const dir = norm(e.path)
    const fileNames = [...disk.keys()].filter(p => parentOf(p) === dir)
    const dirNames = [...dirs].filter(p => parentOf(p) === dir && !disk.has(p))
    return {
      value: [
        ...fileNames.map(p => ({ name: p.slice(dir.length + 1), kind: 'file' as const, size: disk.get(p)!.length, mtimeMs: mtimes.get(p) ?? 0, isLink: false })),
        ...dirNames.map(p => ({ name: p.slice(dir.length + 1), kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
      ],
    }
  })
  on('process.run', async ($, e) => {
    ran.push([...e.argv])
    const held = e.argv[0] === 'git' ? holds.get(e.argv[1]!) : undefined
    if (held) await held.promise
    const git = head ? gitAnswer([...e.argv], e.init?.stdin ?? '', disk, head, store) : undefined
    if (git) return { value: { ...git, isStdoutTruncated: git.isStdoutTruncated ?? false, isStderrTruncated: false } }
    if (e.argv[0] === 'git') return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'rm') {
      const target = norm(e.argv[2]!)
      for (const k of [...disk.keys()]) if (k === target || k.startsWith(`${target}/`)) disk.delete(k)
      for (const k of [...dirs]) if (k === target || k.startsWith(`${target}/`)) dirs.delete(k)
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return options.narrow
      ? { value: { isPlaced: false as const, reason: 'below 144 columns' } }
      : { value: { isPlaced: true as const } }
  })
  on('command.register', () => ({ value: { isRegistered: true } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context ?? [] }))
  on('tool.call', async ($, e) => {
    if (tool.outcome === 'deny') return { deny: 'The user refused.' } as never
    await onToolRun?.()
    if (tool.outcome === 'error') return { result: {} as never, isError: true } as never
    if (e.tool === 'Bash') {
      await options.shell?.[e.command]?.(disk, put)
      return { result: {} as never }
    }
    if (e.tool === 'Edit') {
      const text = disk.get(e.file_path) ?? ''
      put(e.file_path, text.replace(e.old_string, e.new_string))
    } else if (e.tool === 'Write') {
      put(e.file_path, e.content)
    }
    return { result: {} as never }
  })
  return {
    disk,
    dirs,
    ran,
    clock,
    toasts,
    opened,
    reads,
    store,
    session,
    tool,
    put,
    mtimes,
    /** Lets `skip` listings of the shard folder through, then fails the next `count`. */
    failListing: (skip: number, count: number) => void Object.assign(listFails, { skip, count }),
    /** Makes reads, writes and lists under `prefix` throw. */
    failFs: (prefix: string) => void failing.add(prefix),
    /** Holds every `git <sub>` call until the returned function is called. */
    hold(sub: string) {
      let release!: () => void
      const promise = new Promise<void>(resolve => (release = resolve))
      holds.set(sub, { promise, release })
      return () => {
        holds.delete(sub)
        release()
      }
    },
    /** Runs `fn` while a tool call is under way, after the mod's before-step: another session acting meanwhile. */
    duringTool: (fn: (() => void | Promise<void>) | undefined) => void (onToolRun = fn),
  }
}

type Host = ReturnType<typeof host>

/** Runs a test twice: in a git work tree (persistence on) and outside git. Both must behave the same. */
function both(name: string, body: TestBody) {
  test(name, body)
  test(`${name} (outside git)`, ($, on) => {
    outsideByDefault = true
    try {
      return body($, on)
    } finally {
      outsideByDefault = false
    }
  })
}

function edit(file_path: string, old_string: string, new_string: string) {
  return { tool: 'Edit' as const, file_path, old_string, new_string }
}

function submit($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

async function mountPane($: Engine) {
  return $.ui.mount({
    plugin: 'pending-changes',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'pending-changes',
    props: {
      title: 'Changes',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  })
}

type Pane = Awaited<ReturnType<typeof mountPane>>

async function isEmpty(ui: Pane) {
  return (await ui.find({ type: 'Text', text: 'No pending changes.' })) !== undefined
}

async function pressText(ui: Pane, text: string | RegExp) {
  const button = await ui.find({ type: 'Button', text })
  expect(button?.key, `button ${String(text)}`).toBeDefined()
  await ui.press({ key: button!.key! })
}

test('the diff counts added and removed lines', () => {
  expect(countChanges('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, removed: 1 })
  expect(countChanges(null, 'x\ny')).toEqual({ added: 2, removed: 0 })
  expect(countChanges('same', 'same')).toEqual({ added: 0, removed: 0 })
})

both('an edit is listed with its counts, and rounds accumulate against the first original', async ($, on) => {
  host(on, { '/repo/a.txt': 'one\ntwo\n' })
  await $.tool.call(edit('/repo/a.txt', 'two', 'TWO'))
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '+1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '-1' })).toBeDefined()

  await $.tool.call(edit('/repo/a.txt', 'one', 'ONE'))
  expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '-2' })).toBeDefined()
  await ui.unmount()
})

both('editing back to the original drops the file', async ($, on) => {
  host(on, { '/repo/a.txt': 'one\n' })
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  await $.tool.call(edit('/repo/a.txt', 'uno', 'one'))
  const ui = await mountPane($)
  expect(await isEmpty(ui)).toBe(true)
  await ui.unmount()
})

both('files outside the working directory are ignored', async ($, on) => {
  host(on, { '/tmp/scratch.py': 'x\n' })
  await $.tool.call(edit('/tmp/scratch.py', 'x', 'y'))
  const ui = await mountPane($)
  expect(await isEmpty(ui)).toBe(true)
  await ui.unmount()
})

both('reject all restores originals, deletes created files and tells Claude', async ($, on) => {
  const { disk } = host(on, { '/repo/a.txt': 'one\n' })
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  await $.tool.call({ tool: 'Write', file_path: '/repo/new.txt', content: 'hi\n' })
  const ui = await mountPane($)

  await ui.press({ key: 'reject-all' })

  expect(disk.get('/repo/a.txt')).toBe('one\n')
  expect(disk.has('/repo/new.txt')).toBe(false)
  expect(await isEmpty(ui)).toBe(true)
  const sent = await submit($, 'next')
  const told = sent.context?.join('\n') ?? ''
  expect(told).toMatch(/rejected your changes to `a\.txt`/)
  expect(told).toMatch(/rejected your new file `new\.txt`/)
  await ui.unmount()
})

both('accept all keeps the changes, clears the list and tells Claude nothing', async ($, on) => {
  const { disk } = host(on, { '/repo/a.txt': 'one\n' })
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  const ui = await mountPane($)

  await ui.press({ key: 'accept-all' })

  expect(disk.get('/repo/a.txt')).toBe('uno\n')
  expect(await isEmpty(ui)).toBe(true)
  expect((await submit($, 'next')).context ?? []).toEqual([])
  await ui.unmount()
})

both('a review opens the original left and the source right; saves there update the counts', async ($, on) => {
  const { disk, ran, clock } = host(on, { '/repo/src/a.ts': 'one\ntwo\n' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call(edit('/repo/src/a.ts', 'one\ntwo', 'ONE\nTWO'))
  const ui = await mountPane($)

  await pressText(ui, /a.ts/)

  expect(ran.filter(argv => argv[0] === 'code').at(-1)).toEqual(['code', '--diff', `${TMP}/src/a.original.ts`, '/repo/src/a.ts'])
  expect(disk.get(`${TMP}/src/a.original.ts`)).toBe('one\ntwo\n')

  // The person reverts Claude's second block in VS Code and saves.
  disk.set('/repo/src/a.ts', 'ONE\ntwo\n')
  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: '+1' })).toBeDefined()
  expect((await submit($, 'next')).context?.join('\n')).toMatch(/modified `src\/a\.ts` after your last edit/)

  // Accepting what is left removes the temp copy.
  await ui.press({ key: `accept-dir-${folderId('src')}` })
  expect(disk.has(`${TMP}/src/a.original.ts`)).toBe(false)
  expect(await isEmpty(ui)).toBe(true)
  await ui.unmount()
})

both('reverting every block in the review drops the file and its temp copy', async ($, on) => {
  const { disk, clock } = host(on, { '/repo/a.txt': 'one\n' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  const ui = await mountPane($)
  await pressText(ui, /a\.txt/)

  disk.set('/repo/a.txt', 'one\n')
  await clock.advance(2000)

  expect(await isEmpty(ui)).toBe(true)
  expect(disk.has(`${TMP}/a.original.txt`)).toBe(false)
  await ui.unmount()
})

both('the next prompt tells Claude about a file the user edited after Claude, once', async ($, on) => {
  const { disk } = host(on, { '/repo/a.txt': 'one\n' })
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  disk.set('/repo/a.txt', 'uno, tweaked\n')

  const sent = await submit($, 'go on')
  expect(sent.context?.join('\n')).toMatch(/modified `a\.txt` after your last edit/)
  expect((await submit($, 'and again')).context ?? []).toEqual([])
})

both('files are grouped under folders, lone folder chains merged, with folder totals', async ($, on) => {
  host(on, { '/repo/test.json': '{}\n' })
  await $.tool.call(edit('/repo/test.json', '{}', '{ "a": 1 }'))
  await $.tool.call({ tool: 'Write', file_path: '/repo/testFolder/nested.json', content: 'a\nb\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/deep/er/x.txt', content: 'x\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/deep/er/y.txt', content: 'y\ny\n' })
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: '▾ deep/er/' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▾ testFolder/' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /└─ nested.json/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '+3' })).toBeDefined() // deep/er: x (1) + y (2)
  await ui.unmount()
})

both('rejecting a folder rejects every file under it and removes the folders Claude created', async ($, on) => {
  const { disk, dirs } = host(on, { '/repo/old/keep.txt': 'k\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/testFolder/sub/a.json', content: 'a\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/testFolder/b.json', content: 'b\n' })
  await $.tool.call(edit('/repo/old/keep.txt', 'k', 'K'))
  await $.tool.call({ tool: 'Write', file_path: '/repo/old/new.txt', content: 'n\n' })
  const ui = await mountPane($)

  await ui.press({ key: `reject-dir-${folderId('testFolder')}` })

  expect(disk.has('/repo/testFolder/sub/a.json')).toBe(false)
  expect(disk.has('/repo/testFolder/b.json')).toBe(false)
  expect(dirs.has('/repo/testFolder/sub')).toBe(false)
  expect(dirs.has('/repo/testFolder')).toBe(false)
  expect(await ui.find({ type: 'Text', text: '▾ testFolder/' })).toBeUndefined()

  // A folder that already existed stays, even when its new file is rejected.
  await ui.press({ key: `reject-dir-${folderId('old')}` })
  expect(disk.get('/repo/old/keep.txt')).toBe('k\n')
  expect(disk.has('/repo/old/new.txt')).toBe(false)
  expect(dirs.has('/repo/old')).toBe(true)
  expect(await isEmpty(ui)).toBe(true)
  await ui.unmount()
})

both('accepting a folder accepts only the files under it', async ($, on) => {
  const { disk } = host(on, { '/repo/a.txt': 'a\n' })
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/x.ts', content: 'x\n' })
  const ui = await mountPane($)

  await ui.press({ key: `accept-dir-${folderId('src')}` })

  expect(disk.get('/repo/src/x.ts')).toBe('x\n')
  expect(await ui.find({ type: 'Text', text: '▾ src/' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /a\.txt/ })).toBeDefined()
  await ui.unmount()
})

both('clicking a folder collapses and expands it, keeping its totals and buttons', async ($, on) => {
  host(on, {})
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/x.ts', content: 'x\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/y.ts', content: 'y\ny\n' })
  const ui = await mountPane($)
  const toggle = `toggle-dir-${folderId('src')}`

  await ui.press({ key: toggle })
  expect(await ui.find({ type: 'Text', text: '▸ src/' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /x\.ts/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '+3' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `accept-dir-${folderId('src')}` })).toBeDefined()

  await ui.press({ key: toggle })
  expect(await ui.find({ type: 'Text', text: '▾ src/' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /x\.ts/ })).toBeDefined()
  await ui.unmount()
})

both('rows draw tree guides: dim connectors before files and folders below the top level', async ($, on) => {
  host(on, {})
  await $.tool.call({ tool: 'Write', file_path: '/repo/testFolder/nested.json', content: 'n\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/testFolder/sub/deeper.json', content: 'd\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/testFolder/sub/notes.md', content: 'm\n' })
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: '├─ ' })).toBeDefined() // sub/, then nested.json
  expect(await ui.find({ type: 'Text', text: '│  ├─ ' })).toBeDefined() // deeper.json
  expect(await ui.find({ type: 'Text', text: '│  └─ ' })).toBeDefined() // notes.md
  expect(await ui.find({ type: 'Text', text: '└─ ' })).toBeDefined() // nested.json, last in testFolder
  await ui.unmount()
})

both('the refresh runs even when session.start never fired for this load', async ($, on) => {
  const { disk, clock } = host(on, { '/repo/a.txt': 'one\n' })
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  const ui = await mountPane($)

  disk.set('/repo/a.txt', 'uno\ndos\n')
  await clock.advance(2000)

  expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
  await ui.unmount()
})

both('emptying a new file in the diff rejects it: file and its new folders are deleted, Claude told', async ($, on) => {
  const { disk, dirs, clock } = host(on, {})
  await $.tool.call({ tool: 'Write', file_path: '/repo/newDir/sub/x.json', content: '{}\n' })
  const ui = await mountPane($)

  disk.set('/repo/newDir/sub/x.json', '') // every block reverted in VS Code, saved
  await clock.advance(2000)

  expect(disk.has('/repo/newDir/sub/x.json')).toBe(false)
  expect(dirs.has('/repo/newDir/sub')).toBe(false)
  expect(dirs.has('/repo/newDir')).toBe(false)
  expect(await isEmpty(ui)).toBe(true)
  expect((await submit($, 'next')).context?.join('\n')).toMatch(/rejected your new file `newDir\/sub\/x\.json`/)
  await ui.unmount()
})

both('a file Claude itself created empty is not rejected by the refresh', async ($, on) => {
  const { disk, clock } = host(on, {})
  await $.tool.call({ tool: 'Write', file_path: '/repo/pkg/__init__.py', content: '' })
  const ui = await mountPane($)

  await clock.advance(2000)

  expect(disk.has('/repo/pkg/__init__.py')).toBe(true)
  expect(await ui.find({ type: 'Button', text: /__init__\.py/ })).toBeDefined()
  await ui.unmount()
})

both('reverting every block of an existing file drops it and tells Claude', async ($, on) => {
  const { disk, clock } = host(on, { '/repo/a.txt': 'one\n' })
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  const ui = await mountPane($)

  disk.set('/repo/a.txt', 'one\n')
  await clock.advance(2000)

  expect(await isEmpty(ui)).toBe(true)
  expect((await submit($, 'next')).context?.join('\n')).toMatch(/reverted all your changes to `a\.txt`/)
  await ui.unmount()
})

const bash = (command: string) => ({ tool: 'Bash' as const, command })

test('read-only commands are told apart from ones that may write', () => {
  expect(isReadOnlyCommand('ls -la && git status')).toBe(true)
  expect(isReadOnlyCommand('cat a.txt | grep x')).toBe(true)
  expect(isReadOnlyCommand('echo hi > a.txt')).toBe(false)
  expect(isReadOnlyCommand('npm run build')).toBe(false)
  expect(isReadOnlyCommand("Remove-Item -LiteralPath 'a b.txt'")).toBe(false)
  expect(deleteTargets("rm -f a.txt && Remove-Item -LiteralPath 'my file.txt'; del /q c.txt")).toEqual([
    'a.txt',
    'my file.txt',
    'c.txt',
  ])
})

test('a committed file deleted by a shell command is listed as deleted; reject restores it', async ($, on) => {
  const head = { '/repo/test.json': '{\n  "a": 1\n}\n' }
  const { disk } = host(on, head, { head, shell: { 'rm test.json': d => void d.delete('/repo/test.json') } })

  await $.tool.call(bash('rm test.json'))
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: ' deleted' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '-3' })).toBeDefined()

  await ui.press({ key: 'reject-all' })
  expect(disk.get('/repo/test.json')).toBe('{\n  "a": 1\n}\n')
  expect((await submit($, 'next')).context?.join('\n')).toMatch(/rejected your deletion of `test\.json`/)
  await ui.unmount()
})

test('every file row shows a coloured status and a matching name style; folder rows show none', async ($, on) => {
  const head = { '/repo/a.txt': 'one\n', '/repo/old.txt': 'old\n' }
  host(on, head, { head, shell: { 'rm old.txt': d => void d.delete('/repo/old.txt') } })
  await $.tool.call({ tool: 'Write', file_path: '/repo/dir/new.txt', content: 'n\n' })
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  await $.tool.call(bash('rm old.txt'))
  const ui = await mountPane($)

  const rows = [
    { name: 'new.txt', status: 'added', color: 'success', style: { underline: true } },
    { name: 'a.txt', status: 'modified', color: 'warning', style: { italic: true } },
    { name: 'old.txt', status: 'deleted', color: 'error', style: { strikethrough: true, dimColor: true } },
  ]
  for (const { name, status, color, style } of rows) {
    const label = await ui.find({ type: 'Text', text: new RegExp(`^ ${status}$`) })
    expect(label?.props.color, status).toBe(color)
    const shown = await ui.find({ type: 'Text', text: new RegExp(`${name.replace('.', '\\.')}$`) })
    expect(shown?.props, name).toMatchObject(style)
  }
  expect(await ui.findAll({ type: 'Text', text: /^ (added|modified|deleted)$/ })).toHaveLength(3)

  const folder = await ui.find({ type: 'Button', key: `toggle-dir-${folderId('dir')}` })
  expect(folder?.text).toBe('▾ dir/')
  await ui.unmount()
})

test('any shell edit git sees is listed: a committed file rewritten, a new file in a new folder', async ($, on) => {
  const head = { '/repo/a.txt': 'one\ntwo\n' }
  const { disk, dirs } = host(on, head, {
    head,
    shell: {
      'npm run gen': (d, put) => {
        d.set('/repo/a.txt', 'one\nTWO\n')
        put('/repo/gen/out/x.ts', 'export {}\n')
      },
    },
  })

  await $.tool.call(bash('npm run gen'))
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /x\.ts/ })).toBeDefined()

  await ui.press({ key: `reject-dir-${folderId('gen/out')}` })
  expect(disk.has('/repo/gen/out/x.ts')).toBe(false)
  expect(dirs.has('/repo/gen')).toBe(false)
  await ui.unmount()
})

test("a file the user had already changed keeps the user's version as its original", async ($, on) => {
  const head = { '/repo/a.txt': 'one\n' }
  const { disk } = host(on, { '/repo/a.txt': 'one, mine\n' }, {
    head,
    shell: { 'fmt a.txt': d => void d.set('/repo/a.txt', 'ONE, MINE\n') },
  })

  await $.tool.call(bash('fmt a.txt'))
  const ui = await mountPane($)
  await ui.press({ key: 'reject-all' })

  expect(disk.get('/repo/a.txt')).toBe('one, mine\n')
  await ui.unmount()
})

test('a read-only command runs no git status', async ($, on) => {
  const head = { '/repo/a.txt': 'one\n' }
  const { ran } = host(on, head, { head, shell: {} })
  await $.tool.call(bash('ls -la && cat a.txt'))
  expect(ran.some(argv => argv[1] === 'status')).toBe(false)
})

test('outside git, a plain rm of a file is still caught', async ($, on) => {
  const { disk } = host(on, { '/repo/notes.txt': 'n\n' }, { shell: { 'rm notes.txt': d => void d.delete('/repo/notes.txt') } })
  await $.tool.call(bash('rm notes.txt'))
  const ui = await mountPane($)

  expect(await ui.find({ type: 'Text', text: ' deleted' })).toBeDefined()
  await ui.press({ key: 'reject-all' })
  expect(disk.get('/repo/notes.txt')).toBe('n\n')
  await ui.unmount()
})

test("resolving a deleted file's review removes its empty stand-in along with the original copy", async ($, on) => {
  const head = { '/repo/test.json': '{}\n' }
  const { disk, ran } = host(on, head, { head, shell: { 'rm test.json': d => void d.delete('/repo/test.json') } })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call(bash('rm test.json'))
  const ui = await mountPane($)

  await pressText(ui, /test\.json/)
  expect(ran.filter(argv => argv[0] === 'code').at(-1)).toEqual(['code', '--diff', `${TMP}/test.original.json`, `${TMP}/test.deleted.json`])
  expect(disk.get(`${TMP}/test.deleted.json`)).toBe('')

  await ui.press({ key: 'reject-all' })
  expect(disk.get('/repo/test.json')).toBe('{}\n')
  expect(disk.has(`${TMP}/test.original.json`)).toBe(false)
  expect(disk.has(`${TMP}/test.deleted.json`)).toBe(false)
  await ui.unmount()
})

test('a shell command that puts a listed file back at its original removes its review copy', async ($, on) => {
  const head = { '/repo/a.txt': 'one\n' }
  const { disk } = host(on, head, { head, shell: { 'git checkout a.txt': d => void d.set('/repo/a.txt', 'one\n') } })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  const ui = await mountPane($)
  await pressText(ui, /a\.txt/)
  expect(disk.has(`${TMP}/a.original.txt`)).toBe(true)

  await $.tool.call(bash('git checkout a.txt'))

  expect(await isEmpty(ui)).toBe(true)
  expect(disk.has(`${TMP}/a.original.txt`)).toBe(false)
  await ui.unmount()
})

both('on a terminal too narrow to seat the pane, a toast says how to open it', async ($, on) => {
  const { toasts } = host(on, { '/repo/a.txt': 'one\n' }, { narrow: true })
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  expect(toasts).toEqual(['Claude changed files. Run /changes to review them.'])

  // Later changes in the same batch don't repeat it.
  await $.tool.call({ tool: 'Write', file_path: '/repo/b.txt', content: 'b\n' })
  expect(toasts.length).toBe(1)

  // A session starting with files still listed says how many.
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(toasts.at(-1)).toBe('2 files still pending review. Run /changes to see them.')
})

both('no toast when the pane is seated', async ($, on) => {
  const { toasts } = host(on, { '/repo/a.txt': 'one\n' })
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  expect(toasts).toEqual([])
})

test("Claude's own deletion is not reported back to it as the user's", async ($, on) => {
  const head = { '/repo/test.json': '{}\n' }
  host(on, head, { head, shell: { 'rm test.json': d => void d.delete('/repo/test.json') } })
  await $.tool.call(bash('rm test.json'))
  expect((await submit($, 'next')).context ?? []).toEqual([])
})

// ---------------------------------------------------------------- across sessions
//
// One engine is one session. Another session is simulated through what it would
// leave behind: its shard and heartbeat in the git dir, and its blobs in the store.

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

/** Lets background work (flushes, reconcile) run to the end. */
async function idle(h: Host) {
  for (let i = 0; i < 8; i++) await h.clock.settle()
}

/** Stores a text as a blob, as `hash-object -w` would. */
function blob(h: Host, text: string): string {
  const sha = fakeSha(text)
  h.store.objects.set(sha, text)
  return sha
}

type PeerFile = {
  original: string | null
  /** What that session's Claude last saw (default: the file on disk now). */
  seen?: string | null
  at?: number
  owner?: string
  gone?: 'accepted' | 'rejected' | 'reverted' | 'settled'
  rejectKind?: 'change' | 'new' | 'deletion'
  branch?: string
  epoch?: number
}

/** Writes another session's shard into the git dir, with a new mtime, as its process would. */
function peerShard(
  h: Host,
  id: string,
  entries: Record<string, PeerFile>,
  opts: { endedAt?: number; seq?: number; instance?: string; slot?: 'a' | 'b' } = {},
) {
  const out: Record<string, unknown> = {}
  for (const [rel, f] of Object.entries(entries)) {
    const seen = f.seen !== undefined ? f.seen : (h.disk.get(`/repo/${rel}`) ?? null)
    out[rel] = {
      at: f.at ?? h.clock.now(),
      by: id,
      owner: f.owner ?? id,
      rel,
      branch: f.branch ?? 'ref: refs/heads/main',
      ...(f.epoch !== undefined ? { epoch: f.epoch } : {}),
      ...(f.gone
        ? { gone: true, goneReason: f.gone, ...(f.rejectKind ? { rejectKind: f.rejectKind } : {}) }
        : {
            original: f.original === null ? null : blob(h, f.original),
            seen: seen === null ? null : blob(h, seen),
            added: 1,
            removed: 1,
          }),
    }
  }
  const seq = opts.seq ?? 1
  const shard = {
    v: 1,
    seq,
    session: id,
    instance: opts.instance ?? `${id}-proc`,
    ...(opts.endedAt !== undefined ? { endedAt: opts.endedAt, endReason: 'prompt_input_exit' } : {}),
    entries: out,
  }
  h.put(`${SHARDS}/${id}.${opts.slot ?? (seq % 2 === 1 ? 'a' : 'b')}.json`, JSON.stringify(shard))
}

/** Writes another session's heartbeat now. */
function peerAlive(h: Host, id: string, busy = false) {
  h.put(`${SHARDS}/${id}.alive`, JSON.stringify({ busy }))
}

/** An ended peer: its end marker is newer than anything it wrote. */
const ENDED = (h: Host) => ({ endedAt: h.clock.now() + 1 })

type OwnShard = {
  seq: number
  endedAt?: number
  instance: string
  entries: Record<string, { gone?: boolean; owner: string; original?: string | null; seen?: string | null; goneReason?: string }>
}

/** A session's shard as written last (the slot with the higher seq). */
function ownShard(h: Host, id = 's1'): OwnShard | undefined {
  const slots = ['a', 'b']
    .map(s => h.disk.get(`${SHARDS}/${id}.${s}.json`))
    .filter((t): t is string => t !== undefined)
    .map(t => JSON.parse(t) as OwnShard)
  return slots.sort((x, y) => y.seq - x.seq)[0]
}

const treeShas = (h: Host) => h.store.trees.get(h.store.refs.get('refs/pending-changes/main') ?? '') ?? []

/** `/clear`: the conversation ends and the process goes on under a new id. */
async function clear($: Engine, h: Host, next: string) {
  await $.session.end({ reason: 'clear', sessionId: h.session.id, resume: {} } as never)
  h.session.id = next
}

test('an edit is listed in a later session with the same counts, and ✗ there restores the original from git', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'one\ntwo\n' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'two', 'TWO'))
  await idle(h)
  expect(ownShard(h)?.entries['a.txt']?.original).toBe(fakeSha('one\ntwo\n'))
  expect(treeShas(h)).toContain(fakeSha('one\ntwo\n'))

  await clear($, h, 's2')
  await submit($, 'next')
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '+1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '-1' })).toBeDefined()
  await ui.press({ key: 'reject-all' })
  expect(h.disk.get('/repo/a.txt')).toBe('one\ntwo\n')
  await ui.unmount()
})

test('a new session lists what an earlier one left, its original read from git', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'one, edited\n' })
  peerShard(h, 'old', { 'a.txt': { original: 'one\n' } }, ENDED(h))
  await start($)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ })).toBeDefined()
  await ui.press({ key: 'reject-all' })
  expect(h.disk.get('/repo/a.txt')).toBe('one\n')
  await ui.unmount()
})

test('on resume, a file back at its original drops off and its original leaves the tree', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'one\n' })
  peerShard(h, 'old', { 'a.txt': { original: 'one\n', seen: 'uno\n' } }, ENDED(h))
  h.store.refs.set('refs/pending-changes/main', fakeSha('t0', 'tree'))
  h.store.trees.set(fakeSha('t0', 'tree'), [fakeSha('one\n'), fakeSha('uno\n')])
  await start($)
  await idle(h)
  const ui = await mountPane($)
  expect(await isEmpty(ui)).toBe(true)
  expect(treeShas(h)).not.toContain(fakeSha('one\n'))
  await ui.unmount()
})

test('originals are pinned by a tree ref with compare-and-swap; lost swaps retry and keep every SHA', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n', '/repo/b.txt': 'b\n' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  const updates = h.ran.filter(argv => argv[1] === 'update-ref' && argv[2] !== '-d')
  expect(updates.length).toBeGreaterThan(0)
  // The first swap creates the ref from the zero id; every one names the value it replaces.
  expect(updates[0]!.at(-1)).toBe('0'.repeat(40))
  for (const argv of updates) expect(argv).toHaveLength(5)
  expect(h.ran.some(argv => argv[1] === 'hash-object' && argv.includes('-w'))).toBe(true)

  h.store.loseSwaps = 2
  await $.tool.call(edit('/repo/b.txt', 'b', 'B'))
  await idle(h)
  expect(treeShas(h)).toEqual(expect.arrayContaining([fakeSha('a\n'), fakeSha('b\n')]))

  // Three losses in a row: the update waits for the next tick and nothing is dropped.
  h.store.loseSwaps = 3
  await $.tool.call({ tool: 'Write', file_path: '/repo/c.txt', content: 'c\n' })
  await idle(h)
  await h.clock.advance(2000)
  await idle(h)
  expect(treeShas(h)).toEqual(expect.arrayContaining([fakeSha('a\n'), fakeSha('b\n')]))
})

test('accepting or rejecting releases an original, unless another entry shares it', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'same\n', '/repo/b.txt': 'same\n', '/repo/c.txt': 'c\n' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'same', 'A'))
  await $.tool.call(edit('/repo/b.txt', 'same', 'B'))
  await $.tool.call(edit('/repo/c.txt', 'c', 'C'))
  await idle(h)
  const ui = await mountPane($)
  const [first] = await ui.findAll({ type: 'Button', text: '✓' })
  await ui.press({ key: first!.key! })
  await idle(h)
  expect(treeShas(h)).toContain(fakeSha('same\n')) // b.txt still uses it
  await ui.press({ key: 'reject-all' })
  await idle(h)
  expect(treeShas(h)).not.toContain(fakeSha('same\n'))
  expect(treeShas(h)).not.toContain(fakeSha('c\n'))
  await ui.unmount()
})

test("another session's new shard shows after one tick, and an unchanged shard isn't read again", async ($, on) => {
  const h = host(on, { '/repo/x.txt': 'x, edited\n' })
  await start($)
  const ui = await mountPane($)
  peerShard(h, 'peer', { 'x.txt': { original: 'x\n' } })
  peerAlive(h, 'peer')
  await h.clock.advance(2000)
  await idle(h)
  expect(await ui.find({ type: 'Button', text: /x\.txt/ })).toBeDefined()
  const reads = () => h.reads.filter(p => p === `${SHARDS}/peer.a.json`).length
  const before = reads()
  peerAlive(h, 'peer')
  await h.clock.advance(2000)
  await idle(h)
  expect(reads()).toBe(before)
  await ui.unmount()
})

test('a session in a subfolder lists only its entries, counts the rest, and Reject all leaves them', async ($, on) => {
  const h = host(on, { '/repo/sub/a.txt': 'a, edited\n', '/repo/b.txt': 'b, edited\n' }, { cwd: '/repo/sub' })
  peerShard(h, 'old', { 'sub/a.txt': { original: 'a\n' }, 'b.txt': { original: 'b\n' } }, ENDED(h))
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /b\.txt/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '1 more pending outside this folder' })).toBeDefined()
  await ui.press({ key: 'reject-all' })
  expect(h.disk.get('/repo/sub/a.txt')).toBe('a\n')
  expect(h.disk.get('/repo/b.txt')).toBe('b, edited\n')
  await ui.unmount()
})

test('/clear marks the old id ended, and later changes are owned by the new id', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n', '/repo/b.txt': 'b\n' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  await clear($, h, 's2')
  await $.tool.call(edit('/repo/b.txt', 'b', 'B'))
  await idle(h)
  // s1 ended: its shard is folded into s2's, keeping s1 as the owner of what it changed.
  expect(ownShard(h, 's1')).toBeUndefined()
  expect(ownShard(h, 's2')?.entries['a.txt']?.owner).toBe('s1')
  expect(ownShard(h, 's2')?.entries['b.txt']?.owner).toBe('s2')
})

test('the first tool result of a resumed session carries the resume note, once', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a, edited\n', '/repo/z.txt': 'z\n' })
  peerShard(h, 'old', { 'a.txt': { original: 'a\n' } }, ENDED(h))
  await start($)
  const first = await $.tool.call(edit('/repo/z.txt', 'z', 'Z'))
  expect(first.context?.join('\n')).toMatch(/unreviewed changes from an earlier session: `a\.txt`/)
  const second = await $.tool.call(edit('/repo/z.txt', 'Z', 'zz'))
  expect(second.context?.join('\n') ?? '').not.toMatch(/earlier session/)
})

test("a Claude edit of a live session's file moves the owner and keeps that session's original", async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a, theirs\n' })
  peerShard(h, 'peer', { 'a.txt': { original: 'a\n' } })
  peerAlive(h, 'peer')
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'theirs', 'mine'))
  await idle(h)
  expect(ownShard(h)?.entries['a.txt']?.owner).toBe('s1')
  expect(ownShard(h)?.entries['a.txt']?.original).toBe(fakeSha('a\n'))
})

test('this Claude hears of the handover when another session takes over its file', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'mine'))
  await idle(h)
  h.disk.set('/repo/a.txt', 'theirs\n')
  peerShard(h, 'peer', { 'a.txt': { original: 'a\n', at: h.clock.now() + 10 } })
  peerAlive(h, 'peer')
  await h.clock.advance(2000)
  await idle(h)
  const told = (await submit($, 'next')).context?.join('\n') ?? ''
  expect(told).toMatch(/`a\.txt` was since edited by another Claude session/)
  expect(told).not.toMatch(/The user modified/)
})

test("rejecting a live session's file leaves the note to that session; an ended one's tells this Claude", async ($, on) => {
  const h = host(on, { '/repo/live.txt': 'l, theirs\n', '/repo/gone.txt': 'g, theirs\n' })
  peerShard(h, 'peer', { 'live.txt': { original: 'l\n' } })
  peerAlive(h, 'peer')
  peerShard(h, 'old', { 'gone.txt': { original: 'g\n' } }, ENDED(h))
  await start($)
  await submit($, 'take the resume note')
  const ui = await mountPane($)
  await ui.press({ key: 'reject-all' })
  await idle(h)
  const told = (await submit($, 'next')).context?.join('\n') ?? ''
  expect(told).toMatch(/rejected your changes to `gone\.txt`/)
  expect(told).not.toMatch(/live\.txt/)
  // The live owner learns from the resolve record, which names the kind.
  expect(ownShard(h)?.entries['live.txt']).toMatchObject({ gone: true, goneReason: 'rejected' })
  await ui.unmount()
})

test("this Claude hears of a reject made in another session", async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  h.disk.set('/repo/a.txt', 'a\n')
  peerShard(h, 'peer', { 'a.txt': { original: null, gone: 'rejected', rejectKind: 'change', owner: 's1', at: h.clock.now() + 10 } })
  peerAlive(h, 'peer')
  await h.clock.advance(2000)
  await idle(h)
  expect((await submit($, 'next')).context?.join('\n')).toMatch(/rejected your changes to `a\.txt`/)
})

test("rows from another live session or an ended one carry an origin tag; this session's rows don't", async ($, on) => {
  const h = host(on, { '/repo/live.txt': 'l, theirs\n', '/repo/gone.txt': 'g, theirs\n', '/repo/mine.txt': 'm\n' })
  peerShard(h, 'peer', { 'live.txt': { original: 'l\n' } })
  peerAlive(h, 'peer')
  peerShard(h, 'old', { 'gone.txt': { original: 'g\n' } }, ENDED(h))
  await start($)
  await $.tool.call(edit('/repo/mine.txt', 'm', 'M'))
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /live\.txt modified other session/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /gone\.txt modified earlier/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^mine\.txt modified$/ })).toBeDefined()
  await ui.unmount()
})

test('with persistence off nothing is written to the git dir or refs, and a new id starts empty', { options: { persistAcrossSessions: false } }, async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  peerShard(h, 'old', { 'a.txt': { original: 'z\n' } }, ENDED(h))
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  await h.clock.advance(4000)
  expect(h.ran.some(argv => ['hash-object', 'update-ref', 'mktree'].includes(argv[1]!))).toBe(false)
  expect([...h.disk.keys()].filter(p => p.startsWith(SHARDS) && !p.includes('/old.'))).toEqual([])
})

test('openOnStart toast shows the toast at start and leaves the pane closed', { options: { openOnStart: 'toast' } }, async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a, edited\n' })
  peerShard(h, 'old', { 'a.txt': { original: 'a\n' } }, ENDED(h))
  await start($)
  expect(h.toasts).toEqual(['1 file still pending review. Run /changes to see them.'])
  expect(h.opened).toEqual([])
})

test('openOnStart auto opens the pane at start; /clear and entries from other sessions open nothing', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a, edited\n', '/repo/p.txt': 'p, edited\n' })
  peerShard(h, 'old', { 'a.txt': { original: 'a\n' } }, ENDED(h))
  await start($)
  expect(h.opened).toEqual(['pending-changes'])
  peerShard(h, 'peer', { 'p.txt': { original: 'p\n' } })
  peerAlive(h, 'peer')
  await h.clock.advance(2000)
  await idle(h)
  await clear($, h, 's2')
  await submit($, 'next')
  expect(h.opened).toEqual(['pending-changes'])
  expect(h.toasts).toEqual([])
})

test('outside git nothing is persisted', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' }, { outsideGit: true })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  expect([...h.disk.keys()].some(p => p.startsWith(GIT_DIR))).toBe(false)
})

test('a cut-off cat-file batch continues to the end; a blob too large to come back is left out', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a2\n', '/repo/b.txt': 'b2\n', '/repo/big.txt': 'big2\n' })
  peerShard(h, 'old', { 'a.txt': { original: 'a\n' }, 'b.txt': { original: 'b\n' }, 'big.txt': { original: 'x'.repeat(200) } }, ENDED(h))
  h.store.stdoutCap = 120
  await start($)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /b\.txt/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /big\.txt/ })).toBeUndefined()
  await ui.press({ key: 'reject-all' })
  expect(h.disk.get('/repo/big.txt')).toBe('big2\n')
  await ui.unmount()
})

test('session start deletes the ref of a worktree whose git dir is gone, and keeps the others', async ($, on) => {
  const h = host(on, {})
  h.store.refs.set('refs/pending-changes/worktrees/gone', 'x')
  h.store.refs.set('refs/pending-changes/worktrees/my%20wt', 'y')
  h.put(`${GIT_DIR}/worktrees/my wt/HEAD`, 'ref: refs/heads/wt\n')
  await start($)
  await idle(h)
  expect(h.store.refs.has('refs/pending-changes/worktrees/gone')).toBe(false)
  expect(h.store.refs.has('refs/pending-changes/worktrees/my%20wt')).toBe(true)
})

test("the tool call doesn't wait for persistence's git calls", async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  await start($)
  const release = h.hold('hash-object')
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  expect(ownShard(h)?.entries['a.txt']).toBeUndefined()
  release()
  await idle(h)
  expect(ownShard(h)?.entries['a.txt']?.original).toBe(fakeSha('a\n'))
})

const heartbeat = (h: Host, id = 's1') => JSON.parse(h.disk.get(`${SHARDS}/${id}.alive`) ?? 'null') as { busy: boolean; detached?: boolean } | null

test('the merge keeps the first original, takes the rest from the latest record, and stops at a resolve', () => {
  const ev = (at: number, by: string, original: string, extra = {}) => ({ at, by, owner: by, rel: 'a', branch: '', original, seen: 'x', ...extra })
  const shard = (session: string, entries: Record<string, unknown>) => ({ v: 1 as const, seq: 1, session, instance: session, entries }) as never
  const { live } = mergeShards([shard('A', { a: ev(1, 'A', 'first') }), shard('B', { a: ev(5, 'B', 'later') })])
  expect(live.get('a')).toMatchObject({ original: 'first', owner: 'B', firstAt: 1 })
  const resolved = mergeShards([shard('A', { a: ev(1, 'A', 'first') }), shard('B', { a: { at: 3, by: 'B', owner: 'A', rel: 'a', branch: '', gone: true } })])
  expect(resolved.live.has('a')).toBe(false)
  expect(resolved.gone.get('a')).toMatchObject({ by: 'B' })
  const after = mergeShards([shard('A', { a: ev(1, 'A', 'stale') }), shard('B', { a: ev(6, 'B', 'fresh', { epoch: 3 }) })])
  expect(after.live.get('a')).toMatchObject({ original: 'fresh' })
})

test('folding keeps a resolve that still shadows an older record, and a collision keeps the folding owner', () => {
  const into = { v: 1 as const, seq: 1, session: 'C', instance: 'C', entries: { x: { at: 9, by: 'C', owner: 'C', rel: 'x', branch: '', original: 'o2', seen: 's' } } }
  const ended = { v: 1 as const, seq: 1, session: 'B', instance: 'B', entries: { x: { at: 4, by: 'B', owner: 'B', rel: 'x', branch: '', original: 'o1', seen: 's' }, y: { at: 5, by: 'B', owner: 'A', rel: 'y', branch: '', gone: true as const } } }
  const other = { v: 1 as const, seq: 1, session: 'A', instance: 'A', entries: { y: { at: 2, by: 'A', owner: 'A', rel: 'y', branch: '', original: 'oy', seen: 's' } } }
  expect(foldIn(into, ended, [other])).toBe(true)
  expect(into.entries.x).toMatchObject({ owner: 'C', original: 'o1' })
  expect(into.entries).toHaveProperty('y.gone', true)
  expect(mergeShards([into, other]).live.has('y')).toBe(false)
})

test('a tombstone no other shard needs is kept for a day before it goes', () => {
  const own = { v: 1 as const, seq: 1, session: 'B', instance: 'B', entries: { x: { at: 5, by: 'B', owner: 'A', rel: 'x', branch: '', gone: true as const } } as Record<string, Event> }
  expect(pruneTombstones(own, [], 1000)).toBe(true)
  expect(own.entries).toHaveProperty('x')
  pruneTombstones(own, [], 1000 + 23 * 3600_000)
  expect(own.entries).toHaveProperty('x')
  pruneTombstones(own, [], 1000 + 25 * 3600_000)
  expect(own.entries).not.toHaveProperty('x')
})

test('worktree names become valid refs, and cat-file output is parsed to its last whole record', () => {
  expect(refFor('/r/.git', '/r/.git')).toBe('refs/pending-changes/main')
  expect(refFor('/r/.git/worktrees/my wt~1', '/r/.git')).toBe('refs/pending-changes/worktrees/my%20wt%7E1')
  const out = 'aa blob 3\nhé\nbb missing\ncc blob 10\npartial'
  const parsed = parseCatFileBatch(out)
  expect([...parsed.blobs]).toEqual([['aa', 'hé']])
  expect(parsed.missing).toEqual(['bb'])
  expect(parsed.read).toBe(2)
})

test("an earlier session's record of a file arriving during this session's edit keeps its original", async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'theirs\n' })
  await start($)
  h.duringTool(() => {
    peerShard(h, 'peer', { 'a.txt': { original: 'orig\n', seen: 'theirs\n', at: h.clock.now() - 500 } })
    peerAlive(h, 'peer')
  })
  await $.tool.call(edit('/repo/a.txt', 'theirs', 'mine'))
  h.duringTool(undefined)
  await h.clock.advance(2000)
  await idle(h)
  const ui = await mountPane($)
  await ui.press({ key: 'reject-all' })
  expect(h.disk.get('/repo/a.txt')).toBe('orig\n')
  await ui.unmount()
})

test('a file accepted in one session stays resolved after that session ends and is folded in', async ($, on) => {
  const h = host(on, { '/repo/x.txt': 'x, accepted\n' })
  const t = h.clock.now()
  peerShard(h, 'A', { 'x.txt': { original: 'x\n', at: t - 2000 } }, { endedAt: t + 1 })
  peerShard(h, 'B', { 'x.txt': { original: null, gone: 'accepted', owner: 'A', at: t - 1000 } }, { endedAt: t + 1 })
  await start($)
  await idle(h)
  expect(h.disk.has(`${SHARDS}/B.a.json`)).toBe(false) // folded in
  const ui = await mountPane($)
  expect(await isEmpty(ui)).toBe(true)
  await ui.unmount()
  // A later session still sees it resolved.
  expect(mergeShards([ownShard(h) as never]).live.has('x.txt')).toBe(false)
})

test("while another session's Claude is mid-write, the refresh neither rejects, drops nor reports", async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n', '/repo/n.txt': '' })
  peerShard(h, 'peer', { 'n.txt': { original: null, seen: 'new\n' } })
  peerAlive(h, 'peer', true)
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  h.disk.set('/repo/a.txt', 'a\n') // the user reverts it meanwhile
  await h.clock.advance(2000)
  await idle(h)
  expect(h.disk.has('/repo/n.txt')).toBe(true)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ })).toBeDefined()
  peerAlive(h, 'peer', false)
  await h.clock.advance(2000)
  await idle(h)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ })).toBeDefined() // one tick of grace
  await h.clock.advance(2000)
  await idle(h)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ })).toBeUndefined()
  expect((await submit($, 'next')).context?.join('\n')).toMatch(/reverted all your changes to `a\.txt`/)
  await ui.unmount()
})

test('a session resumed after /exit is live again: its end marker is cleared and others treat it as live', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a, theirs\n', '/repo/b.txt': 'b\n' })
  const t = h.clock.now()
  peerShard(h, 'peer', { 'a.txt': { original: 'a\n' } }, { endedAt: t - 5000 })
  peerAlive(h, 'peer') // resumed: a heartbeat newer than its marker
  h.put(`${SHARDS}/s1.a.json`, JSON.stringify({ v: 1, seq: 1, session: 's1', instance: 'before', endedAt: t - 5000, entries: {} }))
  await start($)
  await $.tool.call(edit('/repo/b.txt', 'b', 'B'))
  await idle(h)
  expect(ownShard(h)?.endedAt).toBeUndefined()
  expect(h.disk.has(`${SHARDS}/peer.a.json`)).toBe(true) // not folded
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /a\.txt modified other session/ })).toBeDefined()
  await ui.unmount()
})

test('a silent session is folded in only after a day; a missing own shard is written again', async ($, on) => {
  const h = host(on, { '/repo/q.txt': 'q2\n', '/repo/d.txt': 'd2\n', '/repo/b.txt': 'b\n' })
  peerShard(h, 'quiet', { 'q.txt': { original: 'q\n' } })
  h.mtimes.set(`${SHARDS}/quiet.a.json`, h.clock.now() - 31_000)
  peerShard(h, 'dead', { 'd.txt': { original: 'd\n' } })
  h.mtimes.set(`${SHARDS}/dead.a.json`, h.clock.now() - 25 * 3600_000)
  await start($)
  await idle(h)
  expect(h.disk.has(`${SHARDS}/quiet.a.json`)).toBe(true)
  expect(h.disk.has(`${SHARDS}/dead.a.json`)).toBe(false)
  await $.tool.call(edit('/repo/b.txt', 'b', 'B'))
  await idle(h)
  for (const slot of ['a', 'b']) h.disk.delete(`${SHARDS}/s1.${slot}.json`)
  await h.clock.advance(2000)
  await idle(h)
  expect(ownShard(h)?.entries['b.txt']).toBeDefined()
})

test('if the shard folder fails, the refresh still updates counts and detects reverts', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n', '/repo/b.txt': 'b\n' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await $.tool.call(edit('/repo/b.txt', 'b', 'B'))
  h.failFs(SHARDS)
  const ui = await mountPane($)
  h.disk.set('/repo/a.txt', 'A\nmore\n')
  h.disk.set('/repo/b.txt', 'b\n')
  await h.clock.advance(2000)
  await idle(h)
  expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /b\.txt/ })).toBeUndefined()
  expect((await submit($, 'next')).context?.join('\n')).toMatch(/reverted all your changes to `b\.txt`/)
  await ui.unmount()
})

test('after /clear, an edit made while the list is loading takes the persisted original', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'one\n' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  await idle(h)
  await clear($, h, 's2')
  const release = h.hold('cat-file')
  const call = $.tool.call(edit('/repo/a.txt', 'uno', 'eins'))
  await idle(h)
  release()
  await call
  await idle(h)
  const ui = await mountPane($)
  await ui.press({ key: 'reject-all' })
  expect(h.disk.get('/repo/a.txt')).toBe('one\n')
  await ui.unmount()
})

test('session.end with git still busy leaves a whole shard holding the end marker', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n', '/repo/b.txt': 'b\n' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  const release = h.hold('hash-object')
  await $.tool.call(edit('/repo/b.txt', 'b', 'B'))
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: {} } as never)
  await idle(h)
  expect(ownShard(h)?.endedAt).toBeDefined()
  expect(ownShard(h)?.entries['a.txt']).toBeDefined()
  release()
  await ending
  await idle(h)
  expect(ownShard(h)?.endedAt).toBeDefined()
  expect(h.disk.has(TMP)).toBe(false)
})

test('a half-written shard keeps its last good content and is read again at the next tick', async ($, on) => {
  const h = host(on, { '/repo/x.txt': 'x2\n' })
  peerShard(h, 'peer', { 'x.txt': { original: 'x\n' } })
  peerAlive(h, 'peer')
  await start($)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /x\.txt/ })).toBeDefined()
  h.put(`${SHARDS}/peer.a.json`, '{"v":1,"seq":3,"ent')
  peerAlive(h, 'peer')
  await h.clock.advance(2000)
  await idle(h)
  expect(await ui.find({ type: 'Button', text: /x\.txt/ })).toBeDefined()
  peerShard(h, 'peer', { 'x.txt': { original: null, gone: 'accepted', at: h.clock.now() + 5 } }, { seq: 3 })
  await h.clock.advance(2000)
  await idle(h)
  expect(await ui.find({ type: 'Button', text: /x\.txt/ })).toBeUndefined()
  await ui.unmount()
})

test("a hand edit to an ended session's file is reported to a Claude that was told about it, once", async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a2\n' })
  peerShard(h, 'old', { 'a.txt': { original: 'a\n' } }, ENDED(h))
  await start($)
  await submit($, 'resume note')
  h.disk.set('/repo/a.txt', 'a3\n')
  expect((await submit($, 'next')).context?.join('\n')).toMatch(/`a\.txt`, changed in an earlier session, was modified by the user/)
  expect((await submit($, 'again')).context ?? []).toEqual([])
})

test("a hand edit to a file this Claude was never told about isn't reported", async ($, on) => {
  const h = host(on, { '/repo/p.txt': 'p2\n' })
  await start($)
  peerShard(h, 'peer', { 'p.txt': { original: 'p\n' } }, ENDED(h))
  await h.clock.advance(2000)
  await idle(h)
  h.disk.set('/repo/p.txt', 'p3\n')
  expect((await submit($, 'next')).context?.join('\n') ?? '').not.toMatch(/p\.txt/)
})

test('with persistence off, accepting a file writes nothing to the git dir', { options: { persistAcrossSessions: false } }, async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  const ui = await mountPane($)
  await ui.press({ key: 'accept-all' })
  await ui.unmount()
  expect([...h.disk.keys()].some(p => p.startsWith(SHARDS))).toBe(false)
})

test("a writing tool that is denied, fails or changes nothing leaves the heartbeat not busy", async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  await start($)
  h.tool.outcome = 'deny'
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  expect(heartbeat(h)?.busy).toBe(false)
  h.tool.outcome = 'error'
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  expect(heartbeat(h)?.busy).toBe(false)
  h.tool.outcome = 'ok'
  await $.tool.call(bash('npm test'))
  await idle(h)
  expect(heartbeat(h)?.busy).toBe(false)
})

test('the heartbeat says busy from the start of a writing tool until its change is written', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  await start($)
  let during: boolean | undefined
  h.duringTool(() => void (during = heartbeat(h)?.busy))
  const release = h.hold('hash-object')
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  expect(during).toBe(true)
  expect(heartbeat(h)?.busy).toBe(true)
  release()
  await idle(h)
  expect(heartbeat(h)?.busy).toBe(false)
})

test('failed writes keep the session live and receiving; after five it says it is detached', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  await start($)
  h.store.failHash = 100
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  for (let i = 0; i < 40; i++) await h.clock.advance(2000)
  await idle(h)
  expect(heartbeat(h)?.detached).toBe(true)
  const beatAt = h.mtimes.get(`${SHARDS}/s1.alive`)!
  expect(h.clock.now() - beatAt).toBeLessThan(2500)
  h.disk.set('/repo/a.txt', 'a\n')
  peerShard(h, 'peer', { 'a.txt': { original: null, gone: 'rejected', rejectKind: 'change', owner: 's1', at: h.clock.now() + 5 } })
  peerAlive(h, 'peer')
  await h.clock.advance(2000)
  await idle(h)
  expect((await submit($, 'next')).context?.join('\n')).toMatch(/rejected your changes to `a\.txt`/)
})

test("a file another session recorded during this session's shell command stays that session's", async ($, on) => {
  const h = host(on, {}, { shell: { 'npm run fmt': (d, put) => put('/repo/x.ts', 'peer wrote\n') } })
  await start($)
  h.duringTool(() => {
    h.put('/repo/x.ts', 'peer wrote\n')
    peerShard(h, 'peer', { 'x.ts': { original: null, seen: 'peer wrote\n' } })
    peerAlive(h, 'peer')
  })
  await $.tool.call(bash('npm run fmt'))
  h.duringTool(undefined)
  await idle(h)
  expect(ownShard(h)?.entries['x.ts']).toBeUndefined()
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /x\.ts added other session/ })).toBeDefined()
  await ui.unmount()
})

test('a file accepted elsewhere during a shell command that then changes it takes the accepted content as original', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' }, { shell: { 'fmt a.txt': d => void d.set('/repo/a.txt', 'A, formatted\n') } })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  h.duringTool(() => {
    peerShard(h, 'peer', { 'a.txt': { original: null, gone: 'accepted', owner: 's1' } })
    peerAlive(h, 'peer')
  })
  await $.tool.call(bash('fmt a.txt'))
  h.duringTool(undefined)
  const ui = await mountPane($)
  await ui.press({ key: 'reject-all' })
  expect(h.disk.get('/repo/a.txt')).toBe('A\n')
  await ui.unmount()
})

test("a note about this session's file names it relative to this session's cwd", async ($, on) => {
  const h = host(on, { '/repo/sub/a.ts': 'a\n' })
  await start($)
  await $.tool.call(edit('/repo/sub/a.ts', 'a', 'A'))
  await idle(h)
  h.disk.set('/repo/sub/a.ts', 'a\n')
  peerShard(h, 'peer', { 'sub/a.ts': { original: null, gone: 'rejected', rejectKind: 'change', owner: 's1', at: h.clock.now() + 5 } })
  peerAlive(h, 'peer')
  await h.clock.advance(2000)
  await idle(h)
  expect((await submit($, 'next')).context?.join('\n')).toMatch(/rejected your changes to `sub\/a\.ts`/)
})

test("a half-written heartbeat doesn't change whether a session is live or busy", async ($, on) => {
  const h = host(on, { '/repo/x.txt': 'x2\n' })
  peerShard(h, 'peer', { 'x.txt': { original: 'x\n' } })
  peerAlive(h, 'peer', true)
  await start($)
  h.put(`${SHARDS}/peer.alive`, '{"bu')
  await h.clock.advance(2000)
  await idle(h)
  h.disk.set('/repo/x.txt', 'x\n')
  await h.clock.advance(2000)
  await idle(h)
  const ui = await mountPane($)
  // Still busy as last read, so the refresh doesn't drop the peer's file.
  expect(await ui.find({ type: 'Button', text: /x\.txt modified other session/ })).toBeDefined()
  await ui.unmount()
})

test("another session's entry whose original can't be read isn't listed, and Reject all leaves it", async ($, on) => {
  const h = host(on, { '/repo/x.txt': 'x2\n' })
  peerShard(h, 'old', { 'x.txt': { original: 'x\n' } }, ENDED(h))
  h.store.failCat.add(fakeSha('x\n'))
  await start($)
  const ui = await mountPane($)
  expect(await isEmpty(ui)).toBe(true)
  expect(h.disk.get('/repo/x.txt')).toBe('x2\n')
  await ui.unmount()
})

test('a second window on the same session id runs session-only, and takes over once the first stops', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  h.put(`${SHARDS}/s1.a.json`, JSON.stringify({ v: 1, seq: 4, session: 's1', instance: 'first-window', entries: {} }))
  h.put(`${SHARDS}/s1.alive`, JSON.stringify({ busy: false }))
  await start($)
  expect(h.toasts).toContain("This session is open in another window too; pending changes here aren't shared.")
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  expect(ownShard(h)?.instance).toBe('first-window')
  // The first window closed without a word: once its heartbeat is stale, this one takes over.
  for (let i = 0; i < 17; i++) await h.clock.advance(2000)
  await idle(h)
  await submit($, 'next')
  await idle(h)
  expect(ownShard(h)?.instance).not.toBe('first-window')
})

test('a session resumed in a new process after a clean exit is not taken for a second window', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  h.put(`${SHARDS}/s1.alive`, JSON.stringify({ busy: false }))
  h.put(`${SHARDS}/s1.a.json`, JSON.stringify({ v: 1, seq: 4, session: 's1', instance: 'before-exit', endedAt: h.clock.now() + 1, entries: {} }))
  await start($)
  expect(h.toasts).toEqual([])
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  expect(ownShard(h)?.entries['a.txt']).toBeDefined()
})

test('a failing hash-object still lets accepts and rejects reach the shard', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a, theirs\n', '/repo/b.txt': 'b\n' })
  peerShard(h, 'peer', { 'a.txt': { original: 'a\n' } })
  peerAlive(h, 'peer')
  await start($)
  h.store.failHash = 100
  await $.tool.call(edit('/repo/b.txt', 'b', 'B'))
  await idle(h)
  const ui = await mountPane($)
  await ui.press({ key: `accept-${idOf('/repo/a.txt')}` })
  await idle(h)
  expect(await ui.find({ type: 'Button', text: /b\.txt/ })).toBeDefined()
  await ui.unmount()
  expect(ownShard(h)?.entries['a.txt']).toMatchObject({ gone: true })
  // b.txt waits for its SHA and lands once hashing works again.
  expect(ownShard(h)?.entries['b.txt']).toBeUndefined()
  h.store.failHash = 0
  for (let i = 0; i < 40; i++) await h.clock.advance(2000)
  await idle(h)
  expect(ownShard(h)?.entries['b.txt']?.original).toBe(fakeSha('b\n'))
})

test('a reject for a live owner that ends without reading it is told to the Claude where it was clicked, once', async ($, on) => {
  const h = host(on, { '/repo/live.txt': 'l, theirs\n' })
  peerShard(h, 'peer', { 'live.txt': { original: 'l\n', at: h.clock.now() - 100 } })
  peerAlive(h, 'peer')
  await start($)
  await submit($, 'x')
  const ui = await mountPane($)
  await ui.press({ key: 'reject-all' })
  await idle(h)
  await ui.unmount()
  expect((await submit($, 'y')).context ?? []).toEqual([])
  // The peer exits without ever reading the resolve: its shard still holds its live record.
  peerShard(h, 'peer', { 'live.txt': { original: 'l\n', at: h.clock.now() - 100 } }, { endedAt: h.clock.now() + 1, seq: 2 })
  await h.clock.advance(2000)
  await idle(h)
  expect((await submit($, 'next')).context?.join('\n') ?? '').toMatch(/rejected your changes to `live\.txt`/)
  await h.clock.advance(2000)
  await idle(h)
  expect((await submit($, 'again')).context ?? []).toEqual([])
})

test('a multibyte file over the blob cap stays listed, session-only', async ($, on) => {
  const big = '€'.repeat(1_500_000) + '\n'
  const h = host(on, { '/repo/a.txt': 'a\n', '/repo/b.txt': 'b\n' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a\n', big))
  await $.tool.call(edit('/repo/b.txt', 'b', 'B'))
  await idle(h)
  await h.clock.advance(2000)
  await idle(h)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ })).toBeDefined()
  await ui.unmount()
  expect(ownShard(h)?.entries['a.txt']).toBeUndefined()
  expect(ownShard(h)?.entries['b.txt']).toBeDefined()
})

test("a shard that never parses still ages, and is deleted once a day old without blocking releases meanwhile", async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  h.put(`${SHARDS}/torn.a.json`, '{"v":1,"se')
  h.mtimes.set(`${SHARDS}/torn.a.json`, h.clock.now() - 25 * 3600_000)
  await start($)
  await idle(h)
  expect(h.disk.has(`${SHARDS}/torn.a.json`)).toBe(false)
})

test("entries of a shard that vanishes mid-fold stay listed until a resolve or another shard covers them", async ($, on) => {
  const h = host(on, { '/repo/x.txt': 'x2\n' })
  peerShard(h, 'peer', { 'x.txt': { original: 'x\n' } })
  peerAlive(h, 'peer')
  await start($)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /x\.txt/ })).toBeDefined()
  // A folding session deleted the peer's files and hasn't written its own shard yet.
  for (const name of ['peer.a.json', 'peer.alive']) h.disk.delete(`${SHARDS}/${name}`)
  await h.clock.advance(2000)
  await idle(h)
  expect(await ui.find({ type: 'Button', text: /x\.txt/ })).toBeDefined()
  // Its copy lands: still listed, now from the folding shard.
  peerShard(h, 'folder', { 'x.txt': { original: 'x\n', owner: 'peer' } })
  peerAlive(h, 'folder')
  await h.clock.advance(2000)
  await idle(h)
  expect(await ui.find({ type: 'Button', text: /x\.txt/ })).toBeDefined()
  await ui.unmount()
})

test('a cwd reached through a link records its paths from git\'s prefix, not the resolved top level', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' }, { toplevel: '/private/repo' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  expect(Object.keys(ownShard(h)?.entries ?? {})).toEqual(['a.txt'])
})

test('a blob deleted by gc behind the tree does not stop new originals from being pinned', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  const lost = fakeSha('collected long ago')
  h.store.trees.set('t-old', [lost])
  h.store.refs.set('refs/pending-changes/main', 't-old')
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  expect(treeShas(h)).toContain(fakeSha('a\n'))
})

test('✓ on an entry another session changed after the pane drew it leaves it and says so', async ($, on) => {
  const h = host(on, { '/repo/x.txt': 'x2\n' })
  peerShard(h, 'peer', { 'x.txt': { original: 'x\n' } })
  peerAlive(h, 'peer')
  await start($)
  const ui = await mountPane($)
  h.disk.set('/repo/x.txt', 'x3\nmore\n')
  peerShard(h, 'peer', { 'x.txt': { original: 'x\n', at: h.clock.now() + 50 } }, { seq: 2 })
  await ui.press({ key: 'accept-all' })
  expect(h.toasts.at(-1)).toBe('`x.txt` changed in another session; check it again.')
  expect(await ui.find({ type: 'Button', text: /x\.txt/ })).toBeDefined()
  await ui.unmount()
})

test("a review copy of a project file under blobs/ survives persistence's staging", async ($, on) => {
  const h = host(on, { '/repo/blobs/a.txt': 'a\n', '/repo/b.txt': 'b\n' })
  await start($)
  await $.tool.call(edit('/repo/blobs/a.txt', 'a', 'A'))
  const ui = await mountPane($)
  await pressText(ui, /a\.txt/)
  await $.tool.call(edit('/repo/b.txt', 'b', 'B'))
  await idle(h)
  expect(h.disk.get(`${TMP}/blobs/a.original.txt`)).toBe('a\n')
  await ui.unmount()
})

test('a stale ref lock backs off instead of retrying every tick, and an old lock is removed', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  const lockFile = `${GIT_DIR}/refs/pending-changes/main.lock`
  h.put(lockFile, '')
  h.mtimes.set(lockFile, h.clock.now() - 10 * 60_000)
  await start($)
  await idle(h)
  expect(h.disk.has(lockFile)).toBe(false)
  h.store.lockError = true
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  const swaps = () => h.ran.filter(argv => argv[1] === 'update-ref').length
  const before = swaps()
  for (let i = 0; i < 3; i++) await h.clock.advance(2000)
  await idle(h)
  expect(swaps() - before).toBeLessThanOrEqual(2)
})

test('an old heartbeat with no shard is deleted, and a session ended by /clear is folded in', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  h.put(`${SHARDS}/ghost.alive`, '{"busy":false}')
  h.mtimes.set(`${SHARDS}/ghost.alive`, h.clock.now() - 25 * 3600_000)
  await start($)
  await idle(h)
  expect(h.disk.has(`${SHARDS}/ghost.alive`)).toBe(false)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  await clear($, h, 's2')
  await submit($, 'next')
  await idle(h)
  expect(h.disk.has(`${SHARDS}/s1.a.json`) || h.disk.has(`${SHARDS}/s1.b.json`)).toBe(false)
  expect(ownShard(h, 's2')?.entries['a.txt']?.owner).toBe('s1')
})

test('rows recorded on another branch carry the other-branch tag; a rebase keeps its branch', async ($, on) => {
  const h = host(on, { '/repo/x.txt': 'x2\n', '/repo/m.txt': 'm\n' })
  peerShard(h, 'old', { 'x.txt': { original: 'x\n', branch: 'ref: refs/heads/other' } }, ENDED(h))
  h.put(`${GIT_DIR}/HEAD`, 'abc123\n')
  h.put(`${GIT_DIR}/rebase-merge/head-name`, 'refs/heads/main\n')
  await start($)
  await $.tool.call(edit('/repo/m.txt', 'm', 'M'))
  h.disk.delete(`${GIT_DIR}/rebase-merge/head-name`)
  h.put(`${GIT_DIR}/HEAD`, 'ref: refs/heads/main\n')
  await h.clock.advance(2000)
  await idle(h)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /x\.txt modified earlier other branch/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^m\.txt modified$/ })).toBeDefined()
  await ui.unmount()
})

test("a hand edit already reported isn't reported again after a resume", async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  h.disk.set('/repo/a.txt', 'A, mine\n')
  expect((await submit($, 'next')).context?.join('\n')).toMatch(/modified `a\.txt`/)
  await idle(h)
  await clear($, h, 's2')
  const told = (await submit($, 'after clear')).context?.join('\n') ?? ''
  expect(told).toMatch(/earlier session: `a\.txt`/)
  expect(told).not.toMatch(/was modified by the user/)
  expect((await submit($, 'again')).context ?? []).toEqual([])
})

test('one torn slot beside a good one still lets originals be released', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  peerShard(h, 'peer', {}, { seq: 1 })
  h.put(`${SHARDS}/peer.b.json`, '{"v":1,"se')
  peerAlive(h, 'peer')
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  expect(treeShas(h)).toContain(fakeSha('a\n'))
  const ui = await mountPane($)
  await ui.press({ key: 'accept-all' })
  await idle(h)
  expect(treeShas(h)).not.toContain(fakeSha('a\n'))
  await ui.unmount()
})

test('after ✓, a new Claude edit keeps the accepted content as its original (an ended session not yet folded)', async ($, on) => {
  const h = host(on, { '/repo/x.txt': 'x, theirs\n' })
  await start($)
  await idle(h)
  // Another session recorded x.txt and /exited after this one started, so nothing folded it yet.
  peerShard(h, 'old', { 'x.txt': { original: 'x\n', at: h.clock.now() - 100 } }, ENDED(h))
  await h.clock.advance(2000)
  await idle(h)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /x\.txt/ })).toBeDefined()
  await ui.press({ key: 'accept-all' })
  await idle(h)
  expect(await isEmpty(ui)).toBe(true)
  await $.tool.call(edit('/repo/x.txt', 'theirs', 'mine'))
  await idle(h)
  await h.clock.advance(2000)
  await idle(h)
  await ui.press({ key: 'reject-all' })
  await idle(h)
  expect(h.disk.get('/repo/x.txt')).toBe('x, theirs\n')
  await ui.unmount()
})

test('after ✓, a new Claude edit keeps the accepted content as its original (a crashed session)', async ($, on) => {
  const h = host(on, { '/repo/x.txt': 'x, theirs\n' })
  peerShard(h, 'dead', { 'x.txt': { original: 'x\n' } })
  await h.clock.advance(40_000)
  await start($)
  await idle(h)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /x\.txt modified earlier/ })).toBeDefined()
  await ui.press({ key: 'accept-all' })
  await idle(h)
  await $.tool.call(edit('/repo/x.txt', 'theirs', 'mine'))
  await idle(h)
  await h.clock.advance(2000)
  await idle(h)
  await ui.press({ key: 'reject-all' })
  await idle(h)
  expect(h.disk.get('/repo/x.txt')).toBe('x, theirs\n')
  await ui.unmount()
})

test("an unreadable peer shard at load doesn't wipe this session's own list", async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  peerShard(h, 'peer', { 'z.txt': { original: 'z\n' } })
  peerAlive(h, 'peer')
  h.failFs(`${SHARDS}/peer.a.json`)
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ }), 'right after the edit').toBeDefined()
  await h.clock.advance(2000)
  await idle(h)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ }), 'after one tick').toBeDefined()
  await h.clock.advance(2000)
  await idle(h)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ }), 'after two ticks').toBeDefined()
  await ui.unmount()
})

test('a first window that writes its first record after this one loaded is still detected', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n', '/repo/w1.txt': 'w1, edited\n' })
  // Window 1 runs s1 and beats, but hasn't recorded anything yet.
  h.put(`${SHARDS}/s1.alive`, JSON.stringify({ busy: false, instance: 's1-1-w1' }))
  await start($)
  // Window 1 now records w1.txt.
  peerShard(h, 's1', { 'w1.txt': { original: 'w1\n' } }, { instance: 's1-1-w1' })
  h.put(`${SHARDS}/s1.alive`, JSON.stringify({ busy: false, instance: 's1-1-w1' }))
  await h.clock.advance(2000)
  await idle(h)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  expect(h.toasts).toContain("This session is open in another window too; pending changes here aren't shared.")
  expect(ownShard(h)?.entries['w1.txt']).toBeDefined()
  expect(ownShard(h)?.entries['a.txt']).toBeUndefined()
})

test('a reject for an owner folded away by a third session before this one saw it end is still told here', async ($, on) => {
  const h = host(on, { '/repo/live.txt': 'l, theirs\n' })
  peerShard(h, 'peer', { 'live.txt': { original: 'l\n', at: h.clock.now() - 100 } })
  peerAlive(h, 'peer')
  await start($)
  await submit($, 'x')
  const ui = await mountPane($)
  await ui.press({ key: 'reject-all' })
  await idle(h)
  await ui.unmount()
  // A third session folded the peer away (deleting its files) before this one's next refresh.
  for (const name of ['peer.a.json', 'peer.alive']) h.disk.delete(`${SHARDS}/${name}`)
  await h.clock.advance(2000)
  await idle(h)
  expect((await submit($, 'next')).context?.join('\n') ?? '').toMatch(/rejected your changes to `live\.txt`/)
})

test("a peer blob that can't be fetched isn't asked for on every tick", async ($, on) => {
  const h = host(on, { '/repo/x.txt': 'x2\n' })
  peerShard(h, 'peer', { 'x.txt': { original: 'x\n' } })
  peerAlive(h, 'peer')
  h.store.failCat.add(fakeSha('x\n'))
  await start($)
  await idle(h)
  const fetches = () => h.ran.filter(argv => argv[1] === 'cat-file' && argv[2] === '--batch').length
  const before = fetches()
  for (let i = 0; i < 5; i++) {
    peerAlive(h, 'peer')
    await h.clock.advance(2000)
  }
  await idle(h)
  expect(fetches() - before).toBeLessThanOrEqual(1)
})

test('a Claude edit while the list is still loading gives exactly one toast on a narrow terminal', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a, edited\n', '/repo/b.txt': 'b\n' }, { narrow: true })
  peerShard(h, 'old', { 'a.txt': { original: 'a\n' } }, ENDED(h))
  const release = h.hold('cat-file')
  const starting = start($)
  const call = $.tool.call(edit('/repo/b.txt', 'b', 'B'))
  await idle(h)
  release()
  await starting
  await call
  await idle(h)
  // One toast in all: the start decision's, never also the first-change hint.
  expect(h.toasts).toHaveLength(1)
  expect(h.toasts[0]).toMatch(/still pending review/)
})

test('✗ on an entry another session changed after the pane drew it leaves it and says so', async ($, on) => {
  const h = host(on, { '/repo/x.txt': 'x2\n' })
  peerShard(h, 'peer', { 'x.txt': { original: 'x\n' } })
  peerAlive(h, 'peer')
  await start($)
  const ui = await mountPane($)
  h.disk.set('/repo/x.txt', 'x3\n')
  peerShard(h, 'peer', { 'x.txt': { original: 'x\n', at: h.clock.now() + 50 } }, { seq: 2 })
  await ui.press({ key: 'reject-all' })
  expect(h.toasts.at(-1)).toBe('`x.txt` changed in another session; check it again.')
  expect(h.disk.get('/repo/x.txt')).toBe('x3\n')
  await ui.unmount()
})

test("entries from other sessions that would pass $.state's cap are left out, with one toast", async ($, on) => {
  const big = 'y'.repeat(1_500_000)
  const h = host(on, { '/repo/a.txt': `${big}a`, '/repo/b.txt': `${big}b`, '/repo/c.txt': 'c2\n' })
  peerShard(h, 'old', { 'a.txt': { original: big, seen: `${big}a` }, 'b.txt': { original: big, seen: `${big}b` }, 'c.txt': { original: 'c\n' } }, ENDED(h))
  await start($)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /b\.txt/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /c\.txt/ })).toBeDefined()
  expect(h.toasts.filter(t => /too large to list/.test(t))).toHaveLength(1)
  await ui.unmount()
})

/** A hot reload, through the mod's test seam: module state reset, `$.state` kept, and new settings. */
async function reload($: Engine, options: Record<string, unknown> = {}) {
  await $.command.run({ command: '__pending-changes-reload', args: JSON.stringify(options) } as never)
  await start($) // a reload raises session.start
}

test('a second window keeps what its Claude changed when it takes over', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  h.put(`${SHARDS}/s1.a.json`, JSON.stringify({ v: 1, seq: 4, session: 's1', instance: 'first-window', entries: {} }))
  h.put(`${SHARDS}/s1.alive`, JSON.stringify({ busy: false }))
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ }), 'before takeover').toBeDefined()
  for (let i = 0; i < 17; i++) await h.clock.advance(2000)
  await idle(h)
  await submit($, 'next')
  await idle(h)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ }), 'after takeover').toBeDefined()
  expect(ownShard(h)?.entries['a.txt']?.original).toBe(fakeSha('a\n'))
  await ui.unmount()
})

test("a second window's exit leaves the first window's record as it was", async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n', '/repo/w1.txt': 'w1, edited\n' })
  h.put(`${SHARDS}/s1.alive`, JSON.stringify({ busy: false, instance: 's1-1-w1' }))
  await start($)
  peerShard(h, 's1', { 'w1.txt': { original: 'w1\n' } }, { instance: 's1-1-w1' })
  h.put(`${SHARDS}/s1.alive`, JSON.stringify({ busy: false, instance: 's1-1-w1' }))
  await h.clock.advance(2000)
  await idle(h)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: {} } as never)
  await idle(h)
  const shard = ownShard(h)
  expect(shard?.instance).toBe('s1-1-w1')
  expect(shard?.endedAt).toBeUndefined()
  expect(Object.keys(shard?.entries ?? {})).toEqual(['w1.txt'])
  expect(h.disk.has(`${SHARDS}/s1.b.json`)).toBe(false)
})

test('a shard folder that fails to list once at start still gives the resume note', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a, edited\n' })
  peerShard(h, 'old', { 'a.txt': { original: 'a\n' } }, ENDED(h))
  h.failListing(1, 1)
  await start($)
  await h.clock.advance(2000)
  await idle(h)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ })).toBeDefined()
  await ui.unmount()
  expect((await submit($, 'x')).context?.join('\n') ?? '').toMatch(/earlier session: `a\.txt`/)
})

test('a ref-lock error counts as one write failure', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  await start($)
  h.store.lockError = true
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  // Backoff 2, 4, 8 s: three lock errors in 14 s; detached would need five.
  for (let i = 0; i < 7; i++) await h.clock.advance(2000)
  await idle(h)
  expect(h.ran.filter(argv => argv[1] === 'update-ref').length).toBeGreaterThanOrEqual(3)
  expect(heartbeat(h)?.detached).toBeUndefined()
})

test("a hot reload never rewrites the session's shard from an empty list: ✓ and an edit wait for the load", async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n', '/repo/b.txt': 'b\n', '/repo/c.txt': 'c\n' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await $.tool.call(edit('/repo/b.txt', 'b', 'B'))
  await idle(h)
  const ui = await mountPane($)
  const release = h.hold('rev-parse')
  await $.command.run({ command: '__pending-changes-reload', args: '{}' } as never)
  const accepting = ui.press({ key: `accept-${idOf('/repo/a.txt')}` })
  const editing = $.tool.call(edit('/repo/c.txt', 'c', 'C'))
  await idle(h)
  expect(Object.keys(ownShard(h)?.entries ?? {}).sort()).toEqual(['a.txt', 'b.txt'])
  release()
  await accepting
  await editing
  await idle(h)
  const entries = ownShard(h)?.entries ?? {}
  expect(entries['a.txt']).toMatchObject({ gone: true })
  expect(entries['b.txt']?.original).toBe(fakeSha('b\n'))
  expect(entries['c.txt']?.original).toBe(fakeSha('c\n'))
  await ui.unmount()
})

test('a session-only entry stays listed across a hot reload', async ($, on) => {
  const big = '€'.repeat(1_500_000) + '\n'
  const h = host(on, { '/repo/a.txt': 'a\n' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a\n', big))
  await idle(h)
  expect(ownShard(h)?.entries['a.txt']).toBeUndefined()
  await reload($)
  await submit($, 'next')
  await idle(h)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: /a\.txt/ })).toBeDefined()
  await ui.unmount()
})

test('a change made just before a hot reload reaches the shard after it', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  await start($)
  const release = h.hold('hash-object')
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await reload($)
  release()
  await submit($, 'next')
  await idle(h)
  await h.clock.advance(2000)
  await idle(h)
  expect(ownShard(h)?.entries['a.txt']?.original).toBe(fakeSha('a\n'))
})

test('turning persistence off, accepting a file and turning it back on keeps the file resolved', async ($, on) => {
  const h = host(on, { '/repo/a.txt': 'a\n' })
  await start($)
  await $.tool.call(edit('/repo/a.txt', 'a', 'A'))
  await idle(h)
  expect(ownShard(h)?.entries['a.txt']?.gone).toBeUndefined()
  await reload($, { persistAcrossSessions: false })
  const ui = await mountPane($)
  await ui.press({ key: 'accept-all' })
  await ui.unmount()
  await idle(h)
  expect(ownShard(h)?.entries['a.txt']?.gone).toBeUndefined() // nothing written while off
  await reload($, { persistAcrossSessions: true })
  await submit($, 'next')
  await idle(h)
  expect(ownShard(h)?.entries['a.txt']).toMatchObject({ gone: true })
  const after = await mountPane($)
  expect(await isEmpty(after)).toBe(true)
  await after.unmount()
})
