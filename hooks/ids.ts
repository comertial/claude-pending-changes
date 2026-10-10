/** A short stable id for element keys, so a press never lands on a shifted row. */
export function idOf(key: string): string {
  let hash = 5381
  for (let i = 0; i < key.length; i++) hash = ((hash * 33) ^ key.charCodeAt(i)) >>> 0
  return hash.toString(36)
}

/** The key of a folder row's buttons: `accept-dir-…` and `reject-dir-…`. */
export function folderId(relDir: string): string {
  return idOf(`dir:${relDir}`)
}
