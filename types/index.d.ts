export type Row = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' | 'deferred' }

export type Snapshot = {
  machine: string
  model: string | null
  cwd: string
  project: string
  remoteControl: boolean
  used: number
  max: number
  percent: number
  rows: Row[]
  mcpServers: { name: string; tools: number; tokens: number }[]
  memoryFiles: { path: string; tokens: number }[]
  // Usage limit windows; resetsAt in epoch milliseconds.
  limits: { name: string; percent: number; resetsAt: number | null }[]
  costUsd: number | null
}

export type Pr = { number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED' }

export type Changes = {
  branch: string | null
  base: string | null
  added: number
  removed: number
  ahead: number
  behind: number
  uncommitted: number
  pr: Pr | null
}

// key: the file's path, or an artifact's title. updated: a file that existed before this
// session wrote it.
export type Output = { key: string; label: string; kind: 'file' | 'artifact'; updated: boolean }

declare module 'claude-code' {
  interface PluginState {
    'session-panel': {
      snapshot: Shaped<Snapshot | null>
      // null until first read; 'no-repo' outside a git repository
      changes: Shaped<Changes | 'no-repo' | null>
      outputs: Shaped<Output[]>
      showMemory: boolean
      showAllOutputs: boolean
    }
  }
}
