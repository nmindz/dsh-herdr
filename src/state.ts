import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export type HerdrAgentState = 'idle' | 'working' | 'blocked'

export interface StateSnapshot {
  readonly state?: HerdrAgentState
  readonly agentCount: number
  readonly runningCount: number
  readonly approvalCount: number
  readonly message?: string
  /** Root DSH session id — the key `DSH_TUI_RESUME_SESSION` accepts. */
  readonly sessionId?: string
}

interface TrackedAgent {
  status: AgentStatus
  readonly approvals: Set<string>
}

interface ApprovalAskedEvent {
  readonly type: 'approval/asked'
  readonly data: { readonly id: unknown }
}

interface ApprovalDecidedEvent {
  readonly type: 'approval/decided'
  readonly data: { readonly id: unknown }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm
}

/** Fold both persisted seed events and live events into unresolved approval ids. */
export function unresolvedApprovals(events: readonly SessionEvent[]): Set<string> {
  const pending = new Set<string>()
  for (const event of events) {
    const type = event.type as string
    if (type === 'approval/asked') {
      const asked = event as unknown as ApprovalAskedEvent
      pending.add(String(asked.data.id))
    } else if (type === 'approval/decided') {
      const decided = event as unknown as ApprovalDecidedEvent
      pending.delete(String(decided.data.id))
    }
  }
  return pending
}

/** Process-local rollup for every root and child agent hosted by one DSH TUI. */
export class DshStateTracker {
  readonly #agents = new Map<string, TrackedAgent>()
  #rootSessionId?: string

  setRootSession(sessionId: string | undefined): void {
    this.#rootSessionId = sessionId
  }

  upsert(agentId: string, status: AgentStatus, approvals: Iterable<string> = []): void {
    const tracked = this.#agents.get(agentId)
    if (tracked !== undefined) {
      tracked.status = status
      tracked.approvals.clear()
      for (const approval of approvals) tracked.approvals.add(approval)
      return
    }
    this.#agents.set(agentId, { status, approvals: new Set(approvals) })
  }

  setStatus(agentId: string, status: AgentStatus): void {
    const tracked = this.#agents.get(agentId)
    if (tracked !== undefined) tracked.status = status
  }

  approvalAsked(agentId: string, approvalId: string): void {
    this.#agents.get(agentId)?.approvals.add(approvalId)
  }

  approvalDecided(agentId: string, approvalId: string): void {
    this.#agents.get(agentId)?.approvals.delete(approvalId)
  }

  dispose(agentId: string): void {
    this.#agents.delete(agentId)
  }

  snapshot(): StateSnapshot {
    const agents = [...this.#agents.values()]
    const agentCount = agents.length
    const runningCount = agents.filter(({ status }) => status === 'running').length
    const approvalCount = agents.reduce((count, { approvals }) => count + approvals.size, 0)
    const session = this.#rootSessionId === undefined ? {} : { sessionId: this.#rootSessionId }

    // A live DSH TUI holds the pane even before its first agent exists, so an
    // empty rollup is idle rather than a release — authority is only handed
    // back when the plugin unloads.
    if (agentCount === 0) return { state: 'idle', agentCount, runningCount, approvalCount, ...session }
    if (approvalCount > 0) {
      return {
        state: 'blocked',
        agentCount,
        runningCount,
        approvalCount,
        message: `${approvalCount} ${plural(approvalCount, 'approval')} waiting`,
        ...session,
      }
    }
    if (runningCount > 0) {
      return {
        state: 'working',
        agentCount,
        runningCount,
        approvalCount,
        message: `${runningCount} ${plural(runningCount, 'agent')} working`,
        ...session,
      }
    }
    return {
      state: 'idle',
      agentCount,
      runningCount,
      approvalCount,
      message: `${agentCount} ${plural(agentCount, 'agent')} idle`,
      ...session,
    }
  }
}
