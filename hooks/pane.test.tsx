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
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const SNAPSHOT = {
  machine: 'studio',
  cwd: '~/Projects/demo',
  project: 'demo',
  branch: 'feature/x',
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
  added: 69220,
  removed: 2687,
  base: 'origin/main',
}

test('the panel draws each section from a snapshot, on every surface', async ($, on) => {
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    if (key === 'snapshot') return { value: { value: { shape: 'snapshot-1', value: SNAPSHOT }, version: 1 } }
    if (key === 'outputs')
      return { value: { value: { shape: 'outputs-1', value: [{ label: 'Release Plan', kind: 'artifact' }] }, version: 1 } }
    return { value: { value: false, version: 1 } }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /31% used/ }))?.text).toBe('31% used')
    expect(await ui.find({ type: 'Text', text: /307\.6k \/ 1M/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^23\.8%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Example MCP/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Release Plan/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\+69,220/ })).toBeDefined()
    expect(await ui.find({ key: 'pr' })).toBeDefined()
    await ui.unmount()
  }
})
