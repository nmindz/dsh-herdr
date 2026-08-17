import assert from 'node:assert/strict'
import test from 'node:test'

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { DshHerdrBridge } from '../src/bridge.ts'
import type { StateReporter } from '../src/reporter.ts'
import type { StateSnapshot } from '../src/state.ts'

test('bridge coalesces synchronous DSH events and releases on disposal', async () => {
  const updates: StateSnapshot[] = []
  let releases = 0
  const reporter: StateReporter = {
    update: snapshot => updates.push(snapshot),
    release: async () => { releases += 1 },
  }
  const bridge = new DshHerdrBridge(reporter)
  const agent = {
    id: 'root',
    status: 'idle',
    session: { events: [] },
  } as unknown as Agent

  bridge.upsert(agent)
  bridge.setStatus(agent.id, 'running')
  bridge.sessionEvent(agent.id, {
    type: 'approval/asked',
    data: { id: 'approval-1' },
  } as unknown as SessionEvent)
  await Promise.resolve()

  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.state, 'blocked')

  bridge.sessionEvent(agent.id, {
    type: 'approval/decided',
    data: { id: 'approval-1' },
  } as unknown as SessionEvent)
  bridge.setStatus(agent.id, 'idle')
  await Promise.resolve()
  assert.equal(updates.at(-1)?.state, 'idle')

  bridge.remove(agent.id)
  await Promise.resolve()
  assert.equal(updates.at(-1)?.state, undefined)

  await bridge.dispose()
  await bridge.dispose()
  assert.equal(releases, 1)
})
