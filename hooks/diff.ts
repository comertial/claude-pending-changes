/** Splits text into lines; a trailing newline does not add an empty line. */
export function lines(text: string | null): string[] {
  if (text === null || text === '') return []
  const all = text.split(/\r?\n/)
  if (all[all.length - 1] === '') all.pop()
  return all
}

/**
 * Lines added and removed between two texts, from the edit distance of a
 * Myers O(ND) diff. Past `maxD` edits it settles for the length difference
 * bounds, which only a wholesale rewrite of a huge file reaches.
 */
export function countChanges(
  before: string | null,
  after: string | null,
  maxD = 20000,
): { added: number; removed: number } {
  const a = lines(before)
  const b = lines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const x = a.slice(start, endA)
  const y = b.slice(start, endB)
  const n = x.length
  const m = y.length
  if (n === 0 || m === 0) return { added: m, removed: n }

  const max = Math.min(n + m, maxD)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      const goDown = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
      let i = goDown ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let j = i - k
      while (i < n && j < m && x[i] === y[j]) {
        i++
        j++
      }
      v[offset + k] = i
      if (i >= n && j >= m) {
        const common = (n + m - d) / 2
        return { added: m - common, removed: n - common }
      }
    }
  }
  return { added: m, removed: n }
}
