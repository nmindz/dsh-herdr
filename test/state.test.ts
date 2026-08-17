import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { DshStateTracker, unresolvedApprovals } from '../src/state.ts'

test('state tracker prioritizes approvals, then running agents, then idle', () => {
  const tracker = new DshStateTracker()
  assert.deepEqual(tracker.snapshot(), {
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
  assert.equal(tracker.snapshot().state, undefined)
})

test('unresolved approvals are restored from a resumed session seed', () => {
  const events = [
    { type: 'approval/asked', data: { id: 'a' } },
    { type: 'approval/asked', data: { id: 'b' } },
    { type: 'approval/decided', data: { id: 'a' } },
  ] as unknown as SessionEvent[]

  assert.deepEqual([...unresolvedApprovals(events)], ['b'])
})
