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
    }
  }
}
