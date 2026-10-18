/** The VS Code diff opened for one tracked file. */
export type Review = {
  /** Temp copy of the original: the read-only left side; the source is the right. */
  originalCopy: string
  /** Empty stand-in for the right side, written when the file was deleted at the time of opening. */
  deletedCopy?: string
}

/** One file Claude changed that you have not resolved yet. */
export type Tracked = {
  /** The path as the tool named it, absolute. */
  path: string
  /** The path relative to the session's working directory, `/`-separated. */
  rel: string
  /** The text before Claude's first touch; null when Claude created the file. */
  original: string | null
  added: number
  removed: number
  /** For a file Claude created: the folders the write created, outermost first. */
  createdDirs?: string[]
  /** True while the file is gone from disk (a deletion to accept or reject). */
  isDeleted?: boolean
  /** The text right after Claude's last change, or the last note it was sent; null when that left it deleted. */
  lastSeenByClaude: string | null
  review?: Review
  /** With persistence: the session whose Claude last changed it. */
  owner?: string
  /** With persistence: the path relative to the worktree root, case kept. */
  gitRel?: string
  /** With persistence: when the record this entry reflects was made. */
  at?: number
  /** With persistence: the branch checked out when it was recorded. */
  branch?: string
  /** Never persisted (too large, or the write failed): kept in this session only. */
  sessionOnly?: boolean
  /** In a second window: listed when it yielded, from the shared list, so it may be out of date. */
  otherWindow?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'pending-changes': {
      /** Keyed by the normalised absolute path. */
      files: Record<string, Tracked>
      /** Folders collapsed in the pane, by their path relative to the working directory. */
      collapsed: string[]
      /** Notes waiting to reach Claude with the next prompt. */
      notices: string[]
      /** Pending entries in the worktree outside the working directory, for the footer. */
      outside: number
      /** Other sessions in the worktree, by id. */
      sessions: Record<string, 'live' | 'ended'>
      /** The session id the persisted list was last loaded for. */
      loadedFor: string
      /** Session ids whose Claude has had the resume note. */
      resumeNoted: string[]
      /** Files this Claude was told about by a resume or handover note, by key: the text it was told about. */
      knows: Record<string, string | null>
      /** Resolve times of files resolved while persistence was off, by worktree key. */
      resolvedWhileOff: Record<string, { at: number; rel: string }>
      /** This process's id, telling a second process under the same session id apart. */
      instance: string
      /** The branch checked out now, for the `other branch` tag. */
      branchNow: string
      /** This process yielded to another window open on the same session. */
      secondWindow: boolean
    }
  }
}
