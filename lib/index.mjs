import { spawn } from "node:child_process";
//#region src/state.ts
function plural(count, singular, pluralForm = `${singular}s`) {
	return count === 1 ? singular : pluralForm;
}
/** Fold both persisted seed events and live events into unresolved approval ids. */
function unresolvedApprovals(events) {
	const pending = /* @__PURE__ */ new Set();
	for (const event of events) {
		const type = event.type;
		if (type === "approval/asked") {
			const asked = event;
			pending.add(String(asked.data.id));
		} else if (type === "approval/decided") {
			const decided = event;
			pending.delete(String(decided.data.id));
		}
	}
	return pending;
}
/** Process-local rollup for every root and child agent hosted by one DSH TUI. */
var DshStateTracker = class {
	#agents = /* @__PURE__ */ new Map();
	upsert(agentId, status, approvals = []) {
		const tracked = this.#agents.get(agentId);
		if (tracked !== void 0) {
			tracked.status = status;
			tracked.approvals.clear();
			for (const approval of approvals) tracked.approvals.add(approval);
			return;
		}
		this.#agents.set(agentId, {
			status,
			approvals: new Set(approvals)
		});
	}
	setStatus(agentId, status) {
		const tracked = this.#agents.get(agentId);
		if (tracked !== void 0) tracked.status = status;
	}
	approvalAsked(agentId, approvalId) {
		this.#agents.get(agentId)?.approvals.add(approvalId);
	}
	approvalDecided(agentId, approvalId) {
		this.#agents.get(agentId)?.approvals.delete(approvalId);
	}
	dispose(agentId) {
		this.#agents.delete(agentId);
	}
	snapshot() {
		const agents = [...this.#agents.values()];
		const agentCount = agents.length;
		const runningCount = agents.filter(({ status }) => status === "running").length;
		const approvalCount = agents.reduce((count, { approvals }) => count + approvals.size, 0);
		if (agentCount === 0) return {
			agentCount,
			runningCount,
			approvalCount
		};
		if (approvalCount > 0) return {
			state: "blocked",
			agentCount,
			runningCount,
			approvalCount,
			message: `${approvalCount} ${plural(approvalCount, "approval")} waiting`
		};
		if (runningCount > 0) return {
			state: "working",
			agentCount,
			runningCount,
			approvalCount,
			message: `${runningCount} ${plural(runningCount, "agent")} working`
		};
		return {
			state: "idle",
			agentCount,
			runningCount,
			approvalCount,
			message: `${agentCount} ${plural(agentCount, "agent")} idle`
		};
	}
};
//#endregion
//#region src/bridge.ts
var DshHerdrBridge = class {
	#reporter;
	#tracker = new DshStateTracker();
	#scheduled = false;
	#disposed = false;
	constructor(reporter) {
		this.#reporter = reporter;
	}
	upsert(agent) {
		this.#tracker.upsert(String(agent.id), agent.status, unresolvedApprovals(agent.session.events));
		this.#changed();
	}
	setStatus(agentId, status) {
		this.#tracker.setStatus(String(agentId), status);
		this.#changed();
	}
	sessionEvent(sessionId, event) {
		const type = event.type;
		if (type !== "approval/asked" && type !== "approval/decided") return;
		const approval = event;
		if (type === "approval/asked") this.#tracker.approvalAsked(String(sessionId), String(approval.data.id));
		else this.#tracker.approvalDecided(String(sessionId), String(approval.data.id));
		this.#changed();
	}
	remove(agentId) {
		this.#tracker.dispose(String(agentId));
		this.#changed();
	}
	async dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		await this.#reporter.release();
	}
	#changed() {
		if (this.#disposed || this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			if (!this.#disposed) this.#reporter.update(this.#tracker.snapshot());
		});
	}
};
//#endregion
//#region src/reporter.ts
const HERDR_SOURCE = "dsh:runtime";
const HERDR_AGENT = "dsh";
function reporterConfigFromEnv(env = process.env) {
	if (env.HERDR_ENV !== "1") return void 0;
	const paneId = env.HERDR_PANE_ID?.trim();
	if (paneId === void 0 || paneId === "") return void 0;
	return {
		binary: env.HERDR_BIN_PATH?.trim() || "herdr",
		paneId
	};
}
function runHerdr(binary, args, timeoutMs) {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, [...args], {
			env: process.env,
			stdio: "ignore",
			windowsHide: true
		});
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error === void 0) resolve();
			else reject(error);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(/* @__PURE__ */ new Error(`Herdr command timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref();
		child.once("error", finish);
		child.once("close", (code, signal) => {
			if (code === 0) finish();
			else finish(/* @__PURE__ */ new Error(`Herdr command exited with ${code ?? signal ?? "unknown status"}`));
		});
	});
}
/** Serialize reports so older subprocesses can never overwrite newer state. */
var HerdrReporter = class {
	#binary;
	#paneId;
	#source;
	#agent;
	#timeoutMs;
	#run;
	#onError;
	#sequence = 0;
	#lastDesired;
	#released = true;
	#queue = Promise.resolve();
	constructor(config, run = runHerdr, onError = () => void 0) {
		this.#binary = config.binary;
		this.#paneId = config.paneId;
		this.#source = config.source ?? "dsh:runtime";
		this.#agent = config.agent ?? "dsh";
		this.#timeoutMs = config.timeoutMs ?? 3e3;
		this.#run = run;
		this.#onError = onError;
	}
	update(snapshot) {
		if (snapshot.state === void 0) {
			this.release();
			return;
		}
		const desired = `${snapshot.state}\0${snapshot.message ?? ""}`;
		if (!this.#released && desired === this.#lastDesired) return;
		this.#released = false;
		this.#lastDesired = desired;
		const args = [
			"pane",
			"report-agent",
			this.#paneId,
			"--source",
			this.#source,
			"--agent",
			this.#agent,
			"--state",
			snapshot.state,
			"--seq",
			String(++this.#sequence)
		];
		if (snapshot.message !== void 0) args.push("--message", snapshot.message);
		this.#enqueue(args);
	}
	release() {
		if (this.#released) return this.#queue;
		this.#released = true;
		this.#lastDesired = void 0;
		this.#enqueue([
			"pane",
			"release-agent",
			this.#paneId,
			"--source",
			this.#source,
			"--agent",
			this.#agent,
			"--seq",
			String(++this.#sequence)
		]);
		return this.#queue;
	}
	whenIdle() {
		return this.#queue;
	}
	#enqueue(args) {
		this.#queue = this.#queue.then(() => this.#run(this.#binary, args, this.#timeoutMs)).catch((error) => this.#onError(error));
	}
};
//#endregion
//#region src/index.ts
const name = "integration-herdr";
const inject = ["agents"];
function apply(ctx) {
	const config = reporterConfigFromEnv();
	if (config === void 0) return;
	const logger = ctx.logger("dsh-herdr");
	const bridge = new DshHerdrBridge(new HerdrReporter(config, void 0, (error) => {
		logger.warn("Herdr state report failed: %s", error instanceof Error ? error.message : String(error));
	}));
	ctx.effect(() => async () => bridge.dispose(), "dsh-herdr reporter");
	for (const agent of ctx.agents.list()) bridge.upsert(agent);
	ctx.on("agent/created", ({ agent }) => bridge.upsert(agent));
	ctx.on("agent/status", ({ agent, status }) => bridge.setStatus(agent.id, status));
	ctx.on("agent/disposed", ({ agent }) => bridge.remove(agent.id));
	ctx.on("session/event", (session, event) => {
		bridge.sessionEvent(session.id, event);
	});
}
//#endregion
export { DshHerdrBridge, DshStateTracker, HERDR_AGENT, HERDR_SOURCE, HerdrReporter, apply, inject, name, reporterConfigFromEnv, runHerdr, unresolvedApprovals };
