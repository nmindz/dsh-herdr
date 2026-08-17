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

export interface StateReporter {
  update(snapshot: StateSnapshot): void
  release(): Promise<void>
  close?(): Promise<void> | void
}

type HerdrParams = Record<string, string | number>

interface PendingResponse {
  readonly socket: Socket
  readonly timer: NodeJS.Timeout
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

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

/** Persistent newline-delimited JSON client for Unix sockets and Windows named pipes. */
export class HerdrSocketClient {
  readonly #socketPath: string
  readonly #pending = new Map<string, PendingResponse>()
  #socket?: Socket
  #connecting?: Promise<Socket>
  #requestSequence = 0
  #closed = false

  constructor(socketPath: string) {
    this.#socketPath = socketPath
  }

  async request(method: string, params: HerdrParams, timeoutMs: number): Promise<void> {
    if (this.#closed) throw new Error('Herdr socket client is closed')
    const socket = await this.#connect(timeoutMs)
    const id = `dsh-herdr-${process.pid}-${++this.#requestSequence}`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Herdr socket request timed out after ${timeoutMs}ms`))
        this.#disconnect(socket, new Error('Herdr socket response timed out'))
      }, timeoutMs)
      timer.unref()
      this.#pending.set(id, { socket, timer, resolve, reject })

      socket.write(`${JSON.stringify({ id, method, params })}\n`, 'utf8', error => {
        if (error === undefined || error === null) return
        const pending = this.#takePending(id)
        pending?.reject(error)
        this.#disconnect(socket, error)
      })
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    const error = new Error('Herdr socket client closed')
    for (const id of [...this.#pending.keys()]) this.#takePending(id)?.reject(error)
    const socket = this.#socket
    this.#socket = undefined
    socket?.end()
    socket?.destroy()
  }

  #connect(timeoutMs: number): Promise<Socket> {
    if (this.#closed) return Promise.reject(new Error('Herdr socket client is closed'))
    if (this.#socket !== undefined && !this.#socket.destroyed) return Promise.resolve(this.#socket)
    if (this.#connecting !== undefined) return this.#connecting

    const connecting = new Promise<Socket>((resolve, reject) => {
      const socket = createConnection({ path: this.#socketPath })
      let connected = false
      let buffer = ''
      const connectionTimer = setTimeout(() => {
        const error = new Error(`Herdr socket connection timed out after ${timeoutMs}ms`)
        reject(error)
        this.#disconnect(socket, error)
      }, timeoutMs)
      connectionTimer.unref()

      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        buffer += chunk
        while (true) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) break
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line !== '') this.#handleLine(socket, line)
        }
      })
      socket.on('error', error => {
        clearTimeout(connectionTimer)
        if (!connected) reject(error)
        this.#disconnect(socket, error)
      })
      socket.on('close', () => {
        clearTimeout(connectionTimer)
        const error = new Error('Herdr socket connection closed')
        if (!connected) reject(error)
        this.#disconnect(socket, error)
      })
      socket.once('connect', () => {
        clearTimeout(connectionTimer)
        connected = true
        if (this.#closed) {
          socket.destroy()
          reject(new Error('Herdr socket client closed while connecting'))
          return
        }
        this.#socket = socket
        resolve(socket)
      })
    })

    this.#connecting = connecting
    void connecting.finally(() => {
      if (this.#connecting === connecting) this.#connecting = undefined
    }).catch(() => undefined)
    return connecting
  }

  #handleLine(socket: Socket, line: string): void {
    let response: HerdrResponse
    try {
      response = JSON.parse(line) as HerdrResponse
    } catch (error) {
      this.#disconnect(socket, new Error(`Invalid Herdr socket response: ${errorText(error)}`))
      return
    }

    const id = typeof response.id === 'string' || typeof response.id === 'number'
      ? String(response.id)
      : undefined
    if (id === undefined) return
    const pending = this.#pending.get(id)
    if (pending === undefined || pending.socket !== socket) return
    this.#takePending(id)

    if (response.error !== undefined && response.error !== null) {
      pending.reject(new Error(`Herdr socket error: ${errorText(response.error)}`))
    } else if (response.result !== undefined) {
      pending.resolve()
    } else {
      pending.reject(new Error('Herdr socket response has neither result nor error'))
    }
  }

  #takePending(id: string): PendingResponse | undefined {
    const pending = this.#pending.get(id)
    if (pending === undefined) return undefined
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    return pending
  }

  #disconnect(socket: Socket, error: Error): void {
    if (this.#socket === socket) this.#socket = undefined
    for (const [id, pending] of this.#pending) {
      if (pending.socket !== socket) continue
      this.#takePending(id)?.reject(error)
    }
    if (!socket.destroyed) socket.destroy()
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
    const desired = `${snapshot.state}\0${snapshot.message ?? ''}`
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
    this.#enqueue('pane.report_agent', params, args)
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
