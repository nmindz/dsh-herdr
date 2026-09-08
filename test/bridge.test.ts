import assert from 'node:assert/strict'
import test from 'node:test'

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { DshHerdrBridge } from '../src/bridge.ts'
import type { MetadataSnapshot, StateReporter } from '../src/reporter.ts'
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

function collector(): {
  reporter: StateReporter
  updates: StateSnapshot[]
  display: MetadataSnapshot[]
  releases: () => number
} {
  const updates: StateSnapshot[] = []
  const display: MetadataSnapshot[] = []
  let releases = 0
  return {
    updates,
    display,
    releases: () => releases,
    reporter: {
      update: snapshot => updates.push(snapshot),
      metadata: snapshot => display.push(snapshot),
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
  assert.equal(updates.at(-1)?.state, 'idle')
  assert.equal(updates.at(-1)?.agentCount, 0)

  await bridge.dispose()
  await bridge.dispose()
  assert.equal(releases(), 1)
})

test('announce registers the pane with no agents present', async () => {
  const { reporter, updates } = collector()
  const bridge = new DshHerdrBridge(reporter)

  bridge.announce()
  await Promise.resolve()

  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.state, 'idle')
  assert.equal(updates[0]?.agentCount, 0)
})

test('sidebar tokens mirror the usagebar names and carry the rollup', async () => {
  const { reporter, display } = collector()
  const bridge = new DshHerdrBridge(reporter)

  bridge.setDisplay({ title: 'Herdr dsh integration', model: 'deepseek-v4-flash · max' })
  bridge.announce()
  await Promise.resolve()

  assert.deepEqual(display.at(-1), {
    displayAgent: 'dsh',
    tokens: {
      context: 'idle',
      dsh_context: 'idle',
      dsh_rollup: 'idle',
      title: 'Herdr dsh integration',
      dsh_title: 'Herdr dsh integration',
      dsh_model: 'deepseek-v4-flash · max',
    },
  })

  // The rollup stands in for $context until a real meter arrives.
  bridge.upsert(fakeAgent('root', 'running'))
  await Promise.resolve()
  assert.equal(display.at(-1)?.tokens.context, '1 agent working')

  bridge.setDisplay({ limit: 'Σ 128M', context: '⊙ 57% (575k)' })
  await Promise.resolve()
  assert.equal(display.at(-1)?.tokens.limit, 'Σ 128M')
  assert.equal(display.at(-1)?.tokens.dsh_limit, 'Σ 128M')
  assert.equal(display.at(-1)?.tokens.context, '⊙ 57% (575k)')
  // The rollup stays reachable on its own token once the meter takes over.
  assert.equal(display.at(-1)?.tokens.dsh_rollup, '1 agent working')
})

test('provider is left alone so a usage plugin keeps owning it', async () => {
  const { reporter, display } = collector()
  const bridge = new DshHerdrBridge(reporter)

  bridge.setDisplay({ model: 'deepseek-v4-flash · max' })
  bridge.announce()
  await Promise.resolve()

  assert.equal(display.at(-1)?.tokens.provider, undefined)
  assert.equal(display.at(-1)?.tokens.dsh_model, 'deepseek-v4-flash · max')
})

test('metadata stays optional on a reporter that does not implement it', async () => {
  const updates: StateSnapshot[] = []
  const bridge = new DshHerdrBridge({
    update: snapshot => updates.push(snapshot),
    release: async () => undefined,
  })

  bridge.announce()
  await Promise.resolve()
  assert.equal(updates.length, 1)
})

test('the root session id reaches the reporter', async () => {
  const { reporter, updates } = collector()
  const bridge = new DshHerdrBridge(reporter)

  bridge.setRootSession('root-session')
  bridge.upsert(fakeAgent('root', 'running'))
  await Promise.resolve()

  assert.equal(updates.at(-1)?.sessionId, 'root-session')
  assert.equal(updates.at(-1)?.state, 'working')
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
