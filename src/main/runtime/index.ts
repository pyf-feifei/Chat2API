import type { RuntimeAdapter } from './types'
import { nodeRuntime } from './nodeRuntime'

let runtime: RuntimeAdapter = nodeRuntime

export function setRuntime(nextRuntime: RuntimeAdapter): void {
  runtime = nextRuntime
}

export function getRuntime(): RuntimeAdapter {
  return runtime
}

export type { RuntimeAdapter }
