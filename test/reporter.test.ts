import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  HerdrReporter,
  reporterConfigFromEnv,
  type RunHerdr,
} from '../src/reporter.ts'

test('environment config only enables reporting inside a Herdr pane', () => {
  assert.equal(reporterConfigFromEnv({}), undefined)
  assert.equal(reporterConfigFromEnv({ HERDR_ENV: '1' }), undefined)
  assert.deepEqual(reporterConfigFromEnv({
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'w1:p2',
    HERDR_BIN_PATH: '/opt/herdr',
    HERDR_SOCKET_PATH: '/run/herdr.sock',
  }), {
    binary: '/opt/herdr',
    paneId: 'w1:p2',
    socketPath: '/run/herdr.sock',
  })
})

/**
 * Longest `sockaddr_un.sun_path` accepted by macOS and the BSDs, including the
 * terminating NUL. Linux allows 108; 104 is the portable floor.
 */
const SUN_PATH_MAX = 104

function testSocketPath(label: string): string {
  const unique = randomBytes(4).toString('hex')
  if (process.platform === 'win32') return `\\\\.\\pipe\\dsh-herdr-${label}-${unique}`
  // macOS hands each user a ~48-byte TMPDIR, so the file name has to stay short:
  // a pid+timestamp+random suffix overflows sun_path and listen() fails with
  // EINVAL long before anything about the reporter is exercised.
  const path = join(tmpdir(), `dsh-${label}-${unique}.sock`)
  assert.ok(
    Buffer.byteLength(path) < SUN_PATH_MAX,
    `test socket path is ${Buffer.byteLength(path)} bytes; sun_path allows ${SUN_PATH_MAX - 1}: ${path}`,
  )
  return path
}

test('reporter reuses one persistent socket and sends Herdr NDJSON methods', async () => {
  const socketPath = testSocketPath('persistent')
  const requests: Array<{ id: string, method: string, params: Record<string, unknown> }> = []
  let connections = 0
  const server = createServer(socket => {
    connections += 1
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const request = JSON.parse(line) as typeof requests[number]
        requests.push(request)
        socket.write(`${JSON.stringify({ id: request.id, result: { type: 'ok' } })}\n`)
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })

  const cliCalls: string[][] = []
  const reporter = new HerdrReporter({
    binary: 'herdr',
    paneId: 'w1:p3',
    socketPath,
    timeoutMs: 1_000,
  }, async (_binary, args) => { cliCalls.push([...args]) })

  try {
    reporter.update({
      state: 'working', agentCount: 1, runningCount: 1, approvalCount: 0, message: '1 agent working',
    })
    reporter.update({
      state: 'blocked', agentCount: 1, runningCount: 1, approvalCount: 1, message: '1 approval waiting',
    })
    await reporter.release()
    await reporter.close()

    assert.equal(connections, 1)
    assert.equal(cliCalls.length, 0)
    assert.deepEqual(requests.map(({ method }) => method), [
      'pane.report_agent',
      'pane.report_agent',
      'pane.release_agent',
    ])
    assert.deepEqual(requests[0]?.params, {
      pane_id: 'w1:p3',
      source: 'dsh:runtime',
      agent: 'dsh',
      state: 'working',
      seq: requests[0]?.params.seq,
      message: '1 agent working',
    })
    const sequences = requests.map(({ params }) => params.seq)
    assert.equal(sequences.every(sequence => typeof sequence === 'number'), true)
    assert.equal(Number(sequences[0]) < Number(sequences[1]), true)
    assert.equal(Number(sequences[1]) < Number(sequences[2]), true)
  } finally {
    await reporter.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('a new DSH process can report again after release in the same pane', async () => {
  const socketPath = testSocketPath('restart')
  let state: string | undefined
  let lastSequence: number | undefined
  const requests: Array<{ id: string, method: string, params: Record<string, unknown> }> = []
  const server = createServer(socket => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const request = JSON.parse(line) as typeof requests[number]
        requests.push(request)

        // Model Herdr's same-source sequence watermark across process restarts.
        const sequence = typeof request.params.seq === 'number' ? request.params.seq : undefined
        const accepted = sequence === undefined
          || lastSequence === undefined
          || sequence > lastSequence
        if (accepted) {
          if (sequence !== undefined) lastSequence = sequence
          state = request.method === 'pane.report_agent'
            ? String(request.params.state)
            : undefined
        }
        socket.write(`${JSON.stringify({ id: request.id, result: { type: 'ok' } })}\n`)
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })

  const cliCalls: string[][] = []
  const createReporter = () => new HerdrReporter({
    binary: 'herdr',
    paneId: 'w1:p5',
    socketPath,
    timeoutMs: 1_000,
  }, async (_binary, args) => { cliCalls.push([...args]) })
  const first = createReporter()
  const second = createReporter()

  try {
    first.update({ state: 'working', agentCount: 1, runningCount: 1, approvalCount: 0 })
    await first.whenIdle()
    assert.equal(state, 'working')
    await first.release()
    assert.equal(state, undefined)
    await first.close()

    second.update({ state: 'idle', agentCount: 1, runningCount: 0, approvalCount: 0 })
    await second.whenIdle()
    assert.equal(state, 'idle')
    const sequences = requests.map(({ params }) => Number(params.seq))
    assert.equal(sequences.every(Number.isSafeInteger), true)
    assert.equal(sequences[2]! > sequences[1]!, true)
    assert.equal(cliCalls.length, 0)
  } finally {
    await first.close()
    await second.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('reporter falls back to CLI when the socket cannot connect', async () => {
  const calls: string[][] = []
  const errors: unknown[] = []
  const reporter = new HerdrReporter({
    binary: '/opt/herdr',
    paneId: 'w1:p4',
    socketPath: testSocketPath('missing'),
    timeoutMs: 200,
  }, async (_binary, args) => { calls.push([...args]) }, error => errors.push(error))

  reporter.update({ state: 'idle', agentCount: 1, runningCount: 0, approvalCount: 0 })
  await reporter.whenIdle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.[1], 'report-agent')
  assert.equal(errors.length, 0)
  await reporter.close()
  assert.equal(calls[1]?.[1], 'release-agent')
})

test('reporter serializes state and release commands with epoch-based sequence numbers', async () => {
  const calls: Array<{ binary: string, args: readonly string[], timeoutMs: number }> = []
  const run: RunHerdr = async (binary, args, timeoutMs) => {
    calls.push({ binary, args: [...args], timeoutMs })
  }
  const reporter = new HerdrReporter({
    binary: '/opt/herdr',
    paneId: 'w1:p2',
    timeoutMs: 123,
  }, run)

  reporter.update({
    state: 'working', agentCount: 1, runningCount: 1, approvalCount: 0, message: '1 agent working',
  })
  reporter.update({
    state: 'working', agentCount: 1, runningCount: 1, approvalCount: 0, message: '1 agent working',
  })
  reporter.update({
    state: 'blocked', agentCount: 1, runningCount: 1, approvalCount: 1, message: '1 approval waiting',
  })
  await reporter.release()

  assert.equal(calls.length, 3)
  assert.equal(calls[0]?.binary, '/opt/herdr')
  assert.equal(calls[0]?.timeoutMs, 123)
  assert.deepEqual(calls[0]?.args.slice(0, 9), [
    'pane', 'report-agent', 'w1:p2',
    '--source', 'dsh:runtime',
    '--agent', 'dsh',
    '--state', 'working',
  ])
  assert.equal(calls[0]?.args.at(9), '--seq')
  assert.equal(Number.isSafeInteger(Number(calls[0]?.args.at(10))), true)
  assert.deepEqual(calls[0]?.args.slice(11), ['--message', '1 agent working'])
  assert.deepEqual(calls[2]?.args.slice(0, 7), [
    'pane', 'release-agent', 'w1:p2',
    '--source', 'dsh:runtime',
    '--agent', 'dsh',
  ])
  assert.equal(calls[2]?.args.at(7), '--seq')
  assert.equal(Number(calls[2]?.args.at(8)) > Number(calls[0]?.args.at(10)), true)
})

test('an empty process rollup releases existing Herdr authority', async () => {
  const calls: readonly string[][] = []
  const run: RunHerdr = async (_binary, args) => {
    ;(calls as string[][]).push([...args])
  }
  const reporter = new HerdrReporter({ binary: 'herdr', paneId: 'w1:p1' }, run)
  reporter.update({ state: 'idle', agentCount: 1, runningCount: 0, approvalCount: 0 })
  reporter.update({ agentCount: 0, runningCount: 0, approvalCount: 0 })
  await reporter.whenIdle()
  assert.equal(calls.length, 2)
  assert.equal(calls[1]?.[1], 'release-agent')
})
