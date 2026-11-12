import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Changes, Output, Pr, Row, Snapshot } from '../types'

const PANE = 'session-panel'
const TITLE = 'Session'
const PR_PROMPT =
  'Create a pull request for the current branch: push it if needed, then open the PR with gh.'

const snapshot = atom({ plugin: 'session-panel', key: 'snapshot' } as const, null, {
  shape: 'snapshot-2',
})
const changes = atom({ plugin: 'session-panel', key: 'changes' } as const, null, {
  shape: 'changes-1',
})
const outputs = atom({ plugin: 'session-panel', key: 'outputs' } as const, [], {
  shape: 'outputs-2',
})
const showMemory = atom({ plugin: 'session-panel', key: 'showMemory' } as const, false)
const showAllOutputs = atom({ plugin: 'session-panel', key: 'showAllOutputs' } as const, false)
// The newest outputs shown before "+N more".
const OUTPUTS_SHOWN = 6
const LIMIT_NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', spend_limit: 'Spend' }

// 307592 -> "307.6k", 1000000 -> "1M", as the app prints them.
const short = (n: number): string => {
  const [value, unit] = n >= 1e6 ? [n / 1e6, 'M'] : n >= 1e3 ? [n / 1e3, 'k'] : [n, '']
  return `${value.toFixed(unit ? 1 : 0).replace(/\.0$/, '')}${unit}`
}
const pct = (n: number, of: number): string => (of > 0 ? `${((n / of) * 100).toFixed(1)}%` : '—')
const home = (path: string, homeDir: string | undefined): string =>
  homeDir && path.startsWith(homeDir) ? `~${path.slice(homeDir.length)}` : path
const baseName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
// 8040000 -> "2h 14m", 200000000 -> "2d 7h", under a minute -> "1m".
const until = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / 60000))
  const [d, h, m] = [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60]
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

async function run($: EngineInterface, argv: string[], timeoutMs = 5000): Promise<string | null> {
  try {
    const { exitCode, stdout } = await $.process.run(argv, { timeoutMs })
    return exitCode === 0 ? stdout.trim() : null
  } catch {
    return null
  }
}
const git = ($: EngineInterface, args: string[]) => run($, ['git', ...args])

// The base a PR would target: origin's default branch, else a local main/master.
async function findBase($: EngineInterface): Promise<string | null> {
  const head = await git($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head) return head
  for (const name of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await git($, ['rev-parse', '--verify', '-q', name])) !== null) return name
  }
  return null
}

// Lines in the untracked files git diff leaves out, counted as git would; binaries count none.
async function untrackedLines($: EngineInterface): Promise<number> {
  const list = await git($, ['ls-files', '--others', '--exclude-standard', '-z', '--', ':/'])
  let lines = 0
  for (const path of (list ?? '').split('\0').filter(Boolean).slice(0, 200)) {
    const text = await $.fs.read(path).catch(() => '')
    if (text === '' || text.includes('\0')) continue
    lines += text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  }
  return lines
}

// The branch's pull request, if gh is installed, signed in and finds one.
async function findPr($: EngineInterface): Promise<Pr | null> {
  const out = await run($, ['gh', 'pr', 'view', '--json', 'number,url,state'], 10000)
  try {
    const { number, url, state } = JSON.parse(out ?? '') as Pr
    return typeof number === 'number' && typeof url === 'string' ? { number, url, state } : null
  } catch {
    return null
  }
}

// The machine's name does not change within a session: asked once.
let machine: Promise<string> | null = null
const machineName = ($: EngineInterface): Promise<string> =>
  (machine ??= $.process
    .run(['hostname', '-s'])
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : 'this machine'))
    .catch(() => 'this machine'))

// One run of each refresh at a time: a call while one runs queues a single rerun behind it,
// so a slower, older read never lands over a newer one.
const runs = {
  session: { running: null as Promise<void> | null, queued: false },
  changes: { running: null as Promise<void> | null, queued: false },
}
function oneAtATime($: EngineInterface, which: keyof typeof runs): Promise<void> {
  const run = runs[which]
  if (run.running) {
    run.queued = true
    return run.running
  }
  run.running = (async () => {
    do {
      run.queued = false
      await (which === 'session' ? measureSession($) : measureChanges($)).catch(() => {})
    } while (run.queued)
  })().finally(() => {
    run.running = null
  })
  return run.running
}
function refreshSession($: EngineInterface): Promise<void> {
  return oneAtATime($, 'session')
}
function refreshChanges($: EngineInterface): Promise<void> {
  return oneAtATime($, 'changes')
}
function refreshAll($: EngineInterface): Promise<unknown> {
  isPrStale = true
  return Promise.all([refreshSession($), refreshChanges($)])
}

// Environment, context and usage: cheap, read whenever the engine measures the session.
async function measureSession($: EngineInterface): Promise<void> {
  const [cwd, homeDir, repo, surfaces, usage, host, model] = await Promise.all([
    $.session.cwd(),
    $.env.get('HOME'),
    $.session.repo(),
    $.session.surfaces(),
    $.session.usage({ breakdown: 'summary', columns: 40 }),
    machineName($),
    $.session.model().catch(() => null),
  ])
  const breakdown = usage.context.breakdown

  const servers = new Map<string, { name: string; tools: number; tokens: number }>()
  for (const tool of breakdown?.mcpTools ?? []) {
    const one = servers.get(tool.serverName) ?? { name: tool.serverName, tools: 0, tokens: 0 }
    one.tools += 1
    one.tokens += tool.tokens
    servers.set(tool.serverName, one)
  }

  const next: Snapshot = {
    machine: host,
    model,
    cwd: home(cwd, homeDir),
    project: baseName(repo?.root ?? cwd),
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
    limits: usage.rateLimits.map(l => ({
      name: LIMIT_NAMES[l.kind] ?? l.kind,
      percent: l.percentUsed,
      resetsAt: l.resetsAt ? Date.parse(l.resetsAt) : null,
    })),
    costUsd: usage.cost?.usd ?? null,
  }
  await update($, snapshot, () => next)
}

// Whether the next changes refresh asks gh for the PR: a network call, so only at the
// start, on Refresh, on a new branch, and after a command that may have pushed or opened one.
let isPrStale = true
let lastBranch: string | null = null
// A subagent changed files: git is read at the next measure rather than on each of its calls.
let isGitStale = false

// Git and the PR: run after file changes and commands, not on every measure.
async function measureChanges($: EngineInterface): Promise<void> {
  if (!(await $.session.repo())) {
    await update($, changes, () => 'no-repo' as const)
    return
  }
  const branch = await git($, ['branch', '--show-current'])
  const base = await findBase($)
  const mergeBase = base ? await git($, ['merge-base', base, 'HEAD']) : null
  const [stat, untracked, counts, status] = await Promise.all([
    git($, ['diff', '--shortstat', mergeBase ?? 'HEAD']),
    untrackedLines($),
    base ? git($, ['rev-list', '--left-right', '--count', `${base}...HEAD`]) : null,
    git($, ['status', '--porcelain']),
  ])
  const [behind, ahead] = (counts ?? '0\t0').split(/\s+/).map(Number)

  const askPr = isPrStale || branch !== lastBranch
  isPrStale = false
  lastBranch = branch
  const earlier = await read($, changes)
  const pr = askPr ? await findPr($) : typeof earlier === 'object' ? (earlier?.pr ?? null) : null

  const next: Changes = {
    branch,
    base,
    added: Number(stat?.match(/(\d+) insertion/)?.[1] ?? 0) + untracked,
    removed: Number(stat?.match(/(\d+) deletion/)?.[1] ?? 0),
    ahead: ahead || 0,
    behind: behind || 0,
    uncommitted: (status ?? '').split('\n').filter(Boolean).length,
    pr,
  }
  await update($, changes, () => next)
}

// Keyed by path (or title, for an artifact): a later write moves the entry to the top
// and keeps it a new file if this session created it.
function addOutput($: EngineInterface, output: Output): Promise<unknown> {
  return update($, outputs, list => {
    const earlier = list.find(o => o.key === output.key)
    const updated = earlier ? earlier.updated && output.updated : output.updated
    return [...list.filter(o => o.key !== output.key), { ...output, updated }].slice(-50)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-panel',
      description: 'Show the session panel: environment, context, usage, MCP, outputs, changes',
    })
    const ran = await next(e)
    void refreshAll($)
    void $.ui.open({ id: PANE, title: TITLE })
    return ran
  })

  on('command.run', { command: 'session-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void refreshAll($)
    return { text: 'Session panel opened.' }
  })

  // After each main-thread turn, a compaction, or a usage limit moving a point.
  on('session.measure', async ($, e, next) => {
    const ran = await next(e)
    void refreshSession($)
    if (isGitStale) {
      isGitStale = false
      void refreshChanges($)
    }
    return ran
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    const args = e as unknown as Record<string, unknown>
    if (e.tool === 'Write' && ran.result && !ran.isError) {
      const updated = (ran.result as { type?: string }).type === 'update'
      await addOutput($, { key: e.file_path, label: baseName(e.file_path), kind: 'file', updated })
    } else if (tool.startsWith('mcp__claude-artifacts__publish') && typeof args.title === 'string') {
      await addOutput($, { key: args.title, label: args.title, kind: 'artifact', updated: false })
    }
    if (e.tool === 'Bash' && /\bgh\b|\bgit\s+push\b/.test(e.command)) isPrStale = true
    const changed = tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit' || tool === 'Bash'
    if (changed && e.agentId !== undefined) isGitStale = true
    else if (changed) void refreshChanges($)
    return ran
  }).catch(($, e, next) => next(e)) // the call's own result stands if recording it fails

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const width = Math.max(24, e.props.bodyColumns)
    const snap = await read($, snapshot)
    const stored = await read($, changes)
    const chg = typeof stored === 'object' ? stored : null
    const outs = await read($, outputs)
    const isMemoryOpen = await read($, showMemory)
    const isOutputsOpen = await read($, showAllOutputs)

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
      const cells = Math.min(barWidth - filled, Math.round((r.tokens / Math.max(1, snap.max)) * barWidth))
      if (cells === 0) continue
      segments.push({ color: r.color, cells, char: '━', dim: r.kind === 'buffer' })
      filled += cells
    }
    const rest = Math.max(0, barWidth - filled)

    // A usage limit: its name, % used and when it resets, over a bar coloured by how close it is.
    const now = snap.limits.some(l => l.resetsAt !== null) ? await $.clock.now() : 0
    const limit = (l: Snapshot['limits'][number]) => {
      const cells = Math.min(width, Math.round((Math.min(100, l.percent) / 100) * width))
      const color = l.percent >= 90 ? 'error' : l.percent >= 70 ? 'warning' : 'suggestion'
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Box flexGrow={1}>
              <Text>
                {l.name} <Text bold>{Math.round(l.percent)}%</Text>
              </Text>
            </Box>
            {l.resetsAt !== null && l.resetsAt > now && <Text dimColor>resets in {until(l.resetsAt - now)}</Text>}
          </Box>
          <Text>
            <Text color={color}>{'━'.repeat(cells)}</Text>
            <Text dimColor>{'─'.repeat(width - cells)}</Text>
          </Text>
        </Box>
      )
    }

    const onBase = !chg?.branch || !chg.base || chg.base === chg.branch || chg.base.endsWith(`/${chg.branch}`)
    const isPrOpen = chg?.pr?.state === 'OPEN'
    const hasWork = !!chg && (chg.ahead > 0 || chg.uncommitted > 0)
    const position = chg
      ? [
          chg.ahead > 0 && `${plural(chg.ahead, 'commit')} ahead`,
          chg.behind > 0 && `${chg.behind} behind`,
          chg.uncommitted > 0 && `${plural(chg.uncommitted, 'file')} uncommitted`,
        ].filter(Boolean)
      : []

    const shown = snap.rows.filter(r => r.kind !== 'deferred')
    const deferred = snap.rows.filter(r => r.kind === 'deferred')
    const newest = outs.slice().reverse()
    const listed = isOutputsOpen ? newest : newest.slice(0, OUTPUTS_SHOWN)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {heading('Environment')}
          {item('▭', snap.machine)}
          {item('▢', `${snap.project} · ${snap.cwd}`)}
          {chg?.branch && item('⑂', chg.branch)}
          {snap.model && item('✻', snap.model)}
          {item(
            '◇',
            'Remote Control',
            <Text color={snap.remoteControl ? 'suggestion' : 'inactive'}>
              {snap.remoteControl ? '● attached' : '○ off'}
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

        {(snap.limits.length > 0 || snap.costUsd !== null) && (
          <Box flexDirection="column">
            {heading('Usage')}
            {snap.limits.map(limit)}
            {snap.costUsd !== null && <Text dimColor>${snap.costUsd.toFixed(2)} this session</Text>}
          </Box>
        )}
        {(snap.limits.length > 0 || snap.costUsd !== null) && rule}

        <Box flexDirection="column">
          {heading('MCP in context')}
          {snap.mcpServers.length === 0 && <Text dimColor>No MCP tools in context.</Text>}
          {snap.mcpServers.map(s =>
            item('◆', s.name, figure(short(s.tokens), `${s.tools} ${s.tools === 1 ? 'tool' : 'tools'}`, 10)),
          )}
        </Box>
        {rule}

        <Box flexDirection="column">
          {heading('Outputs')}
          {outs.length === 0 && <Text dimColor>Nothing written yet.</Text>}
          {listed.map(o =>
            item(
              o.kind === 'artifact' ? '❐' : '▤',
              o.label,
              (o.kind === 'artifact' || o.updated) && (
                <Text dimColor>{o.kind === 'artifact' ? 'Artifact' : 'updated'}</Text>
              ),
            ),
          )}
          {newest.length > OUTPUTS_SHOWN && (
            <Button key="outputs" plain dimColor onPress={() => update($, showAllOutputs, open => !open)}>
              {isOutputsOpen ? '⌄ Fewer' : `› ${newest.length - OUTPUTS_SHOWN} more`}
            </Button>
          )}
        </Box>
        {rule}

        <Box flexDirection="column">
          {heading('Changes')}
          {stored === 'no-repo' && <Text dimColor>Not a git repository.</Text>}
          {stored === null && <Text dimColor>Reading git…</Text>}
          {chg && (
            <Box flexDirection="row" alignItems="center">
              <Box flexGrow={1} flexDirection="row">
                <Text dimColor>± </Text>
                <Text color="success">+{chg.added.toLocaleString('en-US')}</Text>
                <Text> </Text>
                <Text color="error">−{chg.removed.toLocaleString('en-US')}</Text>
              </Box>
              {!onBase && isPrOpen && chg.pr && <Link href={chg.pr.url} label={`View PR #${chg.pr.number}`} />}
              {!onBase && !isPrOpen && hasWork && (
                <Button key="pr" onPress={() => void $.prompt.submit({ text: PR_PROMPT })}>
                  Create PR
                </Button>
              )}
            </Box>
          )}
          {position.length > 0 && <Text dimColor>{position.join(' · ')}</Text>}
          {chg?.pr && !isPrOpen && !onBase && (
            <Text dimColor>
              PR #{chg.pr.number} {chg.pr.state.toLowerCase()}
            </Text>
          )}
          {chg?.base && <Text dimColor>vs {chg.base}</Text>}
        </Box>

        <Button key="refresh" plain dimColor onPress={() => void refreshAll($)}>
          ↻ Refresh
        </Button>
      </Box>
    )
  })
}
