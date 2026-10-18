// Pure helpers for keeping the pending list across sessions: the shard format,
// merging shards, liveness, folding, and the git plumbing's text formats. No host
// access; register.tsx does the I/O.

/** A session counts as ended after this long without a heartbeat. */
export const STALE_MS = 30_000
/** An ended session's shard, a heartbeat without one, and an unneeded tombstone are removed after this long. */
export const FOLD_MS = 24 * 60 * 60 * 1000
/** Blobs larger than this can't come back through one `cat-file` (process.run returns 4 MiB). */
export const BLOB_CAP = 4 * 1024 * 1024 - 1024

export type GoneReason = 'accepted' | 'rejected' | 'reverted' | 'settled'
export type RejectKind = 'change' | 'new' | 'deletion'

/** One session's record of one file. Each shard holds at most one per path. */
export type Event = {
  /** When it was recorded (wall clock, ms). */
  at: number
  /** The session that recorded it. */
  by: string
  /** The session whose Claude last changed the file. */
  owner: string
  /** The path relative to the worktree root, `/`-separated, case kept. */
  rel: string
  /** `<git-dir>/HEAD` when it was recorded: `ref: refs/heads/x`, or a detached SHA. */
  branch: string
  /** Events at or before this are superseded for this path (a resolve folded away). */
  epoch?: number
  gone?: true
  goneReason?: GoneReason
  rejectKind?: RejectKind
  /** For a reject: its owner ended without reading it, so the session that recorded it told its own Claude. */
  rerouted?: true
  /** For a tombstone: when no other shard first stopped needing it. */
  unneededSince?: number
  /** Blob SHAs; null = no file. */
  original?: string | null
  seen?: string | null
  added?: number
  removed?: number
  isDeleted?: true
  /** Folders a new file created, worktree-relative, outermost first. */
  createdDirs?: string[]
}

export type Shard = {
  v: 1
  seq: number
  session: string
  /** Per process: a second process under the same session id has another. */
  instance: string
  endedAt?: number
  endReason?: string
  /** Keyed by `gitKey`: the worktree-relative path, lower-cased on Windows. */
  entries: Record<string, Event>
}

export type Heartbeat = {
  busy: boolean
  detached?: true
  /** The process writing it: a second process under the same session id writes another. */
  instance?: string
}

/** A path's merged state: the latest live event, with the original from the earliest. */
export type Merged = Event & { firstAt: number }

export type MergeResult = {
  live: Map<string, Merged>
  /** The latest resolve per path, for paths with no live event after it. */
  gone: Map<string, Event>
}

const later = (a: Event, b: Event) => a.at > b.at || (a.at === b.at && a.by > b.by)

/**
 * Merges every shard's events per path. The latest resolve (or a live event's
 * epoch) cuts off everything before it; of what's left, the latest event gives
 * the owner, `seen` and counts, and the earliest gives the original.
 */
export function mergeShards(shards: readonly Shard[]): MergeResult {
  const byKey = new Map<string, Event[]>()
  for (const shard of shards) {
    for (const [key, event] of Object.entries(shard.entries)) {
      const list = byKey.get(key)
      if (list) list.push(event)
      else byKey.set(key, [event])
    }
  }
  const live = new Map<string, Merged>()
  const gone = new Map<string, Event>()
  for (const [key, events] of byKey) {
    let lastGone: Event | undefined
    let cut = -Infinity
    for (const e of events) {
      if (e.gone) {
        if (!lastGone || later(e, lastGone)) lastGone = e
        cut = Math.max(cut, e.at)
      } else if (e.epoch !== undefined) {
        cut = Math.max(cut, e.epoch)
      }
    }
    const alive = events.filter(e => !e.gone && e.at > cut)
    if (alive.length === 0) {
      if (lastGone) gone.set(key, lastGone)
      continue
    }
    let latest = alive[0]!
    let earliest = alive[0]!
    for (const e of alive) {
      if (later(e, latest)) latest = e
      if (later(earliest, e)) earliest = e
    }
    live.set(key, {
      ...latest,
      original: earliest.original,
      ...(earliest.createdDirs ? { createdDirs: earliest.createdDirs } : {}),
      firstAt: earliest.at,
    })
  }
  return { live, gone }
}

export type Liveness = 'live' | 'ended'

/** A heartbeat this close after an end marker was written with it, not after a resume. */
const SAME_WRITE_MS = 1000
const endedSince = (beatMs: number, endedAt: number) => endedAt + SAME_WRITE_MS >= beatMs

/**
 * Whether a peer is live: a heartbeat within STALE_MS and no end marker newer
 * than it. `beatMs` is its heartbeat's mtime, or its shard's when it has none.
 */
export function liveness(beatMs: number | undefined, endedAt: number | undefined, now: number): Liveness {
  if (beatMs === undefined) return endedAt !== undefined ? 'ended' : 'live'
  if (endedAt !== undefined && endedSince(beatMs, endedAt)) return 'ended'
  return now - beatMs > STALE_MS ? 'ended' : 'live'
}

/** A shard may be folded into a live one: ended by its marker, or silent for FOLD_MS. */
export function isFoldable(beatMs: number | undefined, endedAt: number | undefined, now: number): boolean {
  if (endedAt !== undefined && (beatMs === undefined || endedSince(beatMs, endedAt))) return true
  return beatMs !== undefined && now - beatMs > FOLD_MS
}

/**
 * Copies an ended shard's events into `into`: those the merge still uses, and
 * resolves still shadowing an older live event elsewhere. A path both hold keeps
 * the per-field merge. Returns whether `into` changed.
 */
export function foldIn(into: Shard, ended: Shard, others: readonly Shard[]): boolean {
  let changed = false
  for (const [key, event] of Object.entries(ended.entries)) {
    if (event.gone) {
      const shadows = others.some(s => {
        const o = s.entries[key]
        return o !== undefined && !o.gone && o.at < event.at
      })
      if (!shadows) continue
    } else {
      const newerGone = [into, ...others].some(s => {
        const o = s.entries[key]
        return o?.gone === true && o.at > event.at
      })
      if (newerGone) continue
    }
    const mine = into.entries[key]
    if (!mine) {
      into.entries[key] = { ...event }
      changed = true
      continue
    }
    const { live } = mergeShards([{ ...into, entries: { [key]: mine } }, { ...ended, entries: { [key]: event } }])
    const merged = live.get(key)
    if (!merged) {
      // Both resolved, or a resolve wins: keep the newer of the two.
      const keep = later(event, mine) ? event : mine
      if (keep !== mine) {
        into.entries[key] = { ...keep }
        changed = true
      }
      continue
    }
    const { firstAt: _, ...next } = merged
    const cut = event.gone ? event.at : mine.gone ? mine.at : undefined
    const result: Event = cut !== undefined ? { ...next, epoch: Math.max(next.epoch ?? cut, cut) } : next
    if (JSON.stringify(result) !== JSON.stringify(mine)) {
      into.entries[key] = result
      changed = true
    }
  }
  return changed
}

/**
 * Drops this shard's tombstones that no other shard has needed for FOLD_MS:
 * needed = another shard holds an older live event for the path. Returns whether it changed.
 */
export function pruneTombstones(own: Shard, others: readonly Shard[], now: number): boolean {
  let changed = false
  for (const [key, event] of Object.entries(own.entries)) {
    if (!event.gone) continue
    const needed = others.some(s => {
      const o = s.entries[key]
      return o !== undefined && !o.gone && o.at < event.at
    })
    if (needed) {
      if (event.unneededSince !== undefined) {
        delete event.unneededSince
        changed = true
      }
    } else if (event.unneededSince === undefined) {
      event.unneededSince = now
      changed = true
    } else if (now - event.unneededSince > FOLD_MS) {
      delete own.entries[key]
      changed = true
    }
  }
  return changed
}

/** `git mktree` input pinning every SHA once, each under its own name. */
export function treeInput(shas: Iterable<string>): string {
  return [...new Set(shas)]
    .sort()
    .map(sha => `100644 blob ${sha}\t${sha}\n`)
    .join('')
}

/** The SHAs a `git ls-tree` listing names. */
export function parseLsTree(stdout: string): string[] {
  const shas: string[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\d+ blob ([0-9a-f]+)\t/.exec(line)
    if (match) shas.push(match[1]!)
  }
  return shas
}

/** UTF-8 byte length of one UTF-16 code unit sequence position, walking surrogate pairs. */
function utf8Length(text: string, from: number, bytes: number): number {
  let i = from
  let left = bytes
  while (left > 0 && i < text.length) {
    const code = text.codePointAt(i)!
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    left -= size
    i += code > 0xffff ? 2 : 1
  }
  return left === 0 ? i : -1
}

/**
 * Parses `git cat-file --batch` output up to its last complete record. Blob
 * sizes are in bytes, the output is text, so lengths are walked as UTF-8.
 */
export function parseCatFileBatch(stdout: string): { blobs: Map<string, string>; missing: string[]; read: number } {
  const blobs = new Map<string, string>()
  const missing: string[] = []
  let pos = 0
  let read = 0
  while (pos < stdout.length) {
    const eol = stdout.indexOf('\n', pos)
    if (eol < 0) break
    const header = stdout.slice(pos, eol).split(' ')
    if (header[1] === 'missing') {
      missing.push(header[0]!)
      pos = eol + 1
      read++
      continue
    }
    if (header.length !== 3) break
    const size = Number(header[2])
    const end = utf8Length(stdout, eol + 1, size)
    if (end < 0 || stdout[end] !== '\n') break
    blobs.set(header[0]!, stdout.slice(eol + 1, end))
    pos = end + 1
    read++
  }
  return { blobs, missing, read }
}

/** UTF-8 byte length of a text. */
export function byteLength(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/** A worktree name made safe for a ref: `%XX` for anything outside `[A-Za-z0-9_-]`. */
export function encodeWorktreeName(name: string): string {
  let out = ''
  for (const ch of name) {
    if (/[A-Za-z0-9_-]/.test(ch)) {
      out += ch
      continue
    }
    const code = ch.codePointAt(0)!
    const bytes =
      code < 0x80
        ? [code]
        : code < 0x800
          ? [0xc0 | (code >> 6), 0x80 | (code & 63)]
          : code < 0x10000
            ? [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)]
            : [0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)]
    out += bytes.map(b => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')
  }
  return out
}

export const REF_ROOT = 'refs/pending-changes'

/** The worktree's pin ref: `main` for the main worktree, `worktrees/<name>` for a linked one. */
export function refFor(gitDir: string, commonDir: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  if (norm(gitDir) === norm(commonDir)) return `${REF_ROOT}/main`
  const name = gitDir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop()!
  return `${REF_ROOT}/worktrees/${encodeWorktreeName(name)}`
}

export function zeroId(objectFormat: string): string {
  return '0'.repeat(objectFormat === 'sha256' ? 64 : 40)
}

/** The branch a record belongs to: HEAD, or during a rebase the branch being rebased. */
export function branchOf(head: string | null, rebaseHeadName: string | null): string {
  if (rebaseHeadName?.trim()) return `ref: ${rebaseHeadName.trim()}`
  return (head ?? '').trim()
}

/** The shard slot a write with this `seq` goes to: they alternate, so a torn write never leaves the only copy. */
export const slotOf = (seq: number): 'a' | 'b' => (seq % 2 === 1 ? 'a' : 'b')

/** Parses a shard slot; undefined when torn or foreign. */
export function parseShard(text: string): Shard | undefined {
  try {
    const value = JSON.parse(text) as Shard
    return value && value.v === 1 && typeof value.seq === 'number' && value.entries ? value : undefined
  } catch {
    return undefined
  }
}

export function parseHeartbeat(text: string): Heartbeat | undefined {
  try {
    const value = JSON.parse(text) as Heartbeat
    return value && typeof value.busy === 'boolean' ? value : undefined
  } catch {
    return undefined
  }
}

/** The notes the new behaviour sends, worded as the spec has them. */
export const note = {
  resume: (rels: readonly string[]) =>
    `These files have unreviewed changes from an earlier session: ${rels.map(r => `\`${r}\``).join(', ')}. They are listed in the review pane.`,
  handover: (rel: string) =>
    `\`${rel}\` was since edited by another Claude session; the user's decisions on it go to that session now.`,
  earlierModified: (rel: string) =>
    `\`${rel}\`, changed in an earlier session, was modified by the user; re-read it before editing it.`,
  earlierReverted: (rel: string) =>
    `The user reverted \`${rel}\`, changed in an earlier session, to its original; re-read it before editing it.`,
}
