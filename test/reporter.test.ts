import assert from 'node:assert/strict'
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
  }), {
    binary: '/opt/herdr',
    paneId: 'w1:p2',
  })
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
