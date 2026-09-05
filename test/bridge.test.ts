import assert from 'node:assert/strict'
import test from 'node:test'

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { DshHerdrBridge } from '../src/bridge.ts'
import type { StateReporter } from '../src/reporter.ts'
import type { StateSnapshot } from '../src/state.ts'

/**
 * Build a stand-in Agent whose session log is fixed.
 *
 * The session half is typed as `Pick<Session, 'snapshotEvents'>` on purpose:
 * a rename or signature change on the accessor the bridge actually calls
 * fails this file at compile time instead of at DSH boot.
 */
function fakeAgent(id: string, status: string, events: readonly SessionEvent[] = []): Agent {
  const session: Pick<Session, 'snapshotEvents'> = { snapshotEvents: () => events }
  return { id, status, session } as unknown as Agent
}

function approval(type: 'approval/asked' | 'approval/decided', id: string): SessionEvent {
  return { type, data: { id } } as unknown as SessionEvent
}

function collector(): { reporter: StateReporter; updates: StateSnapshot[]; releases: () => number } {
  const updates: StateSnapshot[] = []
  let releases = 0
  return {
    updates,
    releases: () => releases,
    reporter: {
      update: snapshot => updates.push(snapshot),
      release: async () => { releases += 1 },
    },
  }
}

test('bridge coalesces synchronous DSH events and releases on disposal', async () => {
  const { reporter, updates, releases } = collector()
  const bridge = new DshHerdrBridge(reporter)
  const agent = fakeAgent('root', 'idle')

  bridge.upsert(agent)
  bridge.setStatus(agent.id, 'running')
  bridge.sessionEvent(agent.id, approval('approval/asked', 'approval-1'))
  await Promise.resolve()

  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.state, 'blocked')

  bridge.sessionEvent(agent.id, approval('approval/decided', 'approval-1'))
  bridge.setStatus(agent.id, 'idle')
  await Promise.resolve()
  assert.equal(updates.at(-1)?.state, 'idle')

  bridge.remove(agent.id)
  await Promise.resolve()
  assert.equal(updates.at(-1)?.state, undefined)

  await bridge.dispose()
  await bridge.dispose()
  assert.equal(releases(), 1)
})

test('upsert seeds unresolved approvals from the existing session log', async () => {
  const { reporter, updates } = collector()
  const bridge = new DshHerdrBridge(reporter)

  // A resumed agent whose log already carries one unanswered approval.
  bridge.upsert(fakeAgent('resumed', 'idle', [
    approval('approval/asked', 'seeded-1'),
    approval('approval/asked', 'seeded-2'),
    approval('approval/decided', 'seeded-1'),
  ]))
  await Promise.resolve()

  assert.equal(updates.at(-1)?.state, 'blocked')
  assert.equal(updates.at(-1)?.approvalCount, 1)
})
