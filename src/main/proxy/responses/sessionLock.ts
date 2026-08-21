interface LockWaiter {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abort?: () => void
}

interface LockState {
  waiters: LockWaiter[]
}

export class ResponsesSessionLock {
  private states = new Map<string, LockState>()

  acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    const normalizedKey = key.trim()
    if (!normalizedKey) return Promise.resolve(() => undefined)
    if (signal?.aborted) return Promise.reject(this.abortError())

    const state = this.states.get(normalizedKey)
    if (!state) {
      this.states = new Map(this.states).set(normalizedKey, { waiters: [] })
      return Promise.resolve(this.createRelease(normalizedKey))
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: LockWaiter = { resolve, reject, signal }
      if (signal) {
        waiter.abort = () => {
          const current = this.states.get(normalizedKey)
          if (!current) return
          const waiters = current.waiters.filter(candidate => candidate !== waiter)
          this.states = new Map(this.states).set(normalizedKey, { waiters })
          reject(this.abortError())
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      const nextState: LockState = { waiters: [...state.waiters, waiter] }
      this.states = new Map(this.states).set(normalizedKey, nextState)
    })
  }

  activeKeys(): number {
    return this.states.size
  }

  private createRelease(key: string): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const state = this.states.get(key)
      if (!state) return
      const [next, ...remaining] = state.waiters
      if (!next) {
        this.states = new Map(Array.from(this.states.entries()).filter(([entryKey]) => entryKey !== key))
        return
      }
      if (next.signal && next.abort) next.signal.removeEventListener('abort', next.abort)
      this.states = new Map(this.states).set(key, { waiters: remaining })
      next.resolve(this.createRelease(key))
    }
  }

  private abortError(): Error {
    return Object.assign(new Error('Responses session lock wait was aborted.'), {
      name: 'AbortError',
      code: 'responses_session_lock_aborted',
    })
  }
}

export const responsesSessionLock = new ResponsesSessionLock()
