import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Output, Row, Snapshot } from '../types'

const PANE = 'session-panel'
const TITLE = 'Session'
const PR_PROMPT =
  'Create a pull request for the current branch: push it if needed, then open the PR with gh.'

const snapshot = atom({ plugin: 'session-panel', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})
const outputs = atom({ plugin: 'session-panel', key: 'outputs' } as const, [], {
  shape: 'outputs-1',
})
const showMcp = atom({ plugin: 'session-panel', key: 'showMcp' } as const, false)
const showMemory = atom({ plugin: 'session-panel', key: 'showMemory' } as const, false)

// 307592 -> "307.6k", 1000000 -> "1M", as the app prints them.
const short = (n: number): string => {
  const [value, unit] = n >= 1e6 ? [n / 1e6, 'M'] : n >= 1e3 ? [n / 1e3, 'k'] : [n, '']
  return `${value.toFixed(unit ? 1 : 0).replace(/\.0$/, '')}${unit}`
}
const pct = (n: number, of: number): string => (of > 0 ? `${((n / of) * 100).toFixed(1)}%` : '—')
const home = (path: string, homeDir: string | undefined): string =>
  homeDir && path.startsWith(homeDir) ? `~${path.slice(homeDir.length)}` : path
const baseName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

async function git($: EngineInterface, args: string[]): Promise<string | null> {
  try {
    const { exitCode, stdout } = await $.process.run(['git', ...args], { timeoutMs: 5000 })
    return exitCode === 0 ? stdout.trim() : null
  } catch {
    return null
  }
}

// The base a PR would target: origin's default branch, else a local main/master.
async function findBase($: EngineInterface): Promise<string | null> {
  const head = await git($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head) return head
  for (const name of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await git($, ['rev-parse', '--verify', '-q', name])) !== null) return name
  }
  return null
}

async function refresh($: EngineInterface): Promise<void> {
  const [cwd, homeDir, repo, surfaces, usage, hostOut] = await Promise.all([
    $.session.cwd(),
    $.env.get('HOME'),
    $.session.repo(),
    $.session.surfaces(),
    $.session.usage({ breakdown: 'summary', columns: 40 }),
    $.process.run(['hostname', '-s']).catch(() => null),
  ])
  const breakdown = usage.context.breakdown

  let branch: string | null = null
  let base: string | null = null
  let added = 0
  let removed = 0
  if (repo) {
    branch = await git($, ['branch', '--show-current'])
    base = await findBase($)
    const mergeBase = base ? await git($, ['merge-base', base, 'HEAD']) : null
    const stat = await git($, ['diff', '--shortstat', mergeBase ?? 'HEAD'])
    added = Number(stat?.match(/(\d+) insertion/)?.[1] ?? 0)
    removed = Number(stat?.match(/(\d+) deletion/)?.[1] ?? 0)
  }

  const servers = new Map<string, { name: string; tools: number; tokens: number }>()
  for (const tool of breakdown?.mcpTools ?? []) {
    const one = servers.get(tool.serverName) ?? { name: tool.serverName, tools: 0, tokens: 0 }
    one.tools += 1
    one.tokens += tool.tokens
    servers.set(tool.serverName, one)
  }

  const next: Snapshot = {
    machine: hostOut?.exitCode === 0 ? hostOut.stdout.trim() : 'this machine',
    cwd: home(cwd, homeDir),
    project: baseName(repo?.root ?? cwd),
    branch,
    remoteControl: surfaces.some(s => s !== 'terminal'),
    used: breakdown?.totalTokens ?? usage.context.tokens ?? 0,
    max: breakdown?.rawMaxTokens ?? usage.context.window,
    percent: breakdown?.percentage ?? usage.context.percent ?? 0,
    rows: (breakdown?.categories ?? []).map(c => ({
      name: c.name,
      tokens: c.tokens,
      color: c.color,
      kind: c.kind,
    })),
    mcpServers: [...servers.values()].sort((a, b) => b.tokens - a.tokens),
    memoryFiles: (breakdown?.memoryFiles ?? []).map(f => ({
      path: home(f.path, homeDir),
      tokens: f.tokens,
    })),
    added,
    removed,
    base,
  }
  await update($, snapshot, () => next)
}

function addOutput($: EngineInterface, output: Output): Promise<unknown> {
  return update($, outputs, list =>
    [...list.filter(o => o.label !== output.label), output].slice(-50),
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-panel',
      description: 'Show the session panel: environment, context, connectors, outputs, changes',
    })
    const ran = await next(e)
    void refresh($)
    void $.ui.open({ id: PANE, title: TITLE })
    return ran
  })

  on('command.run', { command: 'session-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void refresh($)
    return { text: 'Session panel opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) void refresh($)
    return ran
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    const args = e as unknown as Record<string, unknown>
    if ((tool === 'Write' || tool === 'NotebookEdit') && typeof args.file_path === 'string') {
      await addOutput($, { label: baseName(args.file_path), kind: 'file' })
    } else if (tool.startsWith('mcp__claude-artifacts__publish') && typeof args.title === 'string') {
      await addOutput($, { label: args.title, kind: 'artifact' })
    }
    if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit' || tool === 'Bash') {
      void refresh($)
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(24, e.props.bodyColumns)
    const snap = await read($, snapshot)
    const outs = await read($, outputs)
    const isMcpOpen = await read($, showMcp)
    const isMemoryOpen = await read($, showMemory)

    if (!snap) return <Text dimColor>Reading the session…</Text>

    const heading = (text: string) => (
      <Text dimColor bold>
        {text}
      </Text>
    )
    const rule = <Text dimColor>{'─'.repeat(width)}</Text>
    const item = (icon: string, label: string, right?: RenderChildren) => (
      <Box flexDirection="row">
        <Text dimColor>{icon} </Text>
        <Box flexGrow={1}>
          <Text wrap="truncate-middle">{label}</Text>
        </Box>
        {right}
      </Box>
    )
    const figure = (left: string, right: string, rightWidth = 7) => (
      <Box flexDirection="row">
        <Box width={9} justifyContent="flex-end">
          <Text>{left}</Text>
        </Box>
        <Box width={rightWidth} justifyContent="flex-end">
          <Text dimColor>{right}</Text>
        </Box>
      </Box>
    )
    const row = (r: Row) => (
      <Box flexDirection="row">
        <Text color={r.color}>{r.kind === 'free' ? '□' : '■'} </Text>
        <Box flexGrow={1}>
          <Text wrap="truncate-end">{r.name}</Text>
        </Box>
        {figure(short(r.tokens), r.kind === 'deferred' ? '—' : pct(r.tokens, snap.max))}
      </Box>
    )

    // The stacked bar: each used category in its colour, the buffer dim, free space a thin line.
    const barWidth = width
    const segments: { color: string; cells: number; char: string; dim: boolean }[] = []
    let filled = 0
    for (const r of snap.rows) {
      if (r.kind !== 'used' && r.kind !== 'buffer') continue
      const cells = Math.round((r.tokens / Math.max(1, snap.max)) * barWidth)
      if (cells === 0) continue
      segments.push({ color: r.color, cells, char: '━', dim: r.kind === 'buffer' })
      filled += cells
    }
    const rest = Math.max(0, barWidth - filled)

    const shown = snap.rows.filter(r => r.kind !== 'deferred')
    const deferred = snap.rows.filter(r => r.kind === 'deferred')
    const mcpToolCount = snap.mcpServers.reduce((n, s) => n + s.tools, 0)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {heading('Environment')}
          {item('▭', snap.machine)}
          {item('▢', `${snap.project} · ${snap.cwd}`)}
          {snap.branch && item('⑂', snap.branch)}
          {item(
            '◇',
            'Remote Control',
            <Text color={snap.remoteControl ? 'suggestion' : 'inactive'}>
              {snap.remoteControl ? '━● on' : '●━ off'}
            </Text>,
          )}
        </Box>

        <Box flexDirection="column">
          {heading('Context')}
          <Box flexDirection="row">
            <Box flexGrow={1}>
              <Text bold>{Math.round(snap.percent)}% used</Text>
            </Box>
            <Text dimColor>
              {short(snap.used)} / {short(snap.max)}
            </Text>
          </Box>
          <Text>
            {segments.map(s => (
              <Text color={s.color} dimColor={s.dim}>
                {s.char.repeat(s.cells)}
              </Text>
            ))}
            <Text dimColor>{'─'.repeat(rest)}</Text>
          </Text>
          {shown.map(row)}
          {deferred.length > 0 && <Text> </Text>}
          {deferred.map(row)}
          <Text> </Text>
          <Button
            key="mcp"
            plain
            dimColor
            onPress={() => update($, showMcp, open => !open)}
          >
            {isMcpOpen ? '⌄' : '›'} MCP tools{' '}
            <Text dimColor>({mcpToolCount})</Text>
          </Button>
          {isMcpOpen &&
            snap.mcpServers.map(s => (
              <Box flexDirection="row" paddingLeft={2}>
                <Box flexGrow={1}>
                  <Text wrap="truncate-end">{s.name}</Text>
                </Box>
                {figure(short(s.tokens), String(s.tools), 5)}
              </Box>
            ))}
          <Button
            key="memory"
            plain
            dimColor
            onPress={() => update($, showMemory, open => !open)}
          >
            {isMemoryOpen ? '⌄' : '›'} Memory files{' '}
            <Text dimColor>({snap.memoryFiles.length})</Text>
          </Button>
          {isMemoryOpen &&
            snap.memoryFiles.map(f => (
              <Box flexDirection="row" paddingLeft={2}>
                <Box flexGrow={1}>
                  <Text wrap="truncate-start">{f.path}</Text>
                </Box>
                <Text dimColor> {short(f.tokens)}</Text>
              </Box>
            ))}
        </Box>
        {rule}

        <Box flexDirection="column">
          {heading('Connectors')}
          {snap.mcpServers.length === 0 && <Text dimColor>No MCP servers in context.</Text>}
          {snap.mcpServers.map(s => item('◆', s.name))}
        </Box>
        {rule}

        <Box flexDirection="column">
          {heading('Outputs')}
          {outs.length === 0 && <Text dimColor>Nothing written yet.</Text>}
          {outs
            .slice()
            .reverse()
            .map(o =>
              item(o.kind === 'artifact' ? '❐' : '▤', o.label, o.kind === 'artifact' && <Text dimColor>Artifact</Text>),
            )}
        </Box>
        {rule}

        <Box flexDirection="column">
          {heading('Changes')}
          <Box flexDirection="row" alignItems="center">
            <Box flexGrow={1} flexDirection="row">
              <Text dimColor>± </Text>
              <Text color="success">+{snap.added.toLocaleString('en-US')}</Text>
              <Text> </Text>
              <Text color="error">−{snap.removed.toLocaleString('en-US')}</Text>
            </Box>
            {snap.branch && snap.base && !snap.base.endsWith(`/${snap.branch}`) && snap.base !== snap.branch && (
              <Button key="pr" onPress={() => void $.prompt.submit({ text: PR_PROMPT })}>
                Create PR
              </Button>
            )}
          </Box>
          {snap.base && <Text dimColor>vs {snap.base}</Text>}
        </Box>

        <Button key="refresh" plain dimColor onPress={() => void refresh($)}>
          ↻ Refresh
        </Button>
      </Box>
    )
  })
}
