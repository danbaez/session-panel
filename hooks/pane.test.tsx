import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-panel',
  component: 'Pane',
  requestId: 'session-panel',
  props: {
    title: 'Session',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-11-12T12:00:00Z')

const SNAPSHOT = {
  machine: 'studio',
  model: 'claude-opus-5-5',
  cwd: '~/Projects/demo',
  project: 'demo',
  remoteControl: false,
  used: 307600,
  max: 1000000,
  percent: 31,
  rows: [
    { name: 'Messages', tokens: 237500, color: 'promptBorder', kind: 'used' },
    { name: 'Free space', tokens: 658300, color: 'inactive', kind: 'free' },
    { name: 'MCP tools (deferred)', tokens: 138100, color: 'inactive', kind: 'deferred' },
  ],
  mcpServers: [{ name: 'Example MCP', tools: 12, tokens: 9000 }],
  memoryFiles: [{ path: '~/CLAUDE.md', tokens: 9400 }],
  limits: [
    { name: '5-hour', percent: 23, resetsAt: NOW + (2 * 60 + 14) * 60000 },
    { name: 'Weekly', percent: 91, resetsAt: NOW + (3 * 24 + 5) * 3600000 },
  ],
  costUsd: 1.234,
}

const CHANGES = {
  branch: 'feature/x',
  base: 'origin/main',
  added: 69220,
  removed: 2687,
  ahead: 3,
  behind: 1,
  uncommitted: 2,
  pr: null,
}

const OUTPUTS = [
  { key: 'Release Plan', label: 'Release Plan', kind: 'artifact', updated: false },
  { key: '/repo/notes.md', label: 'notes.md', kind: 'file', updated: true },
]

const SHAPES: Record<string, string> = { snapshot: 'snapshot-2', changes: 'changes-1', outputs: 'outputs-2' }

// Answers the keys given with stored values under their current shape (or the one named);
// every other key goes to the kit's own state, so the pane's toggles work.
const seed =
  (values: Record<string, unknown>, shapes: Record<string, string> = {}) =>
  (_: unknown, e: unknown, next: (e: never) => unknown): never => {
    const key = (e as { key: string }).key
    if (!(key in values)) return next(e as never) as never
    const shape = shapes[key] ?? SHAPES[key]
    return { value: { value: shape ? { shape, value: values[key] } : values[key], version: 1 } } as never
  }
const ALL = { snapshot: SNAPSHOT, changes: CHANGES, outputs: OUTPUTS }

test('the panel draws each section from a snapshot, on every surface', async ($, on) => {
  on('state.get', seed(ALL))
  on('clock.now', () => ({ value: NOW }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const has = async (text: RegExp) => expect(await ui.find({ type: 'Text', text })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /31% used/ }))?.text).toBe('31% used')
    await has(/307\.6k \/ 1M/)
    await has(/^23\.8%$/)
    await has(/^claude-opus-5-5$/)
    await has(/^feature\/x$/)
    await has(/^○ off$/)
    await has(/^resets in 2h 14m$/)
    await has(/^resets in 3d 5h$/)
    await has(/^\$1\.23 this session$/)
    await has(/Example MCP/)
    await has(/^12 tools$/)
    await has(/Release Plan/)
    await has(/^updated$/)
    await has(/\+69,220/)
    await has(/^3 commits ahead · 1 behind · 2 files uncommitted$/)
    expect(await ui.find({ key: 'pr' })).toBeDefined()
    expect(await ui.find({ key: 'mcp' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a limit past 90% draws its bar in the error colour', async ($, on) => {
  on('state.get', seed(ALL))
  on('clock.now', () => ({ value: NOW }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // 91% of 44 columns is 40 cells.
  const bar = await ui.find({ type: 'Text', text: /^━{40}$/ })
  expect(bar?.props.color).toBe('error')
  await ui.unmount()
})

test('the empty states show', async ($, on) => {
  const bare = { ...SNAPSHOT, model: null, mcpServers: [], memoryFiles: [], limits: [], costUsd: null }
  on('state.get', seed({ snapshot: bare, changes: 'no-repo', outputs: [] }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^No MCP tools in context\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Nothing written yet\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Not a git repository\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Usage$/ })).toBeUndefined()
    expect(await ui.find({ key: 'pr' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Create PR is hidden on the base branch and with nothing to send', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  const cases = [
    { ...CHANGES, branch: 'main' },
    { ...CHANGES, ahead: 0, uncommitted: 0 },
  ]
  let current: unknown = cases[0]
  on('state.get', (_, e, next) =>
    (e as { key: string }).key === 'changes' ? seed({ changes: current })(_, e, next) : seed(ALL)(_, e, next),
  )

  for (const one of cases) {
    current = one
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'pr' })).toBeUndefined()
    await ui.unmount()
  }
})

test('an open PR is linked in place of Create PR; a merged one is named', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  let pr = { number: 12, url: 'https://github.com/o/r/pull/12', state: 'OPEN' }
  on('state.get', (_, e, next) =>
    (e as { key: string }).key === 'changes'
      ? seed({ changes: { ...CHANGES, pr } })(_, e, next)
      : seed(ALL)(_, e, next),
  )

  for (const surface of ['terminal', 'desktop'] as const) {
    pr = { ...pr, state: 'OPEN' }
    let ui = await $.ui.mount({ ...PANE, surface })
    const link = await ui.find({ type: 'Link' })
    expect(link?.props.href).toBe('https://github.com/o/r/pull/12')
    expect(link?.props.label).toBe('View PR #12')
    expect(await ui.find({ key: 'pr' })).toBeUndefined()
    await ui.unmount()

    pr = { ...pr, state: 'MERGED' }
    ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^PR #12 merged$/ })).toBeDefined()
    expect(await ui.find({ key: 'pr' })).toBeDefined()
    await ui.unmount()
  }
})

test('the memory files list opens and closes', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', seed(ALL))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    if (await ui.find({ type: 'Text', text: /CLAUDE\.md/ })) await ui.press({ key: 'memory' })
    expect(await ui.find({ type: 'Text', text: /CLAUDE\.md/ })).toBeUndefined()
    await ui.press({ key: 'memory' })
    expect(await ui.find({ type: 'Text', text: /^~\/CLAUDE\.md$/ })).toBeDefined()
    await ui.press({ key: 'memory' })
    expect(await ui.find({ type: 'Text', text: /CLAUDE\.md/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('outputs show the newest six, and the rest behind "more"', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  const many = Array.from({ length: 9 }, (_, i) => ({
    key: `/repo/f${i}.md`,
    label: `f${i}.md`,
    kind: 'file',
    updated: false,
  }))
  on('state.get', seed({ ...ALL, outputs: many }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    if ((await ui.find({ key: 'outputs' }))?.text === '⌄ Fewer') await ui.press({ key: 'outputs' })
    expect(await ui.find({ type: 'Text', text: /^f8\.md$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^f3\.md$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^f2\.md$/ })).toBeUndefined()
    expect((await ui.find({ key: 'outputs' }))?.text).toBe('› 3 more')

    await ui.press({ key: 'outputs' })
    expect(await ui.find({ type: 'Text', text: /^f0\.md$/ })).toBeDefined()
    expect((await ui.find({ key: 'outputs' }))?.text).toBe('⌄ Fewer')
    await ui.unmount()
  }
})

test('values stored by the earlier version read as none', async ($, on) => {
  on('state.get', seed(ALL, { snapshot: 'snapshot-1', outputs: 'outputs-1' }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Reading the session/ })).toBeDefined()
  await ui.unmount()
})

test('the context bar never runs past the pane, however the cells round', async ($, on) => {
  // Three categories of 1/3 each round to 15 cells apiece at 44 columns: 45 > 44.
  const third = 333334
  const rows = ['A', 'B', 'C'].map(name => ({ name, tokens: third, color: 'promptBorder', kind: 'used' }))
  on('state.get', seed({ ...ALL, snapshot: { ...SNAPSHOT, rows, limits: [] } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const bar = await ui.find({ type: 'Text', text: /^━+─*$/ })
  expect(bar?.text.length).toBe(44)
  await ui.unmount()
})

test('a Write records an output: new stays new when written again, existing reads as updated', async ($, on) => {
  // The outputs go to the kit's own state, where the mod writes them.
  on('state.get', seed({ snapshot: SNAPSHOT, changes: CHANGES }))
  on('clock.now', () => ({ value: NOW }))
  on('tool.call', (_, e) => {
    const path = (e as { file_path: string }).file_path
    const type = path.endsWith('old.md') ? 'update' : 'create'
    return { result: { type, filePath: path, content: '', structuredPatch: [], originalFile: null } }
  })

  // As a subagent's calls, so no refresh runs against an engine the test does not stand in for.
  const write = (file_path: string) => $.tool.call({ tool: 'Write', file_path, content: '', agentId: 'a1' })
  await write('/repo/new.md')
  await write('/repo/old.md')
  await write('/repo/sub/new.md')
  await write('/repo/new.md')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^old\.md$/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /^updated$/ })).length).toBe(1)
    expect((await ui.findAll({ type: 'Text', text: /^new\.md$/ })).length).toBe(2)
    await ui.unmount()
  }
})

test('Refresh reads git, untracked lines, the PR, the model and usage limits', async ($, on) => {
  const files: Record<string, string> = { 'a.ts': 'one\ntwo\n', 'b.txt': 'x\ny', 'c.bin': 'P\0NG\n' }
  let ghCalls = 0
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('env.get', () => ({ value: '/home' }))
  on('session.repo', () => ({ value: { root: '/repo' } as never }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('clock.now', () => ({ value: NOW }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1000, tokens: 10, percent: 1 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: new Date(NOW + 30 * 60000).toISOString() }],
      cost: { usd: 0.5 },
    } as never,
  }))
  on('fs.read', (_, e) => ({ value: files[e.path.split('/').at(-1) ?? ''] ?? '' }))
  on('process.run', (_, e) => {
    const argv = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '' } as never })
    if (argv[0] === 'hostname') return out('studio')
    if (argv[0] === 'gh') {
      ghCalls += 1
      return out(JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' }))
    }
    if (argv[1] === 'ls-files') return out(Object.keys(files).join('\0') + '\0')
    if (argv[1] === 'diff') return out(' 1 file changed, 5 insertions(+), 1 deletion(-)')
    if (argv[1] === 'branch') return out('feature/x')
    if (argv[1] === 'symbolic-ref') return out('origin/main')
    if (argv[1] === 'merge-base') return out('abc123')
    if (argv[1] === 'rev-list') return out('0\t2')
    if (argv[1] === 'status') return out(' M a.ts\n?? b.txt\n')
    return out('', 1)
  })

  // The pane draws a seeded snapshot until the mod writes its own; Refresh writes it.
  let isWritten = false
  on('state.set', (_, e, next) => {
    if ((e as { key: string }).key === 'snapshot') isWritten = true
    return next(e)
  })
  on('state.get', (_, e, next) =>
    isWritten ? next(e) : seed({ snapshot: SNAPSHOT })(_, e, next as never),
  )

  const seeded = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await seeded.press({ key: 'refresh' })
  await seeded.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const has = async (text: RegExp) => expect(await ui.find({ type: 'Text', text })).toBeDefined()
  // 5 tracked, plus 2 in a.ts and 2 in b.txt (its last line unterminated); c.bin counts none.
  await has(/^\+9$/)
  await has(/^−1$/)
  await has(/^studio$/)
  await has(/^claude-sonnet-5-5$/)
  await has(/^resets in 30m$/)
  await has(/^\$0\.50 this session$/)
  await has(/^2 commits ahead · 2 files uncommitted$/)
  expect((await ui.find({ type: 'Link' }))?.props.label).toBe('View PR #7')
  expect(ghCalls).toBe(1)
  await ui.unmount()
})

