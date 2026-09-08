import { spawn } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { performance } from 'node:perf_hooks'

import type { StateSnapshot } from './state.ts'

export const HERDR_SOURCE = 'dsh:runtime'
export const HERDR_AGENT = 'dsh'

export interface HerdrReporterConfig {
  readonly binary: string
  readonly paneId: string
  readonly socketPath?: string
  readonly source?: string
  readonly agent?: string
  readonly timeoutMs?: number
}

export type RunHerdr = (binary: string, args: readonly string[], timeoutMs: number) => Promise<void>

/** Display-only sidebar fields; Herdr keeps these out of state and waits. */
export interface MetadataSnapshot {
  readonly displayAgent?: string
  readonly tokens: Readonly<Record<string, string>>
}

export interface StateReporter {
  update(snapshot: StateSnapshot): void
  release(): Promise<void>
  metadata?(snapshot: MetadataSnapshot): void
  close?(): Promise<void> | void
}

type HerdrParams = Record<string, string | number | Readonly<Record<string, string>>>

interface HerdrResponse {
  readonly id?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function reporterConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HerdrReporterConfig | undefined {
  if (env.HERDR_ENV !== '1') return undefined
  const paneId = env.HERDR_PANE_ID?.trim()
  if (paneId === undefined || paneId === '') return undefined
  const socketPath = env.HERDR_SOCKET_PATH?.trim()
  return {
    binary: env.HERDR_BIN_PATH?.trim() || 'herdr',
    paneId,
    ...(socketPath === undefined || socketPath === '' ? {} : { socketPath }),
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

/**
 * Newline-delimited JSON client for Unix sockets and Windows named pipes.
 *
 * Herdr serves one request per connection and hangs up after answering, so
 * every request dials its own socket. Holding one open and writing a second
 * request to it earns an EPIPE, which is silent here: the report is dropped
 * and the pane keeps whatever state it had.
 */
export class HerdrSocketClient {
  readonly #socketPath: string
  readonly #open = new Set<Socket>()
  #requestSequence = 0
  #closed = false

  constructor(socketPath: string) {
    this.#socketPath = socketPath
  }

  request(method: string, params: HerdrParams, timeoutMs: number): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Herdr socket client is closed'))
    const id = `dsh-herdr-${process.pid}-${++this.#requestSequence}`

    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.#socketPath })
      this.#open.add(socket)
      let settled = false
      let buffer = ''

      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#open.delete(socket)
        if (!socket.destroyed) socket.destroy()
        if (error === undefined) resolve()
        else reject(error)
      }

      const timer = setTimeout(
        () => finish(new Error(`Herdr socket request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
      timer.unref()

      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline).trim()
        if (line !== '') finish(this.#responseError(line, id))
      })
      socket.on('error', error => finish(error))
      socket.on('close', () => finish(new Error('Herdr socket connection closed')))
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`, 'utf8', error => {
          if (error !== undefined && error !== null) finish(error)
        })
      })
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const socket of [...this.#open]) socket.destroy()
    this.#open.clear()
  }

  /** The error a response line represents, or undefined when it succeeded. */
  #responseError(line: string, id: string): Error | undefined {
    let response: HerdrResponse
    try {
      response = JSON.parse(line) as HerdrResponse
    } catch (error) {
      return new Error(`Invalid Herdr socket response: ${errorText(error)}`)
    }
    const responseId = typeof response.id === 'string' || typeof response.id === 'number'
      ? String(response.id)
      : undefined
    if (responseId !== undefined && responseId !== id) {
      return new Error(`Herdr socket response id ${responseId} does not match ${id}`)
    }
    if (response.error !== undefined && response.error !== null) {
      return new Error(`Herdr socket error: ${errorText(response.error)}`)
    }
    if (response.result === undefined) {
      return new Error('Herdr socket response has neither result nor error')
    }
    return undefined
  }
}

/** Socket-first reporting with CLI fallback and cross-process sequenced updates. */
export class HerdrReporter implements StateReporter {
  readonly #binary: string
  readonly #paneId: string
  readonly #source: string
  readonly #agent: string
  readonly #timeoutMs: number
  readonly #run: RunHerdr
  readonly #onError: (error: unknown) => void
  readonly #socket?: HerdrSocketClient
  #sequence = 0
  #lastDesired?: string
  #lastMetadata?: string
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
    if (config.socketPath !== undefined) this.#socket = new HerdrSocketClient(config.socketPath)
  }

  update(snapshot: StateSnapshot): void {
    if (snapshot.state === undefined) {
      void this.release()
      return
    }
    const desired = `${snapshot.state}\0${snapshot.message ?? ''}\0${snapshot.sessionId ?? ''}`
    if (!this.#released && desired === this.#lastDesired) return
    this.#released = false
    this.#lastDesired = desired
    const seq = this.#nextSequence()
    const params: HerdrParams = {
      pane_id: this.#paneId,
      source: this.#source,
      agent: this.#agent,
      state: snapshot.state,
      seq,
    }
    const args = [
      'pane', 'report-agent', this.#paneId,
      '--source', this.#source,
      '--agent', this.#agent,
      '--state', snapshot.state,
      '--seq', String(seq),
    ]
    if (snapshot.message !== undefined) {
      params.message = snapshot.message
      args.push('--message', snapshot.message)
    }
    if (snapshot.sessionId !== undefined) {
      params.agent_session_id = snapshot.sessionId
      args.push('--agent-session-id', snapshot.sessionId)
    }
    this.#enqueue('pane.report_agent', params, args)
  }

  /**
   * Presentation rides a sibling source so it never competes with the
   * lifecycle authority reported above.
   */
  metadata(snapshot: MetadataSnapshot): void {
    const desired = JSON.stringify([snapshot.displayAgent ?? '', snapshot.tokens])
    if (desired === this.#lastMetadata) return
    this.#lastMetadata = desired
    const source = `${this.#source}-display`
    const seq = this.#nextSequence()
    const params: HerdrParams = {
      pane_id: this.#paneId,
      source,
      agent: this.#agent,
      seq,
      tokens: snapshot.tokens,
    }
    const args = [
      'pane', 'report-metadata', this.#paneId,
      '--source', source,
      '--agent', this.#agent,
      '--seq', String(seq),
    ]
    for (const [name, value] of Object.entries(snapshot.tokens)) args.push('--token', `${name}=${value}`)
    if (snapshot.displayAgent !== undefined) {
      params.display_agent = snapshot.displayAgent
      args.push('--display-agent', snapshot.displayAgent)
    }
    this.#enqueue('pane.report_metadata', params, args)
  }

  release(): Promise<void> {
    if (this.#released) return this.#queue
    this.#released = true
    this.#lastDesired = undefined
    const seq = this.#nextSequence()
    this.#enqueue('pane.release_agent', {
      pane_id: this.#paneId,
      source: this.#source,
      agent: this.#agent,
      seq,
    }, [
      'pane', 'release-agent', this.#paneId,
      '--source', this.#source,
      '--agent', this.#agent,
      '--seq', String(seq),
    ])
    return this.#queue
  }

  async close(): Promise<void> {
    await this.release()
    this.#socket?.close()
  }

  whenIdle(): Promise<void> {
    return this.#queue
  }

  #nextSequence(): number {
    // Epoch microseconds remain below Number.MAX_SAFE_INTEGER until the 23rd
    // century and, unlike a process-local counter, advance across DSH restarts.
    const epochMicros = Math.floor((performance.timeOrigin + performance.now()) * 1_000)
    this.#sequence = Math.max(this.#sequence + 1, epochMicros)
    return this.#sequence
  }

  #enqueue(method: string, params: HerdrParams, args: readonly string[]): void {
    this.#queue = this.#queue
      .then(async () => {
        let socketError: unknown
        if (this.#socket !== undefined) {
          try {
            await this.#socket.request(method, params, this.#timeoutMs)
            return
          } catch (error) {
            socketError = error
          }
        }

        try {
          await this.#run(this.#binary, args, this.#timeoutMs)
        } catch (cliError) {
          if (socketError === undefined) throw cliError
          throw new AggregateError(
            [socketError, cliError],
            `Herdr socket and CLI fallback failed: ${errorText(socketError)}; ${errorText(cliError)}`,
          )
        }
      })
      .catch(error => this.#onError(error))
  }
}
