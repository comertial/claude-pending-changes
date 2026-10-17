import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Review, Tracked } from '../types'
import { countChanges } from './diff'
import { folderId, idOf } from './ids'
import { deleteTargets, isReadOnlyCommand } from './commands'

const PANE = 'pending-changes'
const TITLE = 'Changes'
const POLL_MS = 2000
const STALE_MS = 24 * 60 * 60 * 1000
/** The row under the mouse is tinted, so its ✓/✗ read as its own. */
const ROW_HOVER = 'inactive'

const files = atom({ plugin: 'pending-changes', key: 'files' } as const, {} as Record<string, Tracked>)
const notices = atom({ plugin: 'pending-changes', key: 'notices' } as const, [] as string[])
const collapsed = atom({ plugin: 'pending-changes', key: 'collapsed' } as const, [] as string[])

type $ = EngineInterface

// ---------------------------------------------------------------- context

type Ctx = {
  cwd: string
  isWindows: boolean
  /** `<OS temp>/claude-pending-changes`: the only place temp cleanup may delete. */
  tmpRoot: string
  /** The git work tree holding cwd, `/`-separated; null outside git (shell changes then fall back to delete commands). */
  gitRoot: string | null
  /** `<tmpRoot>/<sessionId>`: this session's review copies. */
  sessionDir: string
}

let ctxPromise: Promise<Ctx> | undefined

function ctx($: $): Promise<Ctx> {
  ctxPromise ??= (async () => {
    const cwd = slash(await $.session.cwd())
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const tmp =
      (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? (await $.env.get('TMP')) ?? '/tmp'
    const tmpRoot = `${slash(tmp)}/claude-pending-changes`
    const sessionDir = `${tmpRoot}/${await $.session.id()}`
    return { cwd, isWindows, tmpRoot, sessionDir, gitRoot: await findGitRoot($, cwd) }
  })().catch(error => {
    ctxPromise = undefined
    throw error
  })
  return ctxPromise
}

// ---------------------------------------------------------------- paths

function slash(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function keyOf(path: string, isWindows: boolean): string {
  return isWindows ? slash(path).toLowerCase() : slash(path)
}

function isInside(path: string, root: string, isWindows: boolean): boolean {
  return keyOf(path, isWindows).startsWith(`${keyOf(root, isWindows)}/`)
}

function native(path: string, isWindows: boolean): string {
  return isWindows ? path.replace(/\//g, '\\') : path
}

function fit(text: string, room: number): string {
  return text.length <= room ? text : `…${text.slice(text.length - Math.max(1, room - 1))}`
}

type Status = 'added' | 'modified' | 'deleted'
const statusOf = (f: Tracked): Status => (f.original === null ? 'added' : f.isDeleted ? 'deleted' : 'modified')
const STATUS_COLOR = { added: 'success', modified: 'warning', deleted: 'error' } as const
/** The name is styled to match its status, so the status reads without colour. */
const NAME_STYLE = {
  added: { underline: true },
  modified: { italic: true },
  deleted: { strikethrough: true, dimColor: true },
} as const

// ---------------------------------------------------------------- host io

async function readOrNull($: $, path: string): Promise<string | null> {
  return (await $.fs.exists(path)) ? await $.fs.read(path) : null
}

/** Deletes a file or folder, refusing anything outside `allowedRoot`. */
async function removePath($: $, c: Ctx, path: string, allowedRoot: string): Promise<void> {
  if (!isInside(path, allowedRoot, c.isWindows)) return
  if (!(await $.fs.exists(path))) return
  const p = native(path, c.isWindows)
  if (!c.isWindows) {
    await $.process.run(['rm', '-rf', p])
    return
  }
  const { kind } = await $.fs.stat(path)
  await $.process.run(kind === 'dir' ? ['cmd', '/c', 'rmdir', '/s', '/q', p] : ['cmd', '/c', 'del', '/f', '/q', p])
}

async function openInVsCode($: $, c: Ctx, review: Review, source: string): Promise<void> {
  const left = native(review.originalCopy, c.isWindows)
  const right = native(source, c.isWindows)
  const argv = c.isWindows ? ['cmd', '/c', 'code', '--diff', left, right] : ['code', '--diff', left, right]
  try {
    const { exitCode, stderr } = await $.process.run(argv)
    if (exitCode !== 0) $.ui.toast(`Could not open VS Code (is \`code\` on PATH?) ${stderr.trim().slice(0, 200)}`)
  } catch {
    $.ui.toast('Could not open VS Code: is `code` on PATH?')
  }
}

// ---------------------------------------------------------------- state

async function queueNotice($: $, text: string): Promise<void> {
  await update($, notices, list => [...list, text])
}

type Base = Pick<Tracked, 'path' | 'rel' | 'original' | 'createdDirs'>

/** Records `current` against the original, or drops the entry when they match again. */
async function settle(
  $: $,
  key: string,
  base: Base,
  current: string | null,
  seenByClaude: string | null | undefined,
): Promise<{ wasEmpty: boolean; dropped?: Tracked }> {
  let wasEmpty = false
  let dropped: Tracked | undefined
  await update($, files, all => {
    wasEmpty = Object.keys(all).length === 0
    const prev = all[key]
    const next = { ...all }
    if (current === base.original) {
      dropped = prev
      delete next[key]
      return next
    }
    const { added, removed } = countChanges(base.original, current)
    const isDeleted = current === null
    if (
      prev &&
      seenByClaude === undefined &&
      prev.added === added &&
      prev.removed === removed &&
      Boolean(prev.isDeleted) === isDeleted
    ) {
      return all
    }
    next[key] = {
      path: base.path,
      rel: base.rel,
      original: base.original,
      ...(base.createdDirs?.length ? { createdDirs: base.createdDirs } : {}),
      added,
      removed,
      lastSeenByClaude: seenByClaude !== undefined ? seenByClaude : prev ? prev.lastSeenByClaude : current,
      ...(current === null ? { isDeleted: true } : {}),
      ...(prev?.review ? { review: prev.review } : {}),
    }
    return next
  })
  return { wasEmpty, dropped }
}

async function forget($: $, key: string): Promise<void> {
  await update($, files, all => {
    if (!(key in all)) return all
    const next = { ...all }
    delete next[key]
    return next
  })
}

async function cleanupReview($: $, review: Review | undefined): Promise<void> {
  if (!review) return
  const c = await ctx($)
  await removePath($, c, review.originalCopy, c.tmpRoot)
  if (review.deletedCopy) await removePath($, c, review.deletedCopy, c.tmpRoot)
}

// ---------------------------------------------------------------- actions

async function accept($: $, key: string): Promise<void> {
  const entry = (await read($, files))[key]
  if (!entry) return
  await forget($, key)
  await cleanupReview($, entry.review)
}

async function reject($: $, key: string): Promise<void> {
  const entry = (await read($, files))[key]
  if (!entry) return
  const c = await ctx($)
  if (entry.original === null) {
    await removePath($, c, entry.path, c.cwd)
    await removeEmptyDirs($, c, entry.createdDirs ?? [])
  } else {
    await $.fs.write(entry.path, entry.original)
  }
  await forget($, key)
  await cleanupReview($, entry.review)
  await queueNotice(
    $,
    entry.original === null
      ? `The user rejected your new file \`${entry.rel}\`: it has been deleted.`
      : entry.isDeleted
        ? `The user rejected your deletion of \`${entry.rel}\`: it has been restored.`
        : `The user rejected your changes to \`${entry.rel}\`: it is back to its content from before you edited it. Re-read it before editing it again.`,
  )
}

/**
 * Opens VS Code's diff: the original (a temp copy) read-only on the left, the
 * source file itself editable on the right. A block's arrow reverts it; saves
 * land in the source, and the poll keeps the counts and the list true.
 */
async function openReview($: $, key: string): Promise<void> {
  const entry = (await read($, files))[key]
  if (!entry) return
  const c = await ctx($)
  // A review from the earlier layout (kept in $.state across the reload) has no originalCopy.
  const cut = entry.rel.lastIndexOf('/')
  const dir = cut < 0 ? '' : `/${entry.rel.slice(0, cut)}`
  const name = entry.rel.slice(cut + 1)
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']

  // A deleted file has no right side to edit: show it against an empty stand-in.
  // It is recorded on the review so resolving the file deletes it too.
  let deletedCopy: string | undefined
  if (!(await $.fs.exists(entry.path))) {
    deletedCopy = `${c.sessionDir}${dir}/${stem}.deleted${ext}`
    await $.fs.write(deletedCopy, '')
  }

  // A review from the earlier layout (kept in $.state across the reload) has no originalCopy.
  const reusable = entry.review?.originalCopy && (await $.fs.exists(entry.review.originalCopy))
  let review: Review = reusable ? entry.review! : { originalCopy: `${c.sessionDir}${dir}/${stem}.original${ext}` }
  if (!reusable) await $.fs.write(review.originalCopy, entry.original ?? '')
  if (deletedCopy) review = { ...review, deletedCopy }
  if (review !== entry.review) {
    await update($, files, all => (all[key] ? { ...all, [key]: { ...all[key]!, review } } : all))
  }
  await openInVsCode($, c, review, deletedCopy ?? entry.path)
}

/** Deletes the folders Claude's write created, deepest first, while each is empty. */
async function removeEmptyDirs($: $, c: Ctx, dirs: readonly string[]): Promise<void> {
  for (const dir of [...dirs].reverse()) {
    if (!(await $.fs.exists(dir))) continue
    if ((await $.fs.list(dir)).length > 0) return
    await removePath($, c, dir, c.cwd)
  }
}

/** Runs `act` on every tracked file, or on those under the folder `relDir`. */
async function forAll($: $, act: (key: string) => Promise<void>, relDir?: string): Promise<void> {
  for (const [key, entry] of Object.entries(await read($, files))) {
    if (relDir === undefined || entry.rel.startsWith(`${relDir}/`)) await act(key)
  }
}

/**
 * The folders between the working directory and `rel`'s file that Claude is
 * creating: missing now, or created by an earlier pending write of Claude's.
 */
async function missingDirs($: $, c: Ctx, rel: string): Promise<string[]> {
  const byClaude = new Set(
    Object.values(await read($, files)).flatMap(f => (f.createdDirs ?? []).map(d => keyOf(d, c.isWindows))),
  )
  const parts = rel.split('/').slice(0, -1)
  const missing: string[] = []
  for (let i = 1; i <= parts.length; i++) {
    const dir = `${c.cwd}/${parts.slice(0, i).join('/')}`
    if (missing.length > 0 || byClaude.has(keyOf(dir, c.isWindows)) || !(await $.fs.exists(dir))) missing.push(dir)
  }
  return missing
}

// ---------------------------------------------------------------- tree

type FolderNode = {
  name: string
  rel: string
  folders: Map<string, FolderNode>
  files: [string, Tracked][]
  added: number
  removed: number
}

/** `guide` is the dim tree drawing in front of the row: `│  ├─ `. */
type Row =
  | { kind: 'folder'; guide: string; node: FolderNode }
  | { kind: 'file'; guide: string; key: string; name: string; file: Tracked }

/** Groups the files by folder and flattens them, folders first, chains of lone folders merged. */
function treeRows(all: [string, Tracked][], closed: ReadonlySet<string> = new Set()): Row[] {
  const root: FolderNode = { name: '', rel: '', folders: new Map(), files: [], added: 0, removed: 0 }
  for (const [key, file] of all) {
    let node = root
    for (const part of file.rel.split('/').slice(0, -1)) {
      let child = node.folders.get(part)
      if (!child) {
        const rel = node.rel ? `${node.rel}/${part}` : part
        child = { name: part, rel, folders: new Map(), files: [], added: 0, removed: 0 }
        node.folders.set(part, child)
      }
      node = child
    }
    node.files.push([key, file])
  }

  const total = (node: FolderNode): void => {
    for (const child of node.folders.values()) {
      total(child)
      node.added += child.added
      node.removed += child.removed
    }
    for (const [, f] of node.files) {
      node.added += f.added
      node.removed += f.removed
    }
  }
  total(root)

  const rows: Row[] = []
  // Top-level rows get no connector; below them, `├─`/`└─` and `│` columns show the nesting.
  const walk = (node: FolderNode, prefix: string, isTop: boolean): void => {
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))
    const files = [...node.files].sort((a, b) => a[1].rel.localeCompare(b[1].rel))
    const count = folders.length + files.length
    let index = 0
    const place = () => {
      const isLast = ++index === count
      return {
        guide: isTop ? '' : `${prefix}${isLast ? '└─ ' : '├─ '}`,
        childPrefix: isTop ? '' : `${prefix}${isLast ? '   ' : '│  '}`,
      }
    }
    for (let folder of folders) {
      let name = folder.name
      while (folder.files.length === 0 && folder.folders.size === 1) {
        folder = [...folder.folders.values()][0]!
        name = `${name}/${folder.name}`
      }
      const { guide, childPrefix } = place()
      rows.push({ kind: 'folder', guide, node: { ...folder, name } })
      if (!closed.has(folder.rel)) walk(folder, childPrefix, false)
    }
    for (const [key, file] of files) {
      const { guide } = place()
      rows.push({ kind: 'file', guide, key, name: file.rel.slice(file.rel.lastIndexOf('/') + 1), file })
    }
  }
  walk(root, '', true)
  return rows
}

// ---------------------------------------------------------------- polling

let pollTimer: { cancel: () => void } | undefined

/**
 * Claude tool calls that may write and are still running. The poll waits while
 * any is, or it would see Claude's own change half-done and call it the user's.
 */
let toolsInFlight = 0

/**
 * Starts the 2 s refresh if this load of the module has none. Called from
 * every hook, since a reload drops the timer and may not raise session.start.
 */
function ensurePolling($: $): void {
  if (pollTimer) return
  pollTimer = $.clock.every(POLL_MS, () => {
    void poll($).catch(() => {})
  })
}

/** Keeps counts true after edits made outside Claude, and drops files back at their original. */
async function poll($: $): Promise<void> {
  if (toolsInFlight > 0) return
  const all = await read($, files)
  for (const [key, entry] of Object.entries(all)) {
    try {
      const current = await readOrNull($, entry.path)
      if (toolsInFlight > 0) return
      // A new file the user emptied (every block reverted in the diff) is a rejection.
      // One Claude itself wrote empty stays.
      if (entry.original === null && current === '' && entry.lastSeenByClaude) {
        await reject($, key)
        continue
      }
      const { dropped } = await settle($, key, entry, current, undefined)
      if (!dropped) continue
      await cleanupReview($, dropped.review)
      if (current !== dropped.lastSeenByClaude) {
        await queueNotice(
          $,
          `The user reverted all your changes to \`${dropped.rel}\`: it is back to its content from before you edited it. Re-read it before editing it again.`,
        )
      }
    } catch {
      // One unreadable file must not stop the others from refreshing.
    }
  }
}

async function sweepStale($: $, c: Ctx): Promise<void> {
  if (!(await $.fs.exists(c.tmpRoot))) return
  const now = await $.clock.now()
  for (const entry of await $.fs.list(c.tmpRoot)) {
    const path = `${c.tmpRoot}/${entry.name}`
    if (path === c.sessionDir) continue
    const { mtimeMs } = await $.fs.stat(path)
    if (now - mtimeMs > STALE_MS) await removePath($, c, path, c.tmpRoot)
  }
}

// ---------------------------------------------------------------- shell commands
//
// Bash and PowerShell calls are bracketed by two `git status` runs: what moved
// between them is what the command changed, however it was written. Outside a
// git work tree only plain delete commands (`rm`, `del`, `Remove-Item`) are seen.

async function findGitRoot($: $, cwd: string): Promise<string | null> {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
    return exitCode === 0 && stdout.trim() ? slash(stdout.trim()) : null
  } catch {
    return null
  }
}

/** The paths (relative to the work tree) that differ from HEAD, untracked files included, ignored ones not. */
async function gitDirty($: $, c: Ctx): Promise<Set<string> | null> {
  if (!c.gitRoot) return null
  const { exitCode, stdout } = await $.process.run(
    ['git', 'status', '--porcelain', '-z', '--untracked-files=all'],
    { cwd: c.gitRoot },
  )
  if (exitCode !== 0) return null
  const paths = new Set<string>()
  const parts = stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    if (entry.length < 4) continue
    paths.add(entry.slice(3))
    // A rename or copy carries its old path as the next field.
    if (entry[0] === 'R' || entry[0] === 'C') {
      const old = parts[++i]
      if (old) paths.add(old)
    }
  }
  return paths
}

/** The file's committed text as the work tree would hold it (eol filters applied), or null when HEAD has none. */
async function headContent($: $, c: Ctx, gitRel: string): Promise<string | null> {
  if (!c.gitRoot) return null
  const { exitCode, stdout } = await $.process.run(['git', 'cat-file', '--filters', `HEAD:${gitRel}`], {
    cwd: c.gitRoot,
  })
  return exitCode === 0 ? stdout : null
}

type ShellSnapshot = {
  /** Paths (work-tree relative) dirty before the command; null outside git. */
  dirty: Set<string> | null
  /** Content before the command, by key: dirty files, tracked files, delete targets. */
  before: Map<string, { path: string; text: string | null }>
}

function absolute(c: Ctx, path: string): string {
  const p = slash(path)
  return /^([a-z]:)?\//i.test(p) ? p : `${c.cwd}/${p.replace(/^\.\//, '')}`
}

async function beforeShell($: $, c: Ctx, command: string): Promise<ShellSnapshot> {
  const before = new Map<string, { path: string; text: string | null }>()
  const keep = async (path: string) => {
    const key = keyOf(path, c.isWindows)
    if (before.has(key) || !isInside(path, c.cwd, c.isWindows)) return
    try {
      before.set(key, { path, text: await readOrNull($, path) })
    } catch {
      // Unreadable (too large, a folder): not compared.
    }
  }
  for (const entry of Object.values(await read($, files))) await keep(entry.path)
  const dirty = await gitDirty($, c).catch(() => null)
  if (dirty && c.gitRoot) {
    for (const rel of [...dirty].slice(0, 500)) await keep(`${c.gitRoot}/${rel}`)
  } else {
    for (const target of deleteTargets(command)) await keep(absolute(c, target))
  }
  return { dirty, before }
}

/** The folders between cwd and a file a command created that hold nothing git or the snapshot knows. */
async function shellCreatedDirs($: $, c: Ctx, snap: ShellSnapshot, rel: string): Promise<string[]> {
  if (!c.gitRoot) return []
  const known = [...snap.before.keys()]
  const created: string[] = []
  const parts = rel.split('/').slice(0, -1)
  for (let i = parts.length; i >= 1; i--) {
    const dir = `${c.cwd}/${parts.slice(0, i).join('/')}`
    const dirKey = keyOf(dir, c.isWindows)
    if (known.some(k => k.startsWith(`${dirKey}/`))) break
    const { stdout } = await $.process.run(['git', 'ls-files', '--', dir], { cwd: c.gitRoot })
    if (stdout.trim() !== '') break
    created.unshift(dir)
  }
  return created
}

async function afterShell($: $, c: Ctx, snap: ShellSnapshot): Promise<void> {
  const candidates = new Map<string, string>() // key -> absolute path
  for (const [key, { path }] of snap.before) candidates.set(key, path)
  const dirty = snap.dirty ? await gitDirty($, c).catch(() => null) : null
  if (dirty && c.gitRoot) {
    for (const rel of dirty) {
      const path = `${c.gitRoot}/${rel}`
      if (isInside(path, c.cwd, c.isWindows)) candidates.set(keyOf(path, c.isWindows), path)
    }
  }

  const tracked = await read($, files)
  for (const [key, path] of candidates) {
    let current: string | null
    try {
      current = await readOrNull($, path)
    } catch {
      continue
    }
    const had = snap.before.get(key)
    if (had && had.text === current) continue // the command left it as it was

    const known = tracked[key]
    if (known) {
      const { dropped } = await settle($, key, known, current, current)
      if (dropped) await cleanupReview($, dropped.review)
      continue
    }
    let original: string | null
    if (had) original = had.text
    else if (c.gitRoot) original = await headContent($, c, slash(path).slice(c.gitRoot.length + 1))
    else continue
    if (current === original) continue

    const rel = slash(path).slice(c.cwd.length + 1)
    const createdDirs = original === null ? await shellCreatedDirs($, c, snap, rel) : undefined
    const { wasEmpty, dropped } = await settle($, key, { path, rel, original, createdDirs }, current, current)
    if (wasEmpty && !dropped) void openUnasked($, CHANGED_HINT)
  }
}

// ---------------------------------------------------------------- opening the pane

const CHANGED_HINT = 'Claude changed files. Run /changes to review them.'

/**
 * Opens the pane on the mod's own initiative. The engine seats such a pane only
 * from 144 columns (110 once the person opened it), so on a narrower terminal
 * it waits undrawn: then a toast says how to see it.
 */
async function openUnasked($: $, hint: string): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  if (!opened.isPlaced) $.ui.toast(hint, { timeoutMs: 8000 })
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'changes',
      description: 'Show the files Claude changed, to accept, reject or review',
    })
    ensurePolling($)
    void ctx($)
      .then(c => sweepStale($, c))
      .catch(() => {})
    const pending = Object.keys(await read($, files)).length
    if (pending > 0) {
      void openUnasked($, `${pending} file${pending === 1 ? '' : 's'} still pending review. Run /changes to see them.`)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      const c = await ctx($)
      await removePath($, c, c.sessionDir, c.tmpRoot)
    } catch {
      // Nothing to clean, or the host is going away.
    }
    ctxPromise = undefined
    return next(e)
  })

  on('command.run', { command: 'changes' }, async $ => {
    ensurePolling($)
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: 'Changes pane opened.' }
  })

  on('tool.call', async ($, e, next) => {
    ensurePolling($)
    const path =
      e.tool === 'Edit' || e.tool === 'Write'
        ? e.file_path
        : e.tool === 'NotebookEdit'
          ? e.notebook_path
          : undefined

    let tracked: { key: string; base: Base } | undefined
    if (path !== undefined) {
      const c = await ctx($)
      if (isInside(path, c.cwd, c.isWindows)) {
        const key = keyOf(path, c.isWindows)
        const rel = slash(path).slice(c.cwd.length + 1)
        const known = (await read($, files))[key]
        const original = known ? known.original : await readOrNull($, path)
        const createdDirs = known ? known.createdDirs : original === null ? await missingDirs($, c, rel) : undefined
        tracked = { key, base: { path, rel, original, createdDirs } }
      }
    }

    // A shell command that may write: note what git sees as changed before it runs.
    const command = e.tool === 'Bash' || e.tool === 'PowerShell' ? e.command : undefined
    let shell: { c: Ctx; snap: ShellSnapshot } | undefined
    if (command !== undefined && !isReadOnlyCommand(command)) {
      try {
        const c = await ctx($)
        shell = { c, snap: await beforeShell($, c, command) }
      } catch {
        // No snapshot: the command runs untracked.
      }
    }

    const isWriting = tracked !== undefined || shell !== undefined
    if (isWriting) toolsInFlight++
    try {
      const ran = await next(e)
      if (ran.deny !== undefined) return ran

      // Failed commands can still have changed files, so compare either way.
      if (shell) {
        try {
          await afterShell($, shell.c, shell.snap)
        } catch {
          // Comparing failed; the poll still refreshes what is already listed.
        }
      }

      if (tracked && ran.isError !== true) {
        const current = await readOrNull($, tracked.base.path)
        const { wasEmpty, dropped } = await settle($, tracked.key, tracked.base, current, current)
        if (dropped) await cleanupReview($, dropped.review)
        if (wasEmpty && !dropped) void openUnasked($, CHANGED_HINT)
      }

      // Deliver reverts the user made mid-turn with the next tool result.
      const queued = await read($, notices)
      if (queued.length === 0) return ran
      await update($, notices, () => [])
      return { ...ran, context: [...(ran.context ?? []), ...queued] }
    } finally {
      if (isWriting) toolsInFlight--
    }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    ensurePolling($)
    const notes = [...(await read($, notices))]
    const all = await read($, files)
    const seen: Record<string, string | null> = {}
    for (const [key, entry] of Object.entries(all)) {
      const current = await readOrNull($, entry.path)
      if (current === entry.lastSeenByClaude) continue
      notes.push(
        current === null
          ? `The user deleted \`${entry.rel}\` after your last edit.`
          : `The user modified \`${entry.rel}\` after your last edit; re-read it before editing it again.`,
      )
      seen[key] = current
    }
    if (notes.length === 0) return next(e)

    await update($, notices, () => [])
    await update($, files, now => {
      const out = { ...now }
      for (const [key, text] of Object.entries(seen)) {
        if (out[key]) out[key] = { ...out[key]!, lastSeenByClaude: text }
      }
      return out
    })
    return next({ ...e, context: [...(e.context ?? []), `[pending-changes]\n${notes.join('\n')}`] })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // The pane redraws right after a reload, before any tool call or prompt.
    try {
      ensurePolling($)
    } catch {
      // Drawing may not start timers on some surface; the other hooks will.
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = Object.entries(await read($, files)).sort((a, b) => a[1].rel.localeCompare(b[1].rel))
    if (all.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No pending changes.</Text>
        </Box>
      )
    }

    const width = e.props.bodyColumns
    const closedDirs = new Set(await read($, collapsed))
    const added = all.reduce((sum, [, f]) => sum + f.added, 0)
    const removed = all.reduce((sum, [, f]) => sum + f.removed, 0)

    return (
      <Box flexDirection="column">
        {treeRows(all, closedDirs).map(row => {
          const guide = row.guide ? <Text dimColor>{row.guide}</Text> : ''
          const added = row.kind === 'folder' ? row.node.added : row.file.added
          const removed = row.kind === 'folder' ? row.node.removed : row.file.removed
          const room = Math.max(8, width - row.guide.length - `+${added} -${removed}`.length - 25)
          const counts = [
            <Text color="success">{`+${added}`}</Text>,
            <Text color="error">{`-${removed}`}</Text>,
          ]
          // Pushes the counts and buttons to the right edge.
          const leader = <Box flexGrow={1} minWidth={1} height={1} />

          if (row.kind === 'folder') {
            const id = folderId(row.node.rel)
            const relDir = row.node.rel
            const isOpen = !closedDirs.has(relDir)
            const toggle = () =>
              void update($, collapsed, list =>
                list.includes(relDir) ? list.filter(d => d !== relDir) : [...list, relDir],
              )
            return (
              <Box key={`row-${id}`} flexDirection="row" gap={1} hover={{ backgroundColor: ROW_HOVER }}>
                <Button key={`toggle-dir-${id}`} plain onPress={toggle}>
                  {guide}
                  <Text bold color="suggestion">{`${isOpen ? '▾' : '▸'} ${fit(row.node.name, room)}/`}</Text>
                </Button>
                {leader}
                <Box flexDirection="row" gap={1} flexShrink={0}>
                  {counts}
                  <Button
                    key={`accept-dir-${id}`}
                    label="✓"
                    onPress={() => void forAll($, key => accept($, key), relDir)}
                  />
                  <Button
                    key={`reject-dir-${id}`}
                    label="✗"
                    onPress={() => void forAll($, key => reject($, key), relDir)}
                  />
                </Box>
              </Box>
            )
          }

          const { key, file } = row
          const id = idOf(key)
          const status = statusOf(file)
          return (
            <Box key={`row-${id}`} flexDirection="row" gap={1} hover={{ backgroundColor: ROW_HOVER }}>
              <Button key={`open-${id}`} plain onPress={() => void openReview($, key)}>
                {guide}
                <Text {...NAME_STYLE[status]}>{fit(row.name, room)}</Text>
                <Text color={STATUS_COLOR[status]}>{` ${status}`}</Text>
              </Button>
              {leader}
              <Box flexDirection="row" gap={1} flexShrink={0}>
                {counts}
                <Button key={`accept-${id}`} label="✓" onPress={() => void accept($, key)} />
                <Button key={`reject-${id}`} label="✗" onPress={() => void reject($, key)} />
              </Box>
            </Box>
          )
        })}
        <Box flexDirection="row" justifyContent="space-between" gap={1} marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Text>{`${all.length} file${all.length === 1 ? '' : 's'}`}</Text>
            <Text color="success">{`+${added}`}</Text>
            <Text color="error">{`-${removed}`}</Text>
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Button
              key="accept-all"
              label="Accept all"
              variant="primary"
              onPress={() => void forAll($, key => accept($, key))}
            />
            <Button key="reject-all" label="Reject all" onPress={() => void forAll($, key => reject($, key))} />
          </Box>
        </Box>
      </Box>
    )
  })
}
