import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { DshStateTracker, unresolvedApprovals } from '../src/state.ts'

test('state tracker prioritizes approvals, then running agents, then idle', () => {
  const tracker = new DshStateTracker()
  assert.deepEqual(tracker.snapshot(), {
    state: 'idle',
    agentCount: 0,
    runningCount: 0,
    approvalCount: 0,
  })

  tracker.upsert('root', 'idle')
  assert.equal(tracker.snapshot().state, 'idle')

  tracker.upsert('child', 'running')
  assert.deepEqual(tracker.snapshot(), {
    state: 'working',
    agentCount: 2,
    runningCount: 1,
    approvalCount: 0,
    message: '1 agent working',
  })

  tracker.approvalAsked('root', 'approval-1')
  assert.deepEqual(tracker.snapshot(), {
    state: 'blocked',
    agentCount: 2,
    runningCount: 1,
    approvalCount: 1,
    message: '1 approval waiting',
  })

  tracker.approvalDecided('root', 'approval-1')
  assert.equal(tracker.snapshot().state, 'working')
  tracker.setStatus('child', 'idle')
  assert.equal(tracker.snapshot().state, 'idle')

  tracker.dispose('root')
  tracker.dispose('child')
  assert.equal(tracker.snapshot().state, 'idle')
})

test('an idle DSH TUI claims its pane before the first agent exists', () => {
  const tracker = new DshStateTracker()

  // No agent yet: the pane still has to register, so this must not be a release.
  assert.equal(tracker.snapshot().state, 'idle')
  assert.equal(tracker.snapshot().agentCount, 0)
  assert.equal(tracker.snapshot().message, undefined)
})

test('the root session id rides along with every rollup', () => {
  const tracker = new DshStateTracker()

  assert.equal(tracker.snapshot().sessionId, undefined)

  tracker.setRootSession('a58abc25-990d-4d54-b46d-061c97a7197d')
  assert.equal(tracker.snapshot().sessionId, 'a58abc25-990d-4d54-b46d-061c97a7197d')

  tracker.upsert('root', 'running')
  assert.deepEqual(tracker.snapshot(), {
    state: 'working',
    agentCount: 1,
    runningCount: 1,
    approvalCount: 0,
    message: '1 agent working',
    sessionId: 'a58abc25-990d-4d54-b46d-061c97a7197d',
  })

  tracker.setRootSession(undefined)
  assert.equal(tracker.snapshot().sessionId, undefined)
})

test('unresolved approvals are restored from a resumed session seed', () => {
  const events = [
    { type: 'approval/asked', data: { id: 'a' } },
    { type: 'approval/asked', data: { id: 'b' } },
    { type: 'approval/decided', data: { id: 'a' } },
  ] as unknown as SessionEvent[]

  assert.deepEqual([...unresolvedApprovals(events)], ['b'])
})
