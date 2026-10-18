import { atom, read, update } from 'claude-code'
import type { EngineInterface, NextBudget, PluginOptions, Register } from 'claude-code'

import type { Review, Tracked } from '../types'
import { countChanges } from './diff'
import { folderId, idOf } from './ids'
import { deleteTargets, isReadOnlyCommand } from './commands'
import {
  BLOB_CAP,
  FOLD_MS,
  REF_ROOT,
  STALE_MS,
  branchOf,
  byteLength,
  encodeWorktreeName,
  foldIn,
  isFoldable,
  liveness,
  mergeShards,
  note,
  parseCatFileBatch,
  parseHeartbeat,
  parseLsTree,
  parseShard,
  pruneTombstones,
  refFor,
  slotOf,
  treeInput,
  zeroId,
} from './persist'
import type { Event, GoneReason, Merged, MergeResult, RejectKind, Shard } from './persist'

const PANE = 'pending-changes'
const TITLE = 'Changes'
const POLL_MS = 2000
const STALE_TEMP_MS = 24 * 60 * 60 * 1000
/** `$.state` refuses a value longer than 4,194,304 characters; this leaves room for the rest of the list. */
const STATE_CAP = 4_194_304 - 64 * 1024
/** The row under the mouse is tinted, so its ✓/✗ read as its own. */
const ROW_HOVER = 'inactive'

const files = atom({ plugin: 'pending-changes', key: 'files' } as const, {} as Record<string, Tracked>)
const notices = atom({ plugin: 'pending-changes', key: 'notices' } as const, [] as string[])
const collapsed = atom({ plugin: 'pending-changes', key: 'collapsed' } as const, [] as string[])
const outside = atom({ plugin: 'pending-changes', key: 'outside' } as const, 0)
const sessions = atom({ plugin: 'pending-changes', key: 'sessions' } as const, {} as Record<string, 'live' | 'ended'>)
const loadedFor = atom({ plugin: 'pending-changes', key: 'loadedFor' } as const, '')
const resumeNoted = atom({ plugin: 'pending-changes', key: 'resumeNoted' } as const, [] as string[])
const knows = atom({ plugin: 'pending-changes', key: 'knows' } as const, {} as Record<string, string | null>)
const resolvedWhileOff = atom({ plugin: 'pending-changes', key: 'resolvedWhileOff' } as const, {} as Record<string, { at: number; rel: string }>)
const instanceAtom = atom({ plugin: 'pending-changes', key: 'instance' } as const, '')
const branchNow = atom({ plugin: 'pending-changes', key: 'branchNow' } as const, '')

type $ = EngineInterface

/** The `userConfig` values this load was given. */
let options: PluginOptions = {}

// ---------------------------------------------------------------- context

type GitCtx = {
  gitDir: string
  commonDir: string
  /** `refs/pending-changes/<worktree id>`. */
  ref: string
  objectFormat: string
  /** The cwd relative to the work tree root: `sub/`, or ''. */
  prefix: string
  /** `<gitDir>/pending-changes`: the shards and heartbeats. */
  shardDir: string
}

type Ctx = {
  cwd: string
  isWindows: boolean
  /** `<OS temp>/claude-pending-changes`: the only place temp cleanup may delete. */
  tmpRoot: string
  /** The git work tree holding cwd, `/`-separated; null outside git (shell changes then fall back to delete commands). */
  gitRoot: string | null
  /** Set when git is new enough to name its dirs; null means no persistence. */
  git: GitCtx | null
  /** `<tmpRoot>/<sessionId>`: this session's review copies. */
  sessionDir: string
  /** The session id `sessionDir` belongs to. */
  sessionId: string
}

let ctxPromise: Promise<Ctx> | undefined

/** Session ids whose session.end ran in this process: never loaded again unless a session.start revives one. */
const endedIds = new Set<string>()

function ctx($: $): Promise<Ctx> {
  ctxPromise ??= (async () => {
    const cwd = slash(await $.session.cwd())
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const tmp =
      (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? (await $.env.get('TMP')) ?? '/tmp'
    const tmpRoot = `${slash(tmp)}/claude-pending-changes`
    const sessionId = await $.session.id()
    const sessionDir = `${tmpRoot}/${sessionId}`
    const { gitRoot, git } = await findGit($, cwd)
    return { cwd, isWindows, tmpRoot, sessionDir, sessionId, gitRoot, git }
  })().catch(error => {
    ctxPromise = undefined
    throw error
  })
  return ctxPromise
}

/** Persistence is on: the setting allows it, and git named its dirs. */
const persistOn = (c: Ctx): c is Ctx & { git: GitCtx; gitRoot: string } =>
  options.persistAcrossSessions !== false && c.git !== null && c.gitRoot !== null

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

/** The worktree-relative path of a file under cwd: the cwd's prefix plus its cwd-relative path. */
const gitRelOf = (c: Ctx & { git: GitCtx }, rel: string) => `${c.git.prefix}${rel}`
const gitKeyOf = (c: Ctx, gitRel: string) => (c.isWindows ? gitRel.toLowerCase() : gitRel)

/** Where a worktree-relative path is: under cwd as the session spells it, otherwise under the git root. */
function pathOfGitRel(c: Ctx & { git: GitCtx; gitRoot: string }, gitRel: string): string {
  const prefix = c.git.prefix
  const under = c.isWindows ? gitRel.toLowerCase().startsWith(prefix.toLowerCase()) : gitRel.startsWith(prefix)
  return under ? `${c.cwd}/${gitRel.slice(prefix.length)}` : `${c.gitRoot}/${gitRel}`
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

/**
 * Who a settle speaks for: Claude's own change takes ownership and is recorded;
 * an observed one (the refresh, a load, a prompt) keeps the owner and records only
 * a drop; a peer's is applied from its record and recorded nowhere.
 */
type From = 'claude' | 'observed' | 'peer'

type SettleOptions = {
  from?: From
  /** Why an observed drop happened, for the resolve record. */
  reason?: GoneReason
  /** A resolve this change starts after (see Event.epoch). */
  epoch?: number
  /** The refresh may update counts but not drop (a peer is mid-write). */
  noDrop?: boolean
}

/** Records `current` against the original, or drops the entry when they match again. */
async function settle(
  $: $,
  key: string,
  base: Base,
  current: string | null,
  seenByClaude: string | null | undefined,
  opts: SettleOptions = {},
): Promise<{ wasEmpty: boolean; dropped?: Tracked }> {
  const from = opts.from ?? 'observed'
  const c = await ctx($)
  const persist = persistOn(c)
  const me = await $.session.id()
  const at = persist && from !== 'peer' ? await nextAt($) : undefined
  let wasEmpty = false
  let dropped: Tracked | undefined
  let written: Tracked | undefined
  await update($, files, all => {
    wasEmpty = Object.keys(all).length === 0
    const prev = all[key]
    const next = { ...all }
    if (current === base.original) {
      if (opts.noDrop) return all
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
    const keep: Partial<Tracked> = prev ?? {}
    written = {
      path: base.path,
      rel: base.rel,
      original: base.original,
      ...(base.createdDirs?.length ? { createdDirs: base.createdDirs } : {}),
      added,
      removed,
      lastSeenByClaude: seenByClaude !== undefined ? seenByClaude : prev ? prev.lastSeenByClaude : current,
      ...(current === null ? { isDeleted: true } : {}),
      ...(prev?.review ? { review: prev.review } : {}),
      ...(keep.owner ? { owner: keep.owner } : {}),
      ...(keep.gitRel ? { gitRel: keep.gitRel } : {}),
      ...(keep.at !== undefined ? { at: keep.at } : {}),
      ...(keep.branch ? { branch: keep.branch } : {}),
      ...(keep.sessionOnly ? { sessionOnly: true } : {}),
    }
    if (from === 'claude') {
      written.owner = me
      if (persist) {
        written.gitRel = gitRelOf(c, base.rel)
        written.at = at
        written.branch = rt.branch
      }
    }
    next[key] = written
    return next
  })
  if (persist && from !== 'peer') {
    if (dropped?.gitRel) recordGone(c, dropped, me, at!, opts.reason ?? 'settled')
    else if (from === 'claude' && written) recordLive(c, written, me, opts.epoch)
  } else if (!persist && dropped && from !== 'peer') {
    await noteResolvedWhileOff($, c, dropped)
  }
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

// ---------------------------------------------------------------- persistence
//
// Each session keeps its records in a shard in the worktree's git dir, merges
// every session's shards on each refresh, and pins the originals it records in
// git's object store through one tree ref per worktree. See docs/SPEC.md,
// "Persistence", for the rules this follows.

type Slot = { mtimeMs: number; size: number; shard?: Shard }
type Peer = {
  slots: Partial<Record<'a' | 'b', Slot>>
  shard?: Shard
  /** No slot parses: never release or fold on its account. */
  torn: boolean
  beat?: { mtimeMs: number; size: number; busy: boolean; detached?: boolean }
  /** Each slot's mtime as listed, parsed or not: a shard that never parses still ages. */
  listed: Partial<Record<'a' | 'b', number>>
  /** Its last sign of life: the heartbeat's mtime, or its newest slot's without one. */
  beatMs?: number
  /** Its files are gone from the folder; its events stay until another shard or a resolve covers them. */
  vanished?: boolean
  state: 'live' | 'ended'
}

/** Module state: it survives `/clear` but not a reload; `ensureLoaded` rebuilds it from disk. */
const newRuntime = () => ({
  /** The session id this module loaded for. */
  id: undefined as string | undefined,
  shard: undefined as Shard | undefined,
  /** Shards of ids that ended in this process, still to be flushed. */
  frozen: [] as Shard[],
  peers: new Map<string, Peer>(),
  merged: { live: new Map(), gone: new Map() } as MergeResult,
  /** Blob text by SHA, and SHA by text. */
  texts: new Map<string, string>(),
  shaOf: new Map<string, string>(),
  /** Texts still to hash, by `<session>\0<gitKey>`. */
  pending: new Map<string, { original?: string | null; seen?: string | null }>(),
  /** What each event was last written as, for writes that can't wait for hashing. */
  written: new Map<string, Event>(),
  releases: new Set<string>(),
  tree: { known: false, sha: null as string | null, shas: new Set<string>() },
  canRead: true,
  canWrite: true,
  writeFailures: 0,
  retryAt: 0,
  dirty: false,
  /** Texts still to hash after a failure or while git backs off. */
  hashPending: false,
  treeDirty: false,
  loading: undefined as Promise<void> | undefined,
  polling: false,
  busy: false,
  /** Ticks left during which a peer counts as mid-write. */
  quietTicks: 0,
  lastBeat: 0,
  lastAt: 0,
  branch: '',
  instance: '',
  secondWindow: false,
  /** This process's own files as it last wrote them: anything else there was written by another process. */
  ownFiles: new Map<string, { mtimeMs: number; size: number }>(),
  /** Blobs that couldn't be fetched, by SHA: when to try again. */
  failedShas: new Map<string, number>(),
  /** Peer entries left out because the list would pass `$.state`'s cap; said once per load. */
  overCap: false,
  /** The session id this process last cleared its list for. */
  clearedFor: undefined as string | undefined,
  /** Set while session.end flushes: the bound its git work must fit in. */
  endBudget: undefined as NextBudget | undefined,
})
const rt = newRuntime()

let lock: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn)
  lock = run.catch(() => {})
  return run
}

async function nextAt($: $): Promise<number> {
  rt.lastAt = Math.max(await $.clock.now(), rt.lastAt + 1)
  return rt.lastAt
}

const pendingKey = (session: string, gitKey: string) => `${session}\0${gitKey}`
const sessionOfPending = (key: string) => key.slice(0, key.indexOf('\0'))

/** Records Claude's change to `entry` in this session's shard. */
function recordLive(c: Ctx, entry: Tracked, me: string, epoch?: number): void {
  const shard = rt.shard
  if (!shard || !entry.gitRel || entry.sessionOnly) return
  const gitKey = gitKeyOf(c, entry.gitRel)
  const prev = shard.entries[gitKey]
  const originalSha = entry.original === null ? null : rt.shaOf.get(entry.original)
  const seenSha = entry.lastSeenByClaude === null ? null : rt.shaOf.get(entry.lastSeenByClaude)
  const event: Event = {
    at: entry.at ?? rt.lastAt,
    by: me,
    owner: entry.owner ?? me,
    rel: entry.gitRel,
    branch: entry.branch ?? rt.branch,
    // A record replacing this session's own resolve keeps cutting off everything before it,
    // or another shard's older record of the file would come back with its pre-resolve original.
    ...(() => {
      const cut = Math.max(epoch ?? -Infinity, prev?.gone ? prev.at : -Infinity, prev?.epoch ?? -Infinity)
      return cut > -Infinity ? { epoch: cut } : {}
    })(),
    added: entry.added,
    removed: entry.removed,
    ...(entry.isDeleted ? { isDeleted: true as const } : {}),
    ...(entry.createdDirs?.length && persistOn(c)
      ? { createdDirs: entry.createdDirs.map(d => gitRelOf(c, slash(d).slice(c.cwd.length + 1))) }
      : {}),
  }
  const waiting: { original?: string | null; seen?: string | null } = {}
  if (originalSha !== undefined) event.original = originalSha
  else waiting.original = entry.original
  if (seenSha !== undefined) event.seen = seenSha
  else waiting.seen = entry.lastSeenByClaude
  if ('original' in waiting || 'seen' in waiting) rt.pending.set(pendingKey(shard.session, gitKey), waiting)
  else rt.pending.delete(pendingKey(shard.session, gitKey))
  shard.entries[gitKey] = event
  rt.dirty = true
}

/** Records that this session resolved `entry`, and releases its originals. */
function recordGone(c: Ctx, entry: Tracked, me: string, at: number, reason: GoneReason, rejectKind?: RejectKind): void {
  const shard = rt.shard
  if (!shard || !entry.gitRel) return
  const gitKey = gitKeyOf(c, entry.gitRel)
  const prev = shard.entries[gitKey]
  for (const sha of [prev?.original, prev?.seen]) if (sha) rt.releases.add(sha)
  for (const text of [entry.original, entry.lastSeenByClaude]) {
    const sha = text === null ? undefined : rt.shaOf.get(text)
    if (sha) rt.releases.add(sha)
  }
  rt.pending.delete(pendingKey(shard.session, gitKey))
  shard.entries[gitKey] = {
    at,
    by: me,
    owner: entry.owner ?? me,
    rel: entry.gitRel,
    branch: entry.branch ?? rt.branch,
    gone: true,
    goneReason: reason,
    ...(rejectKind ? { rejectKind } : {}),
  }
  rt.dirty = true
}

/** Records that this session found a merged entry resolved (back at its original), releasing its originals. */
function recordGoneMerged(c: Ctx, m: Merged, me: string, at: number): void {
  const shard = rt.shard
  if (!shard) return
  for (const sha of [m.original, m.seen]) if (sha) rt.releases.add(sha)
  shard.entries[gitKeyOf(c, m.rel)] = { at, by: me, owner: m.owner, rel: m.rel, branch: m.branch, gone: true, goneReason: 'settled' }
  rt.dirty = true
}

/** With persistence off, remembers the resolve so turning it back on tombstones it (and nothing else). */
async function noteResolvedWhileOff($: $, c: Ctx, entry: Tracked): Promise<void> {
  if (!c.git || options.persistAcrossSessions !== false) return
  const gitKey = gitKeyOf(c, `${c.git.prefix}${entry.rel}`)
  const at = await $.clock.now()
  await update($, resolvedWhileOff, all => ({ ...all, [gitKey]: { at, rel: `${c.git!.prefix}${entry.rel}` } }))
}

async function git($: $, c: Ctx, args: string[], stdin?: string) {
  return $.process.run(['git', ...args], { cwd: c.gitRoot ?? c.cwd, ...(stdin !== undefined ? { stdin } : {}) })
}

/** Fetches blob texts into `rt.texts`, in as many `cat-file --batch` calls as the output cap needs. Returns the unreadable SHAs. */
async function fetchTexts($: $, c: Ctx, shas: Iterable<string>): Promise<Set<string>> {
  const failed = new Set<string>()
  const now = await $.clock.now()
  let want = [...new Set(shas)].filter(sha => {
    if (rt.texts.has(sha)) return false
    // A blob that couldn't be fetched isn't asked for again until its backoff passes.
    if ((rt.failedShas.get(sha) ?? 0) > now) {
      failed.add(sha)
      return false
    }
    return true
  })
  while (want.length > 0) {
    const { exitCode, stdout, isStdoutTruncated } = await git($, c, ['cat-file', '--batch'], `${want.join('\n')}\n`)
    if (exitCode !== 0) {
      for (const sha of want) failed.add(sha)
      break
    }
    const { blobs, missing, read: count } = parseCatFileBatch(stdout)
    for (const [sha, text] of blobs) {
      rt.texts.set(sha, text)
      rt.shaOf.set(text, sha)
    }
    for (const sha of missing) failed.add(sha)
    if (count === 0) {
      // The first blob alone overflows the output: it can't come back this way.
      failed.add(want[0]!)
      want = want.slice(1)
      continue
    }
    want = want.slice(count)
    if (!isStdoutTruncated) {
      for (const sha of want) if (!rt.texts.has(sha)) failed.add(sha)
      break
    }
  }
  for (const sha of failed) if (!rt.failedShas.has(sha) || rt.failedShas.get(sha)! <= now) rt.failedShas.set(sha, now + 30_000)
  return failed
}

/** Hashes texts with no SHA yet, through one `hash-object` over files staged outside the review copies. */
async function hashTexts($: $, c: Ctx & { git: GitCtx }, texts: (string | null)[]): Promise<void> {
  const todo = [...new Set(texts.filter((t): t is string => t !== null && !rt.shaOf.has(t)))].filter(
    t => byteLength(t) <= BLOB_CAP,
  )
  if (todo.length === 0) return
  const dir = `${c.tmpRoot}/${c.sessionId}.blobs/${await nextAt($)}`
  const paths: string[] = []
  for (const [i, text] of todo.entries()) {
    const path = `${dir}/${i}`
    await $.fs.write(path, text)
    paths.push(native(path, c.isWindows))
  }
  try {
    const { exitCode, stdout } = await git($, c, ['hash-object', '-w', '--no-filters', '--stdin-paths'], `${paths.join('\n')}\n`)
    if (exitCode !== 0) throw new Error('hash-object failed')
    const shas = stdout.trim().split('\n')
    if (shas.length !== todo.length) throw new Error('hash-object answered short')
    todo.forEach((text, i) => {
      rt.shaOf.set(text, shas[i]!)
      rt.texts.set(shas[i]!, text)
    })
  } finally {
    await removePath($, c, dir, c.tmpRoot).catch(() => {})
  }
}

/** The event as it can be written now: pending SHAs fall back to the last written ones, or it waits. */
function writable(session: string, gitKey: string, event: Event): Event | undefined {
  if (event.gone) return event
  if (event.original !== undefined && event.seen !== undefined) return event
  const last = rt.written.get(pendingKey(session, gitKey))
  if (!last || last.gone) return undefined
  return {
    ...event,
    original: event.original !== undefined ? event.original : last.original,
    seen: event.seen !== undefined ? event.seen : last.seen,
  }
}

/** Writes a shard to its next slot. The lock keeps the slot and `seq` of concurrent writers apart. */
async function writeShard($: $, c: Ctx & { git: GitCtx }, shard: Shard): Promise<void> {
  // A second window never writes the shard it shares with the first: that record is the first window's.
  if (rt.secondWindow && shard.session === (await $.session.id())) return
  await withLock(async () => {
    const entries: Record<string, Event> = {}
    for (const [gitKey, event] of Object.entries(shard.entries)) {
      const out = writable(shard.session, gitKey, event)
      if (out) entries[gitKey] = out
    }
    shard.seq++
    const { v, seq, session, instance, endedAt, endReason } = shard
    const body = { v, seq, session, instance, ...(endedAt !== undefined ? { endedAt, endReason } : {}), entries }
    const path = `${c.git.shardDir}/${session}.${slotOf(seq)}.json`
    await $.fs.write(path, JSON.stringify(body))
    if (session === rt.shard?.session) await rememberOwn($, path)
    for (const [gitKey, event] of Object.entries(entries)) rt.written.set(pendingKey(session, gitKey), event)
  })
}

/** Notes how this process left one of its own files, so a write by another process shows. */
async function rememberOwn($: $, path: string): Promise<void> {
  const { mtimeMs, size } = await $.fs.stat(path)
  rt.ownFiles.set(path.slice(path.lastIndexOf('/') + 1), { mtimeMs, size })
}

/** When an instance was made: its id carries the time, base 36. Unknown is oldest. */
const instanceSince = (instance: string) => parseInt(instance.split('-')[1] ?? '', 36) || 0

/**
 * Another process writes under this session id (a second window). The one
 * started later yields: it goes session-only and says so.
 */
function foreignWriter($: $, other: string): void {
  if (rt.secondWindow || other === rt.instance) return
  const mine = instanceSince(rt.instance)
  const theirs = instanceSince(other)
  if (theirs > mine || (theirs === mine && other > rt.instance)) return // They're the later one: they yield.
  rt.secondWindow = true
  rt.canRead = false
  rt.canWrite = false
  $.ui.toast("This session is open in another window too; pending changes here aren't shared.", { timeoutMs: 8000 })
}

/** Backs off a failed write step, and tells peers this session is detached after five in a row. */
async function writeFailed($: $): Promise<void> {
  rt.writeFailures++
  rt.retryAt = (await $.clock.now()) + Math.min(60_000, POLL_MS * 2 ** (rt.writeFailures - 1))
}

let flushRun: Promise<void> | undefined
let flushAgain = false

/** Hashes, writes and pins what changed. Single-flight: a call during a run gets one more run. */
function flush($: $): Promise<void> {
  if (flushRun) {
    flushAgain = true
    return flushRun
  }
  flushRun = (async () => {
    do {
      flushAgain = false
      await flushOnce($)
    } while (flushAgain)
  })()
    .catch(() => {})
    .finally(() => {
      flushRun = undefined
    })
  return flushRun
}

async function flushOnce($: $): Promise<void> {
  const c = await ctx($)
  if (!persistOn(c) || !rt.canRead || !rt.canWrite) return
  const now = await $.clock.now()
  // Git work backs off after a failure; writing the shards never waits, so resolves always land.
  const gitDue = now >= rt.retryAt && !(rt.endBudget && rt.endBudget.remainingMs < 500)
  // This session's own shard is written only once it has loaded for its id: never from an empty list.
  const own = rt.shard && rt.id === rt.shard.session && !rt.loading ? [rt.shard] : []
  const shards = [...rt.frozen, ...own]
  const hashDue = rt.hashPending && gitDue
  if (!rt.dirty && !hashDue && !rt.treeDirty && rt.releases.size === 0) return
  let failed = false
  if (rt.dirty || hashDue) {
    rt.dirty = false
    rt.hashPending = false
    // 1. Hash what's waiting, on its own: a failure here mustn't keep accepts and rejects off disk.
    const texts: (string | null)[] = []
    for (const shard of shards) {
      for (const gitKey of Object.keys(shard.entries)) {
        const waiting = rt.pending.get(pendingKey(shard.session, gitKey))
        if (waiting?.original !== undefined) texts.push(waiting.original)
        if (waiting?.seen !== undefined) texts.push(waiting.seen)
      }
    }
    if (texts.length > 0) {
      if (!gitDue) rt.hashPending = true
      else {
        try {
          await hashTexts($, c, texts)
        } catch {
          failed = true
          rt.hashPending = true
        }
      }
    }
    for (const shard of shards) {
      for (const [gitKey, event] of Object.entries(shard.entries)) {
        const key = pendingKey(shard.session, gitKey)
        const waiting = rt.pending.get(key)
        if (!waiting) continue
        // A text too large to come back through cat-file stays session-only.
        const tooBig = [waiting.original, waiting.seen].some(t => typeof t === 'string' && byteLength(t) > BLOB_CAP)
        if (tooBig) {
          rt.pending.delete(key)
          delete shard.entries[gitKey]
          await markSessionOnly($, c, event.rel)
          continue
        }
        let left = false
        for (const field of ['original', 'seen'] as const) {
          if (!(field in waiting)) continue
          const text = waiting[field]!
          const sha = text === null ? null : rt.shaOf.get(text)
          if (sha === undefined) left = true
          else {
            event[field] = sha
            delete waiting[field]
          }
        }
        if (left) rt.hashPending = true
        else rt.pending.delete(key)
      }
    }
    // 2. The shards: what's still waiting for a SHA goes as it was last written, or waits.
    try {
      for (const shard of shards) await writeShard($, c, shard)
      // An ended shard is done once nothing of it waits for a SHA.
      const waitingFor = new Set([...rt.pending.keys()].map(sessionOfPending))
      rt.frozen = rt.frozen.filter(s => waitingFor.has(s.session))
      rt.treeDirty = true
    } catch {
      failed = true
      rt.dirty = true
    }
  }
  // 3. The tree.
  if (gitDue && (rt.treeDirty || rt.releases.size > 0)) {
    try {
      if (!(await updateTree($, c, false))) failed = true
    } catch {
      failed = true
    }
  }
  if (failed) await writeFailed($)
  else if (!rt.hashPending) rt.writeFailures = 0
}

async function markSessionOnly($: $, c: Ctx, gitRel: string): Promise<void> {
  if (!persistOn(c)) return
  const key = keyOf(pathOfGitRel(c, gitRel), c.isWindows)
  await update($, files, all => (all[key] ? { ...all, [key]: { ...all[key]!, sessionOnly: true } } : all))
}

/** Every SHA a shard references. */
function shasOf(shards: readonly Shard[]): Set<string> {
  const out = new Set<string>()
  for (const shard of shards) {
    for (const event of Object.values(shard.entries)) {
      if (event.original) out.add(event.original)
      if (event.seen) out.add(event.seen)
    }
  }
  return out
}

async function readTree($: $, c: Ctx & { git: GitCtx }): Promise<void> {
  const head = await git($, c, ['rev-parse', '-q', '--verify', c.git.ref])
  const sha = head.exitCode === 0 ? head.stdout.trim() : null
  const shas = new Set<string>()
  if (sha) {
    const listed = await git($, c, ['ls-tree', sha])
    if (listed.exitCode !== 0) throw new Error('ls-tree failed')
    for (const s of parseLsTree(listed.stdout)) shas.add(s)
  }
  rt.tree = { known: true, sha, shas }
}

/**
 * Moves the worktree's ref to a tree of every SHA in use. A normal update adds
 * this session's SHAs to the current tree and removes only what it released and
 * nothing uses; a rebuild pins exactly the merged set. Compare-and-swap, three
 * tries, then it waits for the next tick.
 */
async function updateTree($: $, c: Ctx & { git: GitCtx }, rebuild: boolean): Promise<boolean> {
  if (rt.endBudget && rt.endBudget.remainingMs < 500) {
    rt.treeDirty = true
    return true
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!rt.tree.known) await readTree($, c)
    // What this attempt releases, taken before the sync so the merge already holds each one's resolve.
    // A release recorded while git runs belongs to the next attempt.
    const releasing = new Set(rt.releases)
    await syncPeers($, c)
    const settled = () => {
      for (const sha of releasing) rt.releases.delete(sha)
      if (rt.releases.size === 0) rt.treeDirty = false
    }
    const anyTorn = [...rt.peers.values()].some(p => p.torn)
    const inUse = new Set<string>()
    for (const m of rt.merged.live.values()) {
      if (m.original) inUse.add(m.original)
      if (m.seen) inUse.add(m.seen)
    }
    const own = shasOf([...rt.frozen, ...(rt.shard ? [rt.shard] : [])])
    for (const peer of rt.peers.values()) for (const s of shasOf(peer.shard ? [peer.shard] : [])) inUse.add(s)
    let want: Set<string>
    if (rebuild && !anyTorn) {
      want = new Set([...inUse, ...own])
    } else {
      want = new Set([...rt.tree.shas, ...own])
      if (!anyTorn) for (const sha of releasing) if (!inUse.has(sha) && !own.has(sha)) want.delete(sha)
    }
    const same = want.size === rt.tree.shas.size && [...want].every(s => rt.tree.shas.has(s))
    if (same && (rt.tree.sha !== null || want.size === 0)) {
      settled()
      return true
    }
    const made = await git($, c, ['mktree', '--missing'], treeInput(want))
    if (made.exitCode !== 0) throw new Error('mktree failed')
    const tree = made.stdout.trim()
    const swap = await git($, c, ['update-ref', c.git.ref, tree, rt.tree.sha ?? zeroId(c.git.objectFormat)])
    if (swap.exitCode === 0) {
      rt.tree = { known: true, sha: tree, shas: want }
      settled()
      return true
    }
    if (/Unable to create '.*\.lock'/.test(swap.stderr)) {
      // A writer killed mid-update left its lock: back off (the caller counts the failure), and
      // reconcile removes the lock once it's old.
      rt.treeDirty = true
      return false
    }
    rt.tree.known = false // Lost the swap: re-read and try again.
  }
  rt.treeDirty = true
  return true
}

async function readBranch($: $, c: Ctx & { git: GitCtx }): Promise<string> {
  const read1 = async (p: string) => ((await $.fs.exists(p)) ? await $.fs.read(p) : null)
  const rebase =
    (await read1(`${c.git.gitDir}/rebase-merge/head-name`)) ?? (await read1(`${c.git.gitDir}/rebase-apply/head-name`))
  return branchOf(await read1(`${c.git.gitDir}/HEAD`), rebase)
}

/** Writes this session's heartbeat: the file's mtime is the beat, its content says whether a tool is mid-write. */
async function beat($: $, c: Ctx): Promise<void> {
  if (!persistOn(c) || !rt.canRead || !rt.shard || rt.shard.endedAt !== undefined || rt.secondWindow) return
  try {
    const detached = rt.writeFailures >= 5
    const path = `${c.git.shardDir}/${rt.shard.session}.alive`
    await $.fs.write(path, JSON.stringify({ busy: rt.busy, instance: rt.instance, ...(detached ? { detached } : {}) }))
    await rememberOwn($, path)
    rt.lastBeat = await $.clock.now()
  } catch {
    rt.canRead = false // Can't even say it's alive: session-only from here.
  }
}

async function clearBusyIfIdle($: $): Promise<void> {
  if (toolsInFlight > 0 || flushRun || !rt.busy) return
  rt.busy = false
  await beat($, await ctx($))
}

/** A read that may fail without failing the sync. */
async function readQuiet($: $, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

/**
 * Reads the shards that changed since the last call, merges every session's,
 * and applies the result to this session's list.
 */
async function syncPeers($: $, c: Ctx, opts: { prevBeat?: number; loading?: boolean } = {}): Promise<void> {
  if (!persistOn(c) || !rt.canRead || !rt.shard) return
  const me = rt.shard.session
  const now = await $.clock.now()
  const dir = c.git.shardDir
  const listed = (await $.fs.exists(dir)) ? await $.fs.list(dir) : []
  const seen = new Set<string>()
  let ownListed = false
  for (const entry of listed) {
    const shardMatch = /^(.+)\.(a|b)\.json$/.exec(entry.name)
    const aliveMatch = /^(.+)\.alive$/.exec(entry.name)
    const id = shardMatch?.[1] ?? aliveMatch?.[1]
    if (!id) continue
    if (id === me) {
      if (shardMatch) ownListed = true
      const mine = rt.ownFiles.get(entry.name)
      if (mine && mine.mtimeMs === entry.mtimeMs && mine.size === entry.size) continue
      rt.ownFiles.set(entry.name, { mtimeMs: entry.mtimeMs, size: entry.size })
      const text = await readQuiet($, `${dir}/${entry.name}`)
      const writer = text === undefined ? undefined : (shardMatch ? parseShard(text) : parseHeartbeat(text))?.instance
      if (writer) foreignWriter($, writer)
      if (rt.secondWindow) return
      continue
    }
    seen.add(id)
    const peer: Peer = rt.peers.get(id) ?? { slots: {}, listed: {}, torn: false, state: 'live' }
    peer.vanished = false
    rt.peers.set(id, peer)
    if (shardMatch) {
      const slot = shardMatch[2] as 'a' | 'b'
      peer.listed[slot] = entry.mtimeMs
      const known = peer.slots[slot]
      if (!known || known.mtimeMs !== entry.mtimeMs || known.size !== entry.size) {
        // A read that fails (a sharing violation mid-write) counts as torn.
        const text = await readQuiet($, `${dir}/${entry.name}`)
        const parsed = text === undefined ? undefined : parseShard(text)
        // A torn read keeps the last good copy, and its mtime isn't marked seen, so the next tick reads it again.
        if (parsed) peer.slots[slot] = { mtimeMs: entry.mtimeMs, size: entry.size, shard: parsed }
        else if (!known) peer.slots[slot] = { mtimeMs: -1, size: -1 }
      }
    } else {
      const known = peer.beat
      if (!known || known.mtimeMs !== entry.mtimeMs || known.size !== entry.size) {
        const text = await readQuiet($, `${dir}/${entry.name}`)
        const parsed = text === undefined ? undefined : parseHeartbeat(text)
        if (parsed) peer.beat = { mtimeMs: entry.mtimeMs, size: entry.size, busy: parsed.busy, ...(parsed.detached ? { detached: true } : {}) }
        else if (known) peer.beat = { ...known, mtimeMs: entry.mtimeMs }
        else peer.beat = { mtimeMs: entry.mtimeMs, size: -1, busy: false }
      }
    }
  }
  if (!ownListed && rt.shard.seq > 0) rt.dirty = true // Someone removed this session's shard: write it again.

  const asleep = opts.prevBeat !== undefined && opts.prevBeat > 0 && now - opts.prevBeat > STALE_MS
  for (const [id, peer] of rt.peers) {
    if (!seen.has(id)) peer.vanished = true
    const parsed = [peer.slots.a?.shard, peer.slots.b?.shard].filter((s): s is Shard => s !== undefined)
    peer.shard = parsed.sort((x, y) => y.seq - x.seq)[0] ?? peer.shard
    peer.torn = !peer.vanished && parsed.length === 0
    const slotTimes = [peer.listed.a, peer.listed.b].filter((m): m is number => m !== undefined)
    peer.beatMs = peer.beat?.mtimeMs ?? (slotTimes.length > 0 ? Math.max(...slotTimes) : undefined)
    if (!asleep) peer.state = liveness(peer.beatMs, peer.shard?.endedAt, now)
  }
  // A reject recorded for a live owner that ended (or was folded away) without reading it:
  // this Claude is told instead, once. Checked before vanished shards are pruned, while their last records are known.
  for (const [gitKey, event] of Object.entries(rt.shard.entries)) {
    if (!event.gone || event.goneReason !== 'rejected' || event.by !== me || event.rerouted || event.owner === me) continue
    const owner = rt.peers.get(event.owner)
    const theirs = owner?.shard?.entries[gitKey]
    if (!owner || (owner.state !== 'ended' && !owner.vanished) || !theirs || theirs.gone || theirs.at >= event.at) continue
    event.rerouted = true
    rt.dirty = true
    const rel = slash(pathOfGitRel(c, event.rel)).slice(c.cwd.length + 1)
    await queueNotice($, rejectNote(rel, event.rejectKind ?? 'change'))
  }

  // A vanished shard's events stay until another shard or a resolve covers them.
  for (const [id, peer] of rt.peers) {
    if (!peer.vanished || !peer.shard) {
      if (peer.vanished) rt.peers.delete(id)
      continue
    }
    const others = [rt.shard, ...[...rt.peers.values()].filter(p => p !== peer && !p.vanished).map(p => p.shard)]
    for (const [key, event] of Object.entries(peer.shard.entries)) {
      if (others.some(s => s?.entries[key] && s.entries[key]!.at >= event.at)) delete peer.shard.entries[key]
    }
    if (Object.keys(peer.shard.entries).length === 0) rt.peers.delete(id)
  }

  const peerShards = [...rt.peers.values()].map(p => p.shard).filter((s): s is Shard => s !== undefined)
  rt.merged = mergeShards([rt.shard, ...peerShards])
  // A resolve elsewhere closes this session's own record of that path.
  for (const [gitKey, event] of Object.entries(rt.shard.entries)) {
    const gone = rt.merged.gone.get(gitKey)
    if (!event.gone && gone && gone.by !== me && gone.at > event.at) {
      delete rt.shard.entries[gitKey]
      rt.pending.delete(pendingKey(me, gitKey))
      rt.dirty = true
    }
  }
  if (pruneTombstones(rt.shard, peerShards, now)) rt.dirty = true

  const busyPeer = [...rt.peers.values()].some(p => p.state === 'live' && p.beat?.busy)
  if (busyPeer) rt.quietTicks = 2

  const states: Record<string, 'live' | 'ended'> = { [me]: 'live' }
  for (const [id, peer] of rt.peers) states[id] = peer.state
  const prior = await read($, sessions)
  if (JSON.stringify(prior) !== JSON.stringify(states)) await update($, sessions, () => states)

  await applyMerged($, c, me, opts.loading === true)
}

/** Brings this session's list in line with the merged records: peer changes, handovers, and resolves made elsewhere. */
async function applyMerged($: $, c: Ctx & { git: GitCtx; gitRoot: string }, me: string, loading: boolean): Promise<void> {
  const now = await read($, files)
  const known = await read($, knows)
  const states = await read($, sessions)
  const live = (id: string | undefined) => id !== undefined && id !== me && states[id] === 'live'
  let outsideCount = 0
  const fetch: string[] = []
  const changes: [string, Merged][] = []
  /** This session recorded the file, but another recorded it first: its original is the real one. */
  const adopt: [string, Merged][] = []
  for (const [gitKey, m] of rt.merged.live) {
    const path = pathOfGitRel(c, m.rel)
    if (!isInside(path, c.cwd, c.isWindows)) {
      outsideCount++
      continue
    }
    const key = keyOf(path, c.isWindows)
    const cur = now[key]
    if (m.by === me && cur) {
      const own = rt.shard?.entries[gitKey]
      if (own && !own.gone && own.at > m.firstAt) {
        adopt.push([gitKey, m])
        if (m.original) fetch.push(m.original)
      }
      continue
    }
    if (cur && cur.at !== undefined && cur.at >= m.at && cur.owner === m.owner) continue
    changes.push([gitKey, m])
    for (const sha of [m.original, m.seen]) if (sha) fetch.push(sha)
  }
  const failed = changes.length + adopt.length > 0 ? await fetchTexts($, c, fetch) : new Set<string>()
  for (const [gitKey, m] of adopt) {
    if (m.original && failed.has(m.original)) continue
    const original = m.original ? rt.texts.get(m.original)! : null
    const key = keyOf(pathOfGitRel(c, m.rel), c.isWindows)
    const cur = (await read($, files))[key]
    if (!cur || cur.original === original) continue
    let current: string | null
    try {
      current = await readOrNull($, cur.path)
    } catch {
      continue
    }
    const createdDirs = m.createdDirs?.length ? m.createdDirs.map(d => pathOfGitRel(c, d)) : undefined
    const { added, removed } = countChanges(original, current)
    await update($, files, all => {
      const prev = all[key]
      if (!prev) return all
      const next: Tracked = { ...prev, original, added, removed }
      if (createdDirs) next.createdDirs = createdDirs
      else delete next.createdDirs
      return { ...all, [key]: next }
    })
    const own = rt.shard?.entries[gitKey]
    if (own) {
      own.original = m.original
      if (m.createdDirs) own.createdDirs = m.createdDirs
      else delete own.createdDirs
      const waiting = rt.pending.get(pendingKey(me, gitKey))
      if (waiting) delete waiting.original
      rt.dirty = true
    }
  }
  const handovers: string[] = []
  // $.state holds one value up to STATE_CAP characters: leave out what would pass it, and say so once.
  let size = JSON.stringify(await read($, files)).length
  for (const [, m] of changes) {
    if ((m.original && failed.has(m.original)) || (m.seen && failed.has(m.seen))) continue
    const path = pathOfGitRel(c, m.rel)
    const key = keyOf(path, c.isWindows)
    const original = m.original ? rt.texts.get(m.original)! : null
    const seen = m.seen ? rt.texts.get(m.seen)! : null
    let current: string | null
    try {
      current = await readOrNull($, path)
    } catch {
      continue
    }
    if (current === original) {
      // Back at its original: on a load that re-settles it, so it drops off and releases its originals.
      if (loading) recordGoneMerged(c, m, me, await nextAt($))
      continue
    }
    const cur = (await read($, files))[key]
    if (cur && cur.owner === me && m.owner !== me && m.by !== me) {
      handovers.push(cur.rel)
      await update($, knows, all => ({ ...all, [key]: current }))
    }
    const growth = (original?.length ?? 0) + (seen?.length ?? 0) + path.length * 3 + 400
    if (!cur && size + growth > STATE_CAP) {
      if (!rt.overCap) $.ui.toast('Some pending files from other sessions are too large to list in this session.', { timeoutMs: 8000 })
      rt.overCap = true
      continue
    }
    size += growth
    const { added, removed } = countChanges(original, current)
    const rel = slash(path).slice(c.cwd.length + 1)
    const next: Tracked = {
      path,
      rel,
      original,
      ...(m.createdDirs?.length ? { createdDirs: m.createdDirs.map(d => pathOfGitRel(c, d)) } : {}),
      added,
      removed,
      lastSeenByClaude: m.owner === me && cur ? cur.lastSeenByClaude : seen,
      ...(current === null ? { isDeleted: true } : {}),
      ...(cur?.review ? { review: cur.review } : {}),
      owner: m.owner,
      gitRel: m.rel,
      at: m.at,
      branch: m.branch,
    }
    await update($, files, all => ({ ...all, [key]: next }))
  }
  for (const rel of handovers) await queueNotice($, note.handover(rel))

  // Resolves made elsewhere: drop the entry, and tell the Claude that owned it.
  for (const [key, entry] of Object.entries(await read($, files))) {
    if (!entry.gitRel) continue
    const gone = rt.merged.gone.get(gitKeyOf(c, entry.gitRel))
    if (!gone || gone.by === me || (entry.at !== undefined && gone.at < entry.at)) continue
    await forget($, key)
    await cleanupReview($, entry.review)
    if (entry.owner === me) {
      const text = goneNote(entry, gone)
      if (text) await queueNotice($, text)
    } else if (!live(entry.owner) && gone.goneReason === 'reverted' && key in known) {
      await queueNotice($, note.earlierReverted(entry.rel))
      await update($, knows, all => {
        const out = { ...all }
        delete out[key]
        return out
      })
    }
  }
  if ((await read($, outside)) !== outsideCount) await update($, outside, () => outsideCount)
}

/** The note a resolve made in another session sends this session's Claude, which owned the file. */
function goneNote(entry: Tracked, gone: Event): string | undefined {
  if (gone.goneReason === 'rejected') return rejectNote(entry.rel, gone.rejectKind ?? 'change')
  if (gone.goneReason === 'reverted') return revertNote(entry.rel)
  return undefined
}

const rejectNote = (rel: string, kind: RejectKind) =>
  kind === 'new'
    ? `The user rejected your new file \`${rel}\`: it has been deleted.`
    : kind === 'deletion'
      ? `The user rejected your deletion of \`${rel}\`: it has been restored.`
      : `The user rejected your changes to \`${rel}\`: it is back to its content from before you edited it. Re-read it before editing it again.`

const revertNote = (rel: string) =>
  `The user reverted all your changes to \`${rel}\`: it is back to its content from before you edited it. Re-read it before editing it again.`

/**
 * Loads the persisted list for the current session id, once per id and per load
 * of this module. Every hook goes through it before touching the list.
 */
async function ensureLoaded($: $): Promise<void> {
  const c = await ctx($)
  if (!persistOn(c) || !rt.canRead) return
  const id = await $.session.id()
  // An id whose session.end ran stays ended in this process: a refresh tick before the process
  // quits must not load it again, which would clear its end marker and beat for a session that's gone.
  if (endedIds.has(id)) return
  if (rt.loading) await rt.loading
  if (rt.id === id && (await read($, loadedFor)) === id) return
  rt.loading ??= load($, c, id).finally(() => {
    rt.loading = undefined
  })
  await rt.loading
}

async function load($: $, c: Ctx & { git: GitCtx; gitRoot: string }, id: string): Promise<void> {
  const fresh = (await read($, loadedFor)) !== id
  let instance = await read($, instanceAtom)
  if (!instance) {
    instance = `${id.slice(0, 8)}-${(await $.clock.now()).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    await update($, instanceAtom, () => instance)
  }
  rt.instance = instance
  if (rt.shard && rt.shard.session !== id && rt.shard.endedAt === undefined) {
    rt.frozen.push(rt.shard)
    rt.dirty = true
  }
  if (fresh && rt.clearedFor !== id) {
    // A new id (start, /clear): this process's old list belongs to the earlier id, which persisted it.
    // Once per id, before anything can return early: a load that runs again (a retry, a second
    // window taking over) must not clear what this id's Claude changed since.
    await update($, files, () => ({}))
    await update($, knows, () => ({}))
    await update($, outside, () => 0)
  }
  rt.clearedFor = id
  // Seed from this session's shard on disk: a reload must never rewrite it from an empty list.
  let seed: Shard | undefined
  for (const slot of ['a', 'b'] as const) {
    const path = `${c.git.shardDir}/${id}.${slot}.json`
    const parsed = (await $.fs.exists(path)) ? parseShard(await $.fs.read(path)) : undefined
    if (parsed && (!seed || parsed.seq > seed.seq)) seed = parsed
  }
  // A shard another process wrote is taken over here. If that process is still running (a second
  // window), it beats again within one refresh, and the sync's check makes the later one yield; a
  // fresh heartbeat alone can't tell it from a resume right after a crash.
  rt.shard = seed ? { ...seed, instance, entries: { ...seed.entries } } : { v: 1, seq: 0, session: id, instance, entries: {} }
  // Taking over a shard another process wrote (a resume, or a first window that stopped): claim it now.
  if (seed && seed.instance !== instance) rt.dirty = true
  for (const [gitKey, event] of Object.entries(rt.shard.entries)) rt.written.set(pendingKey(id, gitKey), event)
  if (rt.shard.endedAt !== undefined) {
    // A resumed session is live again.
    delete rt.shard.endedAt
    delete rt.shard.endReason
    rt.dirty = true
  }
  rt.id = id
  rt.peers.clear()
  rt.tree.known = false
  rt.branch = await readBranch($, c)
  if ((await read($, branchNow)) !== rt.branch) await update($, branchNow, () => rt.branch)
  // What this session's files look like now: only a write made after this load is another window's.
  rt.ownFiles.clear()
  if (await $.fs.exists(c.git.shardDir)) {
    for (const e of await $.fs.list(c.git.shardDir)) {
      if (e.name.startsWith(`${id}.`)) rt.ownFiles.set(e.name, { mtimeMs: e.mtimeMs, size: e.size })
    }
  }
  rt.overCap = false
  await beat($, c)
  if (rt.secondWindow) return
  // Turning persistence back on: tombstone what this session resolved while it was off, before the
  // merge, so its own older records don't list those files again. Nothing else is touched.
  const whileOff = await read($, resolvedWhileOff)
  for (const [gitKey, { at, rel }] of Object.entries(whileOff)) {
    const ev = rt.shard.entries[gitKey]
    if (ev && ev.at > at) continue
    for (const sha of [ev?.original, ev?.seen]) if (sha) rt.releases.add(sha)
    rt.shard.entries[gitKey] = { at, by: id, owner: ev?.owner ?? id, rel, branch: ev?.branch ?? rt.branch, gone: true, goneReason: 'settled' }
    rt.dirty = true
  }
  if (Object.keys(whileOff).length > 0) await update($, resolvedWhileOff, () => ({}))

  // If the shared list is unreadable, the load fails and the next hook runs it again; meanwhile the
  // session carries on with its own list, which the load never clears twice.
  await syncPeers($, c, { loading: true })
  const me = id
  const fileNow = await read($, files)

  // Entries this session owns that the shard on disk lacks (a reload between a change and its flush).
  for (const entry of Object.values(fileNow)) {
    if (entry.owner !== me || entry.sessionOnly || !entry.gitRel) continue
    const ev = rt.shard.entries[gitKeyOf(c, entry.gitRel)]
    if (!ev || ev.gone || (entry.at !== undefined && ev.at < entry.at)) recordLive(c, entry, me)
  }

  // Re-settle every entry against its original: one back at it drops off.
  for (const [key, entry] of Object.entries(fileNow)) {
    let current: string | null
    try {
      current = await readOrNull($, entry.path)
    } catch {
      continue
    }
    if (current === entry.original) {
      await forget($, key)
      await cleanupReview($, entry.review)
      if (entry.gitRel) recordGone(c, entry, me, await nextAt($), 'settled')
    }
  }
  // The same for entries outside the cwd, which are only counted here.
  const outsideTexts: string[] = []
  const outsideEntries: Merged[] = []
  for (const m of rt.merged.live.values()) {
    if (isInside(pathOfGitRel(c, m.rel), c.cwd, c.isWindows)) continue
    outsideEntries.push(m)
    if (m.original) outsideTexts.push(m.original)
  }
  const failed = outsideTexts.length ? await fetchTexts($, c, outsideTexts) : new Set<string>()
  let outsideCount = 0
  for (const m of outsideEntries) {
    if (m.original && failed.has(m.original)) continue
    const original = m.original ? rt.texts.get(m.original)! : null
    let current: string | null
    try {
      current = await readOrNull($, pathOfGitRel(c, m.rel))
    } catch {
      outsideCount++
      continue
    }
    if (current === original) recordGoneMerged(c, m, me, await nextAt($))
    else outsideCount++
  }
  await update($, outside, () => outsideCount)

  // The resume note, once per session id.
  if (fresh && !(await read($, resumeNoted)).includes(id)) {
    const states = await read($, sessions)
    const earlier = Object.entries(await read($, files)).filter(([, f]) => f.owner && f.owner !== me && states[f.owner] !== 'live')
    if (earlier.length > 0) {
      await queueNotice($, note.resume(earlier.map(([, f]) => f.rel).sort()))
      const told: Record<string, string | null> = {}
      for (const [key, f] of earlier) {
        try {
          told[key] = await readOrNull($, f.path)
        } catch {
          // Unreadable now: not compared later.
        }
      }
      await update($, knows, all => ({ ...all, ...told }))
    }
    await update($, resumeNoted, list => [...list, id])
  }
  await update($, loadedFor, () => id)
  if (rt.dirty) void flush($)
  // Housekeeping after every load: a start, a reload, and the id switch of a /clear.
  void reconcile($)
}

/**
 * Housekeeping after a load, never awaited: rebuild the tree, delete the refs
 * of worktrees that are gone, fold in ended sessions, clear leftovers.
 */
async function reconcile($: $): Promise<void> {
  const c = await ctx($)
  if (!persistOn(c) || !rt.canRead || !rt.canWrite || !rt.shard) return
  const now = await $.clock.now()
  const dir = c.git.shardDir
  try {
    await syncPeers($, c)
    // Fold in ended sessions: write this shard first, then delete theirs.
    const others = () => [...rt.peers.values()].map(p => p.shard).filter((s): s is Shard => s !== undefined)
    const toDelete: string[] = []
    for (const [id, peer] of rt.peers) {
      if (peer.vanished) continue
      const beatMs = peer.beatMs
      if (peer.torn) {
        if (beatMs !== undefined && now - beatMs > FOLD_MS) toDelete.push(id)
        continue
      }
      if (!peer.shard || !isFoldable(beatMs, peer.shard.endedAt, now)) continue
      if (foldIn(rt.shard, peer.shard, others().filter(s => s !== peer.shard))) {
        for (const [gitKey, event] of Object.entries(rt.shard.entries)) {
          if (event.original === undefined || event.seen === undefined) continue
          rt.written.set(pendingKey(rt.shard.session, gitKey), event)
        }
        rt.dirty = true
      }
      toDelete.push(id)
    }
    if (toDelete.length > 0) {
      await writeShard($, c, rt.shard)
      for (const id of toDelete) {
        for (const name of [`${id}.a.json`, `${id}.b.json`, `${id}.alive`]) await removePath($, c, `${dir}/${name}`, dir)
        rt.peers.delete(id)
      }
    }
    // Heartbeats with no shard, left by a session that never wrote one.
    if (await $.fs.exists(dir)) {
      const listed = await $.fs.list(dir)
      const withShard = new Set(listed.map(e => /^(.+)\.(a|b)\.json$/.exec(e.name)?.[1]).filter(Boolean))
      for (const e of listed) {
        const id = /^(.+)\.alive$/.exec(e.name)?.[1]
        if (id && id !== rt.shard.session && !withShard.has(id) && now - e.mtimeMs > FOLD_MS) {
          await removePath($, c, `${dir}/${e.name}`, dir)
        }
      }
    }
    // Refs of worktrees whose git dir is gone.
    const refs = await git($, c, ['for-each-ref', '--format=%(refname)', `${REF_ROOT}/worktrees/`])
    if (refs.exitCode === 0 && refs.stdout.trim()) {
      const wtDir = `${c.git.commonDir}/worktrees`
      const names = (await $.fs.exists(wtDir)) ? (await $.fs.list(wtDir)).map(e => encodeWorktreeName(e.name)) : []
      for (const ref of refs.stdout.trim().split('\n')) {
        const name = ref.slice(`${REF_ROOT}/worktrees/`.length)
        if (!names.includes(name)) await git($, c, ['update-ref', '-d', ref])
      }
    }
    // Locks left by an update-ref that was killed.
    for (const lockDir of [`${c.git.commonDir}/${REF_ROOT}`, `${c.git.commonDir}/${REF_ROOT}/worktrees`]) {
      if (!(await $.fs.exists(lockDir))) continue
      for (const e of await $.fs.list(lockDir)) {
        if (e.name.endsWith('.lock') && now - e.mtimeMs > 5 * 60_000) await removePath($, c, `${lockDir}/${e.name}`, `${c.git.commonDir}/${REF_ROOT}`)
      }
    }
    await updateTree($, c, true)
    if (rt.dirty) await flush($)
  } catch {
    // Housekeeping only: the next start tries again.
  }
}

// ---------------------------------------------------------------- actions

async function accept($: $, key: string): Promise<void> {
  const entry = (await read($, files))[key]
  if (!entry) return
  const c = await ctx($)
  await forget($, key)
  await cleanupReview($, entry.review)
  if (persistOn(c)) {
    if (entry.gitRel) recordGone(c, entry, await $.session.id(), await nextAt($), 'accepted')
    void flush($)
  } else await noteResolvedWhileOff($, c, entry)
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
  const kind: RejectKind = entry.original === null ? 'new' : entry.isDeleted ? 'deletion' : 'change'
  const me = await $.session.id()
  // A live owner elsewhere hears of it from the resolve record; otherwise this Claude is told.
  const ownerElsewhere = persistOn(c) && entry.owner && entry.owner !== me && (await read($, sessions))[entry.owner] === 'live'
  if (!ownerElsewhere) await queueNotice($, rejectNote(entry.rel, kind))
  if (persistOn(c)) {
    if (entry.gitRel) recordGone(c, entry, me, await nextAt($), 'rejected', kind)
    void flush($)
  } else await noteResolvedWhileOff($, c, entry)
}

/**
 * Which record a row showed when drawn; an action on it is refused if another
 * session recorded a change since. Counts aren't part of it: the user's own edits move them.
 */
const stampOf = (f: Tracked | undefined) =>
  f ? `${f.at ?? ''}:${f.owner ?? ''}:${f.isDeleted ? 1 : 0}` : 'gone'

/** Runs ✓ or ✗ on the drawn rows, after catching up with other sessions. */
async function act($: $, drawn: [string, string][], fn: (key: string) => Promise<void>): Promise<void> {
  try {
    await ensureLoaded($)
    await syncPeers($, await ctx($))
  } catch {
    // Acting on what's listed here is still right.
  }
  const now = await read($, files)
  let changed: Tracked | undefined
  for (const [key, stamp] of drawn) {
    const entry = now[key]
    if (!entry) continue
    if (stampOf(entry) !== stamp) {
      changed ??= entry
      continue
    }
    await fn(key)
  }
  if (changed) $.ui.toast(`\`${changed.rel}\` changed in another session; check it again.`, { timeoutMs: 8000 })
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

/** The tracked files to act on, with their drawn stamps: all, or those under the folder `relDir`. */
function rowsUnder(all: [string, Tracked][], relDir?: string): [string, string][] {
  return all
    .filter(([, entry]) => relDir === undefined || entry.rel.startsWith(`${relDir}/`))
    .map(([key, entry]) => [key, stampOf(entry)])
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
  if (rt.polling) return
  rt.polling = true
  try {
    await pollOnce($)
  } finally {
    rt.polling = false
  }
}

async function pollOnce($: $): Promise<void> {
  const c = await ctx($)
  if (rt.secondWindow && persistOn(c)) await checkFirstWindow($, c)
  const prevBeat = rt.lastBeat
  // The heartbeat comes first: a long tool call must not make this session look ended.
  if (persistOn(c)) await beat($, c)
  if (toolsInFlight > 0) return
  if (persistOn(c)) {
    try {
      await ensureLoaded($)
      if (rt.quietTicks > 0) rt.quietTicks--
      await syncPeers($, c, { prevBeat })
      const branch = await readBranch($, c)
      if (branch !== rt.branch) {
        rt.branch = branch
        await update($, branchNow, () => branch)
      }
      if (rt.dirty || rt.treeDirty || rt.hashPending) void flush($)
    } catch {
      // The shared list is unreachable this tick; this session's own list still refreshes below.
    }
  }
  if (toolsInFlight > 0) return
  // While another session's Claude is mid-write, its changes aren't the user's: only update counts.
  const quiet = rt.quietTicks > 0
  const me = await $.session.id()
  const states = await read($, sessions)
  const all = await read($, files)
  for (const [key, entry] of Object.entries(all)) {
    try {
      const current = await readOrNull($, entry.path)
      if (toolsInFlight > 0) return
      // A new file the user emptied (every block reverted in the diff) is a rejection.
      // One Claude itself wrote empty stays.
      if (entry.original === null && current === '' && entry.lastSeenByClaude) {
        if (!quiet) await reject($, key)
        continue
      }
      const reason: GoneReason = current !== entry.lastSeenByClaude ? 'reverted' : 'settled'
      const { dropped } = await settle($, key, entry, current, undefined, { from: 'observed', reason, noDrop: quiet })
      if (!dropped) continue
      await cleanupReview($, dropped.review)
      if (current === dropped.lastSeenByClaude) continue
      const owner = dropped.owner
      if (!owner || owner === me) await queueNotice($, revertNote(dropped.rel))
      else if (states[owner] !== 'live' && key in (await read($, knows))) {
        await queueNotice($, note.earlierReverted(dropped.rel))
      }
    } catch {
      // One unreadable file must not stop the others from refreshing.
    }
  }
  if (persistOn(c) && rt.dirty) void flush($)
}

/** A second window takes over once the first stops beating (it closed, or it was a crash all along). */
async function checkFirstWindow($: $, c: Ctx & { git: GitCtx }): Promise<void> {
  const alive = `${c.git.shardDir}/${await $.session.id()}.alive`
  const beatMs = (await $.fs.exists(alive)) ? (await $.fs.stat(alive)).mtimeMs : undefined
  if (beatMs !== undefined && (await $.clock.now()) - beatMs <= STALE_MS) return
  rt.secondWindow = false
  rt.canRead = true
  rt.canWrite = true
  rt.id = undefined
}

async function sweepStale($: $, c: Ctx): Promise<void> {
  if (!(await $.fs.exists(c.tmpRoot))) return
  const now = await $.clock.now()
  for (const entry of await $.fs.list(c.tmpRoot)) {
    const path = `${c.tmpRoot}/${entry.name}`
    if (path === c.sessionDir) continue
    const { mtimeMs } = await $.fs.stat(path)
    if (now - mtimeMs > STALE_TEMP_MS) await removePath($, c, path, c.tmpRoot)
  }
}

// ---------------------------------------------------------------- shell commands
//
// Bash and PowerShell calls are bracketed by two `git status` runs: what moved
// between them is what the command changed, however it was written. Outside a
// git work tree only plain delete commands (`rm`, `del`, `Remove-Item`) are seen.

async function findGit($: $, cwd: string): Promise<{ gitRoot: string | null; git: GitCtx | null }> {
  try {
    const full = await $.process.run(
      [
        'git',
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-dir',
        '--git-common-dir',
        '--show-object-format',
        '--show-prefix',
      ],
      { cwd },
    )
    const lines = full.stdout.split('\n').map(l => l.trim())
    if (full.exitCode === 0 && lines[0] && lines[1] && lines[2]) {
      const gitDir = slash(lines[1])
      const commonDir = slash(lines[2])
      return {
        gitRoot: slash(lines[0]),
        git: {
          gitDir,
          commonDir,
          ref: refFor(gitDir, commonDir),
          objectFormat: lines[3] || 'sha1',
          prefix: lines[4] ?? '',
          shardDir: `${gitDir}/pending-changes`,
        },
      }
    }
    // Older git, without --path-format: shell tracking still works, persistence doesn't.
    const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
    return { gitRoot: exitCode === 0 && stdout.trim() ? slash(stdout.trim()) : null, git: null }
  } catch {
    return { gitRoot: null, git: null }
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
  /** When the command started: a peer's record of a file from after this is the peer's change. */
  startedAt: number
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
  return { dirty, before, startedAt: await $.clock.now() }
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

/** A peer recorded this path while the command ran, or holds it as the file now is: the change is the peer's. */
function peersChange(c: Ctx, path: string, current: string | null, since: number, me: string): boolean {
  if (!persistOn(c)) return false
  const m = rt.merged.live.get(gitKeyOf(c, gitRelOf(c, slash(path).slice(c.cwd.length + 1))))
  if (!m || m.by === me) return false
  if (m.at >= since) return true
  const seen = m.seen === null ? null : m.seen ? rt.texts.get(m.seen) : undefined
  return seen !== undefined && seen === current
}

/** A resolve elsewhere newer than `since`: the base picked before it is stale. */
function resolvedSince(c: Ctx, path: string, since: number, me: string): Event | undefined {
  if (!persistOn(c)) return undefined
  const gone = rt.merged.gone.get(gitKeyOf(c, gitRelOf(c, slash(path).slice(c.cwd.length + 1))))
  return gone && gone.by !== me && gone.at >= since ? gone : undefined
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

  // Other sessions may have changed or resolved files while the command ran.
  try {
    await syncPeers($, c)
  } catch {
    // Settle against what's known.
  }
  const me = await $.session.id()
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
    if (peersChange(c, path, current, snap.startedAt, me)) continue

    const gone = resolvedSince(c, path, snap.startedAt, me)
    const known = gone ? undefined : tracked[key]
    if (known) {
      const { dropped } = await settle($, key, known, current, current, { from: 'claude' })
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
    const { wasEmpty, dropped } = await settle($, key, { path, rel, original, createdDirs }, current, current, {
      from: 'claude',
      ...(gone ? { epoch: gone.at } : {}),
    })
    if (wasEmpty && !dropped && !rt.loading) void openUnasked($, CHANGED_HINT)
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

/** At session start, with files pending: open the pane, or with `openOnStart: toast` only say so. */
async function startDecision($: $): Promise<void> {
  const pending = Object.keys(await read($, files)).length
  if (pending === 0) return
  const hint = `${pending} file${pending === 1 ? '' : 's'} still pending review. Run /changes to see them.`
  if (options.openOnStart === 'toast') $.ui.toast(hint, { timeoutMs: 8000 })
  else void openUnasked($, hint)
}

/** Loads before a hook touches the list; a failure leaves the session on its own list. */
async function loaded($: $): Promise<void> {
  try {
    await ensureLoaded($)
  } catch {
    // Session-only this time.
  }
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, given) => {
  options = given

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'changes',
      description: 'Show the files Claude changed, to accept, reject or review',
    })
    ensurePolling($)
    void ctx($)
      .then(c => sweepStale($, c))
      .catch(() => {})
    // A session starting under an id that ended in this process (an in-process resume) is live again.
    endedIds.delete(await $.session.id())
    await loaded($)
    await startDecision($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    endedIds.add(e.sessionId)
    try {
      const c = await ctx($)
      // A second window leaves the shared record to the first: no end marker, no flush.
      if (persistOn(c) && rt.shard?.session === e.sessionId && !rt.secondWindow) {
        const ending = rt.shard
        ending.endedAt = await $.clock.now()
        ending.endReason = e.reason
        rt.frozen.push(ending)
        rt.dirty = true
        rt.shard = undefined
        rt.id = undefined
        // The end marker first, with what's already hashed; git work only with the time left.
        try {
          await writeShard($, c, ending)
        } catch {
          // The heartbeat going quiet will tell the others.
        }
        rt.endBudget = next.budget
        try {
          await flush($)
        } finally {
          rt.endBudget = undefined
        }
      }
      await removePath($, c, c.sessionDir, c.tmpRoot)
      await removePath($, c, `${c.tmpRoot}/${c.sessionId}.blobs`, c.tmpRoot)
    } catch {
      // Nothing to clean, or the host is going away.
    }
    ctxPromise = undefined
    return next(e)
  })

  // Test seam: stands in for a hot reload (module state reset, $.state kept, new options), which the
  // test kit can't drive. Never registered as a command, and inert unless PENDING_CHANGES_TEST is 1.
  on('command.run', { command: '__pending-changes-reload' }, async ($, e) => {
    if ((await $.env.get('PENDING_CHANGES_TEST')) !== '1') return { text: '' }
    pollTimer?.cancel()
    pollTimer = undefined
    Object.assign(rt, newRuntime())
    flushRun = undefined
    flushAgain = false
    lock = Promise.resolve()
    toolsInFlight = 0
    ctxPromise = undefined
    if (e.args) options = { ...options, ...(JSON.parse(e.args) as PluginOptions) }
    return { text: 'reloaded' }
  })

  on('command.run', { command: 'changes' }, async $ => {
    ensurePolling($)
    await loaded($)
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
    const command = e.tool === 'Bash' || e.tool === 'PowerShell' ? e.command : undefined
    const c = path !== undefined || command !== undefined ? await ctx($) : undefined
    const writesFile = path !== undefined && c !== undefined && isInside(path, c.cwd, c.isWindows)
    const mayWrite = command !== undefined && !isReadOnlyCommand(command)
    const isWriting = writesFile || mayWrite

    // Decide first, then catch up: the base must come from the persisted list and other sessions' latest.
    if (isWriting) toolsInFlight++
    try {
      let pickedAt = 0
      if (isWriting && c) {
        await loaded($)
        if (persistOn(c)) {
          try {
            await syncPeers($, c)
            if (!rt.busy) {
              rt.busy = true
              await beat($, c)
            }
          } catch {
            // Settle against what's known.
          }
        }
        pickedAt = await $.clock.now()
      }

      let tracked: { key: string; base: Base; before: string | null } | undefined
      if (writesFile && c) {
        const key = keyOf(path!, c.isWindows)
        const rel = slash(path!).slice(c.cwd.length + 1)
        const known = (await read($, files))[key]
        const before = await readOrNull($, path!)
        const original = known ? known.original : before
        const createdDirs = known ? known.createdDirs : original === null ? await missingDirs($, c, rel) : undefined
        tracked = { key, base: { path: path!, rel, original, createdDirs }, before }
      }

      // A shell command that may write: note what git sees as changed before it runs.
      let shell: { c: Ctx; snap: ShellSnapshot } | undefined
      if (mayWrite && c) {
        try {
          shell = { c, snap: await beforeShell($, c, command!) }
        } catch {
          // No snapshot: the command runs untracked.
        }
      }

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

      if (tracked && ran.isError !== true && c) {
        // A resolve elsewhere while the tool ran: the content before it is the new original.
        if (persistOn(c)) {
          try {
            await syncPeers($, c)
          } catch {
            // Settle against what's known.
          }
        }
        const me = await $.session.id()
        const gone = resolvedSince(c, tracked.base.path, pickedAt, me)
        const nowKnown = (await read($, files))[tracked.key]
        const base: Base =
          gone && !nowKnown
            ? {
                ...tracked.base,
                original: tracked.before,
                createdDirs: tracked.before === null ? await missingDirs($, c, tracked.base.rel) : undefined,
              }
            : tracked.base
        const current = await readOrNull($, base.path)
        const { wasEmpty, dropped } = await settle($, tracked.key, base, current, current, {
          from: 'claude',
          ...(gone ? { epoch: gone.at } : {}),
        })
        if (dropped) await cleanupReview($, dropped.review)
        if (wasEmpty && !dropped && !rt.loading) void openUnasked($, CHANGED_HINT)
      }

      // Deliver reverts the user made mid-turn with the next tool result.
      const queued = await read($, notices)
      if (queued.length === 0) return ran
      await update($, notices, () => [])
      return { ...ran, context: [...(ran.context ?? []), ...queued] }
    } finally {
      if (isWriting) {
        toolsInFlight--
        // Never awaited: the result doesn't wait for git. Busy clears once the shard is written.
        if (c && persistOn(c)) void flush($).then(() => clearBusyIfIdle($)).catch(() => {})
      }
    }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    ensurePolling($)
    await loaded($)
    const c = await ctx($)
    if (persistOn(c)) {
      try {
        await syncPeers($, c)
      } catch {
        // Report against what's known.
      }
    }
    const notes = [...(await read($, notices))]
    const me = await $.session.id()
    const states = await read($, sessions)
    const all = await read($, files)
    const known = await read($, knows)
    const seen: Record<string, string | null> = {}
    const told: Record<string, string | null> = {}
    // While another session's Claude is mid-write, its changes would read as the user's: hold the notes back.
    if (rt.quietTicks === 0) {
      for (const [key, entry] of Object.entries(all)) {
        const mine = !entry.owner || entry.owner === me
        if (!mine) {
          // A file from a session that has ended: tell this Claude if it was told about it.
          if (states[entry.owner!] === 'live' || !(key in known)) continue
          const current = await readOrNull($, entry.path)
          if (current === known[key]) continue
          notes.push(note.earlierModified(entry.rel))
          told[key] = current
          continue
        }
        const current = await readOrNull($, entry.path)
        if (current === entry.lastSeenByClaude) continue
        notes.push(
          current === null
            ? `The user deleted \`${entry.rel}\` after your last edit.`
            : `The user modified \`${entry.rel}\` after your last edit; re-read it before editing it again.`,
        )
        seen[key] = current
      }
    }
    if (notes.length === 0) return next(e)

    await update($, notices, () => [])
    if (Object.keys(told).length > 0) await update($, knows, all => ({ ...all, ...told }))
    await update($, files, now => {
      const out = { ...now }
      for (const [key, text] of Object.entries(seen)) {
        if (out[key]) out[key] = { ...out[key]!, lastSeenByClaude: text }
      }
      return out
    })
    if (persistOn(c) && Object.keys(seen).length > 0) {
      // The record carries what Claude was told, so a resume doesn't report it again.
      const now = await read($, files)
      for (const key of Object.keys(seen)) if (now[key]?.gitRel) recordLive(c, now[key]!, me)
      void flush($)
    }
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
    const elsewhere = await read($, outside)
    const footer =
      elsewhere > 0 ? <Text dimColor>{`${elsewhere} more pending outside this folder`}</Text> : null
    if (all.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No pending changes.</Text>
          {footer}
        </Box>
      )
    }

    const width = e.props.bodyColumns
    const closedDirs = new Set(await read($, collapsed))
    const added = all.reduce((sum, [, f]) => sum + f.added, 0)
    const removed = all.reduce((sum, [, f]) => sum + f.removed, 0)
    const me = await $.session.id()
    const states = await read($, sessions)
    const branch = await read($, branchNow)
    const tagsOf = (f: Tracked): string[] => {
      const tags: string[] = []
      // Owners folded away are no longer listed: anything not live is earlier. Only with persistence on (`me` listed).
      if (f.owner && f.owner !== me && states[me]) tags.push(states[f.owner] === 'live' ? 'other session' : 'earlier')
      if (f.branch && branch && f.branch !== branch) tags.push('other branch')
      return tags
    }

    return (
      <Box flexDirection="column">
        {treeRows(all, closedDirs).map(row => {
          const guide = row.guide ? <Text dimColor>{row.guide}</Text> : ''
          const added = row.kind === 'folder' ? row.node.added : row.file.added
          const removed = row.kind === 'folder' ? row.node.removed : row.file.removed
          const tags = row.kind === 'file' ? tagsOf(row.file) : []
          const tagText = tags.map(t => ` ${t}`).join('')
          const room = Math.max(8, width - row.guide.length - `+${added} -${removed}`.length - 25 - tagText.length)
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
            const under = rowsUnder(all, relDir)
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
                    onPress={() => void act($, under, key => accept($, key))}
                  />
                  <Button
                    key={`reject-dir-${id}`}
                    label="✗"
                    onPress={() => void act($, under, key => reject($, key))}
                  />
                </Box>
              </Box>
            )
          }

          const { key, file } = row
          const id = idOf(key)
          const status = statusOf(file)
          const drawn: [string, string][] = [[key, stampOf(file)]]
          return (
            <Box key={`row-${id}`} flexDirection="row" gap={1} hover={{ backgroundColor: ROW_HOVER }}>
              <Button key={`open-${id}`} plain onPress={() => void openReview($, key)}>
                {guide}
                <Text {...NAME_STYLE[status]}>{fit(row.name, room)}</Text>
                <Text color={STATUS_COLOR[status]}>{` ${status}`}</Text>
                {tags.length > 0 ? <Text dimColor>{tagText}</Text> : ''}
              </Button>
              {leader}
              <Box flexDirection="row" gap={1} flexShrink={0}>
                {counts}
                <Button key={`accept-${id}`} label="✓" onPress={() => void act($, drawn, k => accept($, k))} />
                <Button key={`reject-${id}`} label="✗" onPress={() => void act($, drawn, k => reject($, k))} />
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
              onPress={() => void act($, rowsUnder(all), key => accept($, key))}
            />
            <Button key="reject-all" label="Reject all" onPress={() => void act($, rowsUnder(all), key => reject($, key))} />
          </Box>
        </Box>
        {footer}
      </Box>
    )
  })
}
