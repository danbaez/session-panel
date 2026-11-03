export type Row = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' | 'deferred' }

export type Snapshot = {
  machine: string
  cwd: string
  project: string
  branch: string | null
  remoteControl: boolean
  used: number
  max: number
  percent: number
  rows: Row[]
  mcpServers: { name: string; tools: number; tokens: number }[]
  memoryFiles: { path: string; tokens: number }[]
  added: number
  removed: number
  base: string | null
}

export type Output = { label: string; kind: 'file' | 'artifact' }

declare module 'claude-code' {
  interface PluginState {
    'session-panel': {
      snapshot: Shaped<Snapshot | null>
      outputs: Shaped<Output[]>
      showMcp: boolean
      showMemory: boolean
    }
  }
}
