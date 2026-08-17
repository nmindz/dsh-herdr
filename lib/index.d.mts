import { Context } from "@deepseek-ai/cordis";
import { Agent, AgentStatus } from "@deepseek-ai/dsh-agent";
import { SessionEvent } from "@deepseek-ai/dsh-session";
//#region src/state.d.ts
type HerdrAgentState = 'idle' | 'working' | 'blocked';
interface StateSnapshot {
  readonly state?: HerdrAgentState;
  readonly agentCount: number;
  readonly runningCount: number;
  readonly approvalCount: number;
  readonly message?: string;
}
/** Fold both persisted seed events and live events into unresolved approval ids. */
declare function unresolvedApprovals(events: readonly SessionEvent[]): Set<string>;
/** Process-local rollup for every root and child agent hosted by one DSH TUI. */
declare class DshStateTracker {
  #private;
  upsert(agentId: string, status: AgentStatus, approvals?: Iterable<string>): void;
  setStatus(agentId: string, status: AgentStatus): void;
  approvalAsked(agentId: string, approvalId: string): void;
  approvalDecided(agentId: string, approvalId: string): void;
  dispose(agentId: string): void;
  snapshot(): StateSnapshot;
}
//#endregion
//#region src/reporter.d.ts
declare const HERDR_SOURCE = "dsh:runtime";
declare const HERDR_AGENT = "dsh";
interface HerdrReporterConfig {
  readonly binary: string;
  readonly paneId: string;
  readonly socketPath?: string;
  readonly source?: string;
  readonly agent?: string;
  readonly timeoutMs?: number;
}
type RunHerdr = (binary: string, args: readonly string[], timeoutMs: number) => Promise<void>;
interface StateReporter {
  update(snapshot: StateSnapshot): void;
  release(): Promise<void>;
  close?(): Promise<void> | void;
}
type HerdrParams = Record<string, string | number>;
declare function reporterConfigFromEnv(env?: NodeJS.ProcessEnv): HerdrReporterConfig | undefined;
declare function runHerdr(binary: string, args: readonly string[], timeoutMs: number): Promise<void>;
/** Persistent newline-delimited JSON client for Unix sockets and Windows named pipes. */
declare class HerdrSocketClient {
  #private;
  constructor(socketPath: string);
  request(method: string, params: HerdrParams, timeoutMs: number): Promise<void>;
  close(): void;
}
/** Socket-first reporting with CLI fallback and cross-process sequenced updates. */
declare class HerdrReporter implements StateReporter {
  #private;
  constructor(config: HerdrReporterConfig, run?: RunHerdr, onError?: (error: unknown) => void);
  update(snapshot: StateSnapshot): void;
  release(): Promise<void>;
  close(): Promise<void>;
  whenIdle(): Promise<void>;
}
//#endregion
//#region src/bridge.d.ts
declare class DshHerdrBridge {
  #private;
  constructor(reporter: StateReporter);
  upsert(agent: Agent): void;
  setStatus(agentId: unknown, status: AgentStatus): void;
  sessionEvent(sessionId: unknown, event: SessionEvent): void;
  remove(agentId: unknown): void;
  dispose(): Promise<void>;
}
//#endregion
//#region src/index.d.ts
declare const name = "integration-herdr";
declare const inject: string[];
declare function apply(ctx: Context): void;
//#endregion
export { DshHerdrBridge, DshStateTracker, HERDR_AGENT, HERDR_SOURCE, HerdrAgentState, HerdrReporter, HerdrReporterConfig, HerdrSocketClient, RunHerdr, StateReporter, StateSnapshot, apply, inject, name, reporterConfigFromEnv, runHerdr, unresolvedApprovals };