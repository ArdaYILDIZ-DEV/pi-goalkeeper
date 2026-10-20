/** Goalkeeper: branch-local, bounded continuation for Pi. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cloneGoal, nowSeconds, validateObjective, validateTokenBudget, sanitizeDisplayText,
	restoreGoal, usageTokens, MAX_RESPONSES, MAX_ERROR_RETRIES, retryDelay, waitForRetry,
	type Goal, type GoalStatus, type PersistedGoalState } from "./state.ts";
import { continuationPrompt, activeGoalSystemPrompt, budgetLimitMessage } from "./prompts.ts";
import { createGoalStatus } from "./status.ts";

// Keep these existing wire identities to preserve sessions and tool callers.
const STATE_TYPE = "goal";
const UI_MESSAGE_TYPE = "goal-ui";
const CONTINUATION_MESSAGE_TYPE = "goal-continuation";

/** One branch-local session owns mutations, persistence and all lifecycle hooks. */
export function createGoalSession(pi: ExtensionAPI) {
	let goal: Goal | null = null;
	let activeSinceMs: number | null = null;
	let elapsedRemainderMs = 0;
	const { update: updateStatus, stop: stopStatusTimer } = createGoalStatus(currentGoalSnapshot);
	let responseGoalId: string | null = null;
	let retryWait: AbortController | null = null;
	let proposedRetryGoalId: string | null = null;
	let lastFailure: { goalId: string; message: string } | null = null;
	let stopAtTurnEndGoalId: string | null = null;
	let generation = 0;

	function cancelRetry(): void {
		generation++;
		proposedRetryGoalId = null;
		retryWait?.abort();
		retryWait = null;
	}
	let continuationQueued = false;

	function currentGoalSnapshot(): Goal | null {
		if (!goal) return null;
		const snapshot = cloneGoal(goal);
		if (snapshot.status === "active" && activeSinceMs !== null) {
			snapshot.timeUsedSeconds = Math.min(
				Number.MAX_SAFE_INTEGER,
				snapshot.timeUsedSeconds + Math.max(0, Math.floor((Date.now() - activeSinceMs) / 1000)),
			);
		}
		return snapshot;
	}

	function accountElapsed(atMs = Date.now()): boolean {
		if (!goal || goal.status !== "active" || activeSinceMs === null) return false;
		const seconds = Math.max(0, Math.floor((atMs - activeSinceMs) / 1000));
		if (seconds <= 0) return false;
		goal.timeUsedSeconds = Math.min(Number.MAX_SAFE_INTEGER, goal.timeUsedSeconds + seconds);
		goal.updatedAt = nowSeconds();
		activeSinceMs += seconds * 1000;
		return true;
	}

	function suspendElapsed(): void {
		const atMs = Date.now();
		accountElapsed(atMs);
		elapsedRemainderMs = activeSinceMs === null ? 0 : Math.max(0, atMs - activeSinceMs);
		activeSinceMs = null;
	}

	function persist(action: PersistedGoalState["action"]): void {
		accountElapsed();
		pi.appendEntry(STATE_TYPE, {
			version: 3,
			action,
			goal: goal ? cloneGoal(goal) : null,
		} satisfies PersistedGoalState);
	}

	function showGoalMessage(content: string): void {
		pi.sendMessage(
			{
				customType: UI_MESSAGE_TYPE,
				content: sanitizeDisplayText(content),
				display: true,
			},
			{ triggerTurn: false },
		);
	}

	function setGoal(objectiveInput: string, tokenBudgetInput?: number): Goal {
		cancelRetry();
		const objective = validateObjective(objectiveInput);
		const tokenBudget = validateTokenBudget(tokenBudgetInput);
		const ts = nowSeconds();
		stopAtTurnEndGoalId = null;
		goal = {
			id: randomUUID(),
			objective,
			status: "active",
			tokenBudget,
			tokensUsed: 0,
			responsesUsed: 0,
			errorRetries: 0,
			timeUsedSeconds: 0,
			createdAt: ts,
			updatedAt: ts,
		};
		elapsedRemainderMs = 0;
		activeSinceMs = Date.now();
		continuationQueued = false;
		return goal;
	}

	function editGoalObjective(objectiveInput: string): Goal {
		if (!goal) {
			throw new Error("cannot edit goal because no goal exists");
		}
		const objective = validateObjective(objectiveInput);
		if (goal.status === "active") accountElapsed();
		cancelRetry();
		const nextStatus = goal.status === "complete" ? "paused" : goal.status;
		goal.objective = objective;
		goal.status = nextStatus;
		goal.updatedAt = nowSeconds();
		return goal;
	}

	function setGoalStatus(status: GoalStatus): Goal {
		if (!goal) {
			throw new Error("cannot update goal because no goal exists");
		}
		if (status === "active" && (goal.recoveryReason || (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget))) {
			throw new Error(goal.recoveryReason ?? "Goalkeeper token budget is exhausted; resume cannot reset it.");
		}
		cancelRetry();
		if (status === "active") stopAtTurnEndGoalId = null;
		if (goal.status === "active" && status !== "active") {
			suspendElapsed();
		}
		if (status === "active" && goal.status !== "active") {
			activeSinceMs = Date.now() - elapsedRemainderMs;
			continuationQueued = false;
		}
		if (status !== "active") {
			continuationQueued = false;
		}
		goal.status = status;
		goal.updatedAt = nowSeconds();
		return goal;
	}

	function clearGoal(): boolean {
		cancelRetry();
		if (!goal) return false;
		if (goal.status === "active") accountElapsed();
		goal = null;
		activeSinceMs = null;
		elapsedRemainderMs = 0;
		responseGoalId = null;
		continuationQueued = false;
		return true;
	}

	function maybeApplyBudgetLimit(): boolean {
		if (!goal || goal.status !== "active") return false;
		const budgetReached = goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget;
		if (!budgetReached && goal.responsesUsed < MAX_RESPONSES) return false;
		suspendElapsed();
		goal.status = budgetReached ? "budgetLimited" : "paused";
		cancelRetry();
		stopAtTurnEndGoalId = goal.id;
		goal.updatedAt = nowSeconds();
		continuationQueued = false;
		return true;
	}

	function queueContinuation(ctx: ExtensionContext): void {
		const snapshot = currentGoalSnapshot();
		if (!snapshot || snapshot.status !== "active" || snapshot.recoveryReason || snapshot.responsesUsed >= MAX_RESPONSES || (snapshot.tokenBudget !== undefined && snapshot.tokensUsed >= snapshot.tokenBudget)) return;
		// Busy runs reach agent_before_settle; do not leave stale follow-ups in Pi queues.
		if (!ctx.isIdle() || continuationQueued || ctx.hasPendingMessages()) return;

		continuationQueued = true;
		const message = {
			customType: CONTINUATION_MESSAGE_TYPE,
			content: continuationPrompt(snapshot),
			display: false,
			details: { goalId: snapshot.id },
		};
		try {
			pi.sendMessage(message, { triggerTurn: true });
		} catch (err) {
			continuationQueued = false;
			setGoalStatus("paused");
			persist("status");
			updateStatus(ctx);
			const errorMessage = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(
				sanitizeDisplayText(`Failed to queue goal continuation: ${errorMessage}`),
				"error",
			);
		}
	}

	function reconstructState(ctx: ExtensionContext): void {
		cancelRetry();
		stopAtTurnEndGoalId = null;
		stopStatusTimer();
		goal = null;
		activeSinceMs = null;
		elapsedRemainderMs = 0;
		responseGoalId = null;
		continuationQueued = false;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
			const data = entry.data as Partial<PersistedGoalState> | undefined;
			goal = restoreGoal(data);
			if (data?.goal != null && !goal) {
				ctx.ui.notify("Could not restore a saved goal because its persisted state is invalid.", "warning");
			}
		}
		if (goal?.recoveryReason) ctx.ui.notify(goal.recoveryReason, "warning");
		updateStatus(ctx);
	}

	pi.on("input", () => { cancelRetry(); return { action: "continue" }; });
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_before_tree", async () => {
		if (accountElapsed()) persist("account");
	});
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_shutdown", async () => {
		cancelRetry();
		stopStatusTimer();
		if (accountElapsed()) persist("account");
		activeSinceMs = null;
	});

	pi.on("before_agent_start", async (event) => {
		const snapshot = currentGoalSnapshot();
		if (!snapshot || snapshot.status !== "active") return;
		event.systemPromptOptions.sections["goalkeeper"] = activeGoalSystemPrompt(snapshot);
	});


	pi.on("agent_start", () => {
		continuationQueued = false;
		if (goal?.status === "active" && proposedRetryGoalId === goal.id) {
			goal.errorRetries++;
			persist("account");
		}
		proposedRetryGoalId = null;
	});

	pi.on("agent_settled", (event, ctx) => {
		proposedRetryGoalId = null;
		if (event.aborted && goal?.status === "active") {
			setGoalStatus("paused");
			persist("status");
			updateStatus(ctx);
		}
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") {
			responseGoalId = goal?.status === "active" ? goal.id : null;
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const owner = responseGoalId;
		responseGoalId = null;
		if (!goal || owner !== goal.id) return;
		// message_end precedes tool execution: includes the complete-calling response,
		// excludes the response that creates a goal and post-completion reporting.
		const tokens = usageTokens(event.message.usage);
		goal.responsesUsed = Math.min(Number.MAX_SAFE_INTEGER, goal.responsesUsed + 1);
		if (tokens !== null) goal.tokensUsed = Math.min(Number.MAX_SAFE_INTEGER, goal.tokensUsed + tokens);
		if (tokens === null && goal.tokenBudget !== undefined && goal.status === "active") {
			setGoalStatus("paused");
			goal.recoveryReason = "Missing or invalid usage; this budget can no longer be verified. Clear or replace the goal.";
			stopAtTurnEndGoalId = goal.id;
			showGoalMessage(goal.recoveryReason);
		}
		if (maybeApplyBudgetLimit()) {
			showGoalMessage(goal.status === "budgetLimited" ? budgetLimitMessage(goal) :
				`Goalkeeper paused after ${MAX_RESPONSES} assistant responses. Inspect progress; /goal resume explicitly resets the response allowance.`);
		}
		persist("account");
		updateStatus(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		const owner = stopAtTurnEndGoalId;
		stopAtTurnEndGoalId = null;
		if (!owner || goal?.id !== owner) return;
		ctx.abort(); // void; never await session.waitForIdle inside the current hook
	});

	pi.on("agent_end", (event, ctx) => {
		const last = [...event.messages].reverse().find(message => message.role === "assistant");
		if (goal?.status === "active" && last?.role === "assistant" && last.stopReason === "error") {
			lastFailure = { goalId: goal.id, message: (last.errorMessage ?? "No error details provided by Pi").slice(0, 1000) };
		}
		if (last?.role === "assistant" && last.stopReason === "aborted" && goal?.status === "active") {
			setGoalStatus("paused");
			persist("status");
			showGoalMessage("Goalkeeper paused after cancellation. Use /goal resume to restart explicitly.");
		}
		if (accountElapsed()) persist("account");
		updateStatus(ctx);
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!goal) return;
		if (event.outcome === "completed" && goal.errorRetries !== 0) {
			goal.errorRetries = 0;
			persist("account");
		}
		if (goal.status !== "active") return;
		if (event.outcome === "aborted" || ctx.signal?.aborted) {
			setGoalStatus("paused");
			persist("status");
			updateStatus(ctx);
			return;
		}
		if (maybeApplyBudgetLimit()) {
			persist("status");
			updateStatus(ctx);
			return;
		}
		const pending = () => ctx.hasPendingMessages() || event.context.pendingMessages.length > 0 || event.continue;
		if (pending()) return;
		const id = goal.id;
		const epoch = generation;
		if (event.outcome === "error") {
			if (goal.errorRetries >= MAX_ERROR_RETRIES) {
				setGoalStatus("paused");
				persist("status");
				showGoalMessage(`Goalkeeper paused after ${MAX_ERROR_RETRIES} extra error retries. Inspect the last Pi error and live state before /goal resume.\n\nLast error: ${lastFailure?.goalId === goal.id ? lastFailure.message : "See Pi session history."}`);
				updateStatus(ctx);
				return;
			}
			const controller = new AbortController();
			retryWait?.abort();
			retryWait = controller;
			const abort = () => controller.abort();
			ctx.signal?.addEventListener("abort", abort, { once: true });
			let ready: boolean;
			try {
				ready = await waitForRetry(retryDelay(goal.errorRetries), controller.signal);
			} finally {
				ctx.signal?.removeEventListener("abort", abort);
				if (retryWait === controller) retryWait = null;
			}
			if (!ready || ctx.signal?.aborted) {
				if (goal?.id === id && goal.status === "active" && generation === epoch) {
					setGoalStatus("paused");
					persist("status");
					updateStatus(ctx);
				}
				return;
			}
		}
		if (!goal || goal.id !== id || goal.status !== "active" || generation !== epoch || pending()) return;
		if (maybeApplyBudgetLimit()) { persist("status"); updateStatus(ctx); return; }
		if (event.outcome === "error") proposedRetryGoalId = goal.id;
		return {
			entries: [...event.entries, {
				type: "custom_message" as const,
				customType: CONTINUATION_MESSAGE_TYPE,
				content: continuationPrompt(currentGoalSnapshot()!),
				display: false,
				details: { goalId: id },
			}],
			continue: true,
		};
	});

	pi.on("context", async (event) => {
		let lastContinuationIndex = -1;
		for (let i = 0; i < event.messages.length; i++) {
			const msg = event.messages[i] as { customType?: string; details?: { goalId?: string } };
			if (msg.customType === CONTINUATION_MESSAGE_TYPE && msg.details?.goalId === goal?.id) {
				lastContinuationIndex = i;
			}
		}

		return {
			messages: event.messages.filter((message, index) => {
				const msg = message as { customType?: string; details?: { goalId?: string } };
				if (msg.customType === UI_MESSAGE_TYPE) return false;
				if (msg.customType === CONTINUATION_MESSAGE_TYPE) {
					return goal?.status === "active" && msg.details?.goalId === goal.id && index === lastContinuationIndex;
				}
				return true;
			}),
		};
	});

	// Public operations keep mutation, persistence and footer refresh together.
	function changed(action: PersistedGoalState["action"], ctx: ExtensionContext): void {
		persist(action);
		updateStatus(ctx);
	}

	return {
		snapshot: currentGoalSnapshot,
		refresh: updateStatus,
		message: showGoalMessage,
		queueContinuation,
		set(objective: string, tokenBudget: number | undefined, ctx: ExtensionContext): Goal {
			const created = setGoal(objective, tokenBudget);
			changed("set", ctx);
			return cloneGoal(created);
		},
		edit(objective: string, ctx: ExtensionContext): Goal {
			const edited = editGoalObjective(objective);
			changed("edit", ctx);
			return cloneGoal(edited);
		},
		pause(ctx: ExtensionContext): Goal {
			const paused = setGoalStatus("paused");
			changed("status", ctx);
			return cloneGoal(paused);
		},
		resume(ctx: ExtensionContext): Goal {
			const resumed = setGoalStatus("active");
			resumed.responsesUsed = 0;
			resumed.errorRetries = 0;
			changed("status", ctx);
			return cloneGoal(resumed);
		},
		finish(status: "complete" | "blocked", ctx: ExtensionContext): Goal {
			if (goal?.status !== "active") throw new Error("Only an active Goalkeeper goal can be completed or blocked.");
			const finished = setGoalStatus(status);
			changed("status", ctx);
			return cloneGoal(finished);
		},
		clear(ctx: ExtensionContext): boolean {
			const cleared = clearGoal();
			changed("clear", ctx);
			return cleared;
		},
	};
}

export type GoalSession = ReturnType<typeof createGoalSession>;
