import { spawn } from 'node:child_process'

import type { StateSnapshot } from './state.ts'

export const HERDR_SOURCE = 'dsh:runtime'
export const HERDR_AGENT = 'dsh'

export interface HerdrReporterConfig {
  readonly binary: string
  readonly paneId: string
  readonly source?: string
  readonly agent?: string
  readonly timeoutMs?: number
}

export type RunHerdr = (binary: string, args: readonly string[], timeoutMs: number) => Promise<void>

export interface StateReporter {
  update(snapshot: StateSnapshot): void
  release(): Promise<void>
}

export function reporterConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HerdrReporterConfig | undefined {
  if (env.HERDR_ENV !== '1') return undefined
  const paneId = env.HERDR_PANE_ID?.trim()
  if (paneId === undefined || paneId === '') return undefined
  return {
    binary: env.HERDR_BIN_PATH?.trim() || 'herdr',
    paneId,
  }
}

export function runHerdr(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    })
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`Herdr command timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()
    child.once('error', finish)
    child.once('close', (code, signal) => {
      if (code === 0) finish()
      else finish(new Error(`Herdr command exited with ${code ?? signal ?? 'unknown status'}`))
    })
  })
}

/** Serialize reports so older subprocesses can never overwrite newer state. */
export class HerdrReporter implements StateReporter {
  readonly #binary: string
  readonly #paneId: string
  readonly #source: string
  readonly #agent: string
  readonly #timeoutMs: number
  readonly #run: RunHerdr
  readonly #onError: (error: unknown) => void
  #sequence = 0
  #lastDesired?: string
  #released = true
  #queue: Promise<void> = Promise.resolve()

  constructor(
    config: HerdrReporterConfig,
    run: RunHerdr = runHerdr,
    onError: (error: unknown) => void = () => undefined,
  ) {
    this.#binary = config.binary
    this.#paneId = config.paneId
    this.#source = config.source ?? HERDR_SOURCE
    this.#agent = config.agent ?? HERDR_AGENT
    this.#timeoutMs = config.timeoutMs ?? 3_000
    this.#run = run
    this.#onError = onError
  }

  update(snapshot: StateSnapshot): void {
    if (snapshot.state === undefined) {
      void this.release()
      return
    }
    const desired = `${snapshot.state}\0${snapshot.message ?? ''}`
    if (!this.#released && desired === this.#lastDesired) return
    this.#released = false
    this.#lastDesired = desired
    const args = [
      'pane', 'report-agent', this.#paneId,
      '--source', this.#source,
      '--agent', this.#agent,
      '--state', snapshot.state,
      '--seq', String(++this.#sequence),
    ]
    if (snapshot.message !== undefined) args.push('--message', snapshot.message)
    this.#enqueue(args)
  }

  release(): Promise<void> {
    if (this.#released) return this.#queue
    this.#released = true
    this.#lastDesired = undefined
    this.#enqueue([
      'pane', 'release-agent', this.#paneId,
      '--source', this.#source,
      '--agent', this.#agent,
      '--seq', String(++this.#sequence),
    ])
    return this.#queue
  }

  whenIdle(): Promise<void> {
    return this.#queue
  }

  #enqueue(args: readonly string[]): void {
    this.#queue = this.#queue
      .then(() => this.#run(this.#binary, args, this.#timeoutMs))
      .catch(error => this.#onError(error))
  }
}
