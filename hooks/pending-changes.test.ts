import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { countChanges } from './diff'
import { folderId } from './ids'
import { deleteTargets, isReadOnlyCommand } from './commands'

const CWD = '/repo'
const TMP = '/tmp/claude-pending-changes/s1'

/** The kit hands fs hooks native paths (`C:\repo\a.txt` on Windows): key the disk by the POSIX spelling. */
const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
/** An in-memory host: files and folders, `rm -rf`, `code --diff`, and Edit/Write applied to the files. */
/** Answers the git commands the mod runs, for a work tree at /repo whose HEAD is `head`. */
function gitAnswer(argv: string[], disk: Map<string, string>, head: Record<string, string>) {
  const [cmd, ...args] = argv
  if (cmd !== 'git') return undefined
  const ok = (stdout: string) => ({ exitCode: 0, stdout })
  if (args[0] === 'rev-parse') return ok('/repo\n')
  if (args[0] === 'status') {
    const paths = new Set([...Object.keys(head), ...disk.keys()].filter(p => p.startsWith('/repo/')))
    let out = ''
    for (const path of [...paths].sort()) {
      const rel = path.slice('/repo/'.length)
      if (!(path in head)) out += `?? ${rel}\0`
      else if (!disk.has(path)) out += ` D ${rel}\0`
      else if (disk.get(path) !== head[path]) out += ` M ${rel}\0`
    }
    return ok(out)
  }
  if (args[0] === 'cat-file') {
    const path = `/repo/${args[2]!.slice('HEAD:'.length)}`
    return path in head ? ok(head[path]!) : { exitCode: 128, stdout: '' }
  }
  if (args[0] === 'ls-files') {
    const dir = norm(args[2]!)
    return ok(Object.keys(head).filter(p => p.startsWith(`${dir}/`)).join('\n'))
  }
  return ok('')
}

type HostOptions = {
  /** Committed content by absolute path; present = the folder is a git work tree at /repo. */
  head?: Record<string, string>
  /** What each Bash command does to the disk, by its exact text. */
  shell?: Record<string, (disk: Map<string, string>, put: (path: string, text: string) => void) => void | Promise<void>>
  /** A terminal too narrow to seat a pane the mod opens unasked. */
  narrow?: boolean
}

function host(on: On, initial: Record<string, string> = {}, options: HostOptions = {}) {
  const disk = new Map<string, string>()
  const dirs = new Set<string>(['/repo'])
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'))
  const put = (path: string, text: string) => {
    disk.set(path, text)
    for (let dir = parentOf(path); dir.length > 0; dir = parentOf(dir)) dirs.add(dir)
  }
  for (const [path, text] of Object.entries(initial)) put(path, text)
  const ran: string[][] = []
  mock.env(on, { TMPDIR: '/tmp' })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.exists', ($, e) => ({ value: disk.has(norm(e.path)) || dirs.has(norm(e.path)) }))
  on('fs.read', ($, e) => {
    const text = disk.get(norm(e.path))
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    put(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.stat', ($, e) => ({
    value: { kind: disk.has(norm(e.path)) ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false },
  }))
  on('fs.list', ($, e) => {
    const dir = norm(e.path)
    const names = [...disk.keys(), ...dirs].filter(p => parentOf(p) === dir).map(p => p.slice(dir.length + 1))
    return {
      value: names.map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
    }
  })
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    const git = options.head ? gitAnswer([...e.argv], disk, options.head) : undefined
    if (git) return { value: { ...git, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
  on('ui.open', () =>
    options.narrow
      ? { value: { isPlaced: false as const, reason: 'below 144 columns' } }
      : { value: { isPlaced: true as const } },
  )
  on('command.register', () => ({ value: { isRegistered: true } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context ?? [] }))
  on('tool.call', async ($, e) => {
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
  return { disk, dirs, ran, clock, toasts }
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

test('an edit is listed with its counts, and rounds accumulate against the first original', async ($, on) => {
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

test('editing back to the original drops the file', async ($, on) => {
  host(on, { '/repo/a.txt': 'one\n' })
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  await $.tool.call(edit('/repo/a.txt', 'uno', 'one'))
  const ui = await mountPane($)
  expect(await isEmpty(ui)).toBe(true)
  await ui.unmount()
})

test('files outside the working directory are ignored', async ($, on) => {
  host(on, { '/tmp/scratch.py': 'x\n' })
  await $.tool.call(edit('/tmp/scratch.py', 'x', 'y'))
  const ui = await mountPane($)
  expect(await isEmpty(ui)).toBe(true)
  await ui.unmount()
})

test('reject all restores originals, deletes created files and tells Claude', async ($, on) => {
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

test('accept all keeps the changes, clears the list and tells Claude nothing', async ($, on) => {
  const { disk } = host(on, { '/repo/a.txt': 'one\n' })
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  const ui = await mountPane($)

  await ui.press({ key: 'accept-all' })

  expect(disk.get('/repo/a.txt')).toBe('uno\n')
  expect(await isEmpty(ui)).toBe(true)
  expect((await submit($, 'next')).context ?? []).toEqual([])
  await ui.unmount()
})

test('a review opens the original left and the source right; saves there update the counts', async ($, on) => {
  const { disk, ran, clock } = host(on, { '/repo/src/a.ts': 'one\ntwo\n' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call(edit('/repo/src/a.ts', 'one\ntwo', 'ONE\nTWO'))
  const ui = await mountPane($)

  await pressText(ui, /a.ts/)

  expect(ran.at(-1)).toEqual(['code', '--diff', `${TMP}/src/a.original.ts`, '/repo/src/a.ts'])
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

test('reverting every block in the review drops the file and its temp copy', async ($, on) => {
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

test('the next prompt tells Claude about a file the user edited after Claude, once', async ($, on) => {
  const { disk } = host(on, { '/repo/a.txt': 'one\n' })
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  disk.set('/repo/a.txt', 'uno, tweaked\n')

  const sent = await submit($, 'go on')
  expect(sent.context?.join('\n')).toMatch(/modified `a\.txt` after your last edit/)
  expect((await submit($, 'and again')).context ?? []).toEqual([])
})

test('files are grouped under folders, lone folder chains merged, with folder totals', async ($, on) => {
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

test('rejecting a folder rejects every file under it and removes the folders Claude created', async ($, on) => {
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

test('accepting a folder accepts only the files under it', async ($, on) => {
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

test('clicking a folder collapses and expands it, keeping its totals and buttons', async ($, on) => {
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

test('rows draw tree guides: dim connectors before files and folders below the top level', async ($, on) => {
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

test('the refresh runs even when session.start never fired for this load', async ($, on) => {
  const { disk, clock } = host(on, { '/repo/a.txt': 'one\n' })
  await $.tool.call(edit('/repo/a.txt', 'one', 'uno'))
  const ui = await mountPane($)

  disk.set('/repo/a.txt', 'uno\ndos\n')
  await clock.advance(2000)

  expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
  await ui.unmount()
})

test('emptying a new file in the diff rejects it: file and its new folders are deleted, Claude told', async ($, on) => {
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

test('a file Claude itself created empty is not rejected by the refresh', async ($, on) => {
  const { disk, clock } = host(on, {})
  await $.tool.call({ tool: 'Write', file_path: '/repo/pkg/__init__.py', content: '' })
  const ui = await mountPane($)

  await clock.advance(2000)

  expect(disk.has('/repo/pkg/__init__.py')).toBe(true)
  expect(await ui.find({ type: 'Button', text: /__init__\.py/ })).toBeDefined()
  await ui.unmount()
})

test('reverting every block of an existing file drops it and tells Claude', async ($, on) => {
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
  expect(ran.at(-1)).toEqual(['code', '--diff', `${TMP}/test.original.json`, `${TMP}/test.deleted.json`])
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

test('on a terminal too narrow to seat the pane, a toast says how to open it', async ($, on) => {
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

test('no toast when the pane is seated', async ($, on) => {
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
