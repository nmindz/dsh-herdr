import assert from 'node:assert/strict'
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

function testSocketPath(label: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-herdr-${label}-${unique}`
    : join(tmpdir(), `dsh-herdr-${label}-${unique}.sock`)
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
      seq: 1,
      message: '1 agent working',
    })
    assert.equal(requests[2]?.params.seq, 3)
  } finally {
    await reporter.close()
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

test('reporter serializes sequenced state and release commands', async () => {
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
  assert.deepEqual(calls[0], {
    binary: '/opt/herdr',
    timeoutMs: 123,
    args: [
      'pane', 'report-agent', 'w1:p2',
      '--source', 'dsh:runtime',
      '--agent', 'dsh',
      '--state', 'working',
      '--seq', '1',
      '--message', '1 agent working',
    ],
  })
  assert.equal(calls[1]?.args.at(-3), '2')
  assert.deepEqual(calls[2]?.args, [
    'pane', 'release-agent', 'w1:p2',
    '--source', 'dsh:runtime',
    '--agent', 'dsh',
    '--seq', '3',
  ])
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
