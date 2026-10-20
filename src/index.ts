/** Goalkeeper: branch-local, bounded continuation for Pi. */
import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { cloneGoal, nowSeconds, validateObjective, validateTokenBudget, sanitizeDisplayText,
	restoreGoal, usageTokens, MAX_RESPONSES, MAX_ERROR_RETRIES, retryDelay, waitForRetry,
	type Goal, type GoalStatus, type PersistedGoalState } from "./state.ts";
import { goalSummary, goalResponse, serializeGoalResponse, continuationPrompt, activeGoalSystemPrompt,
	budgetLimitMessage, statusLabel } from "./prompts.ts";
import { createGoalStatus } from "./status.ts";

// Keep these existing wire identities to preserve sessions and tool callers.
const STATE_TYPE = "goal";
const UI_MESSAGE_TYPE = "goal-ui";
const CONTINUATION_MESSAGE_TYPE = "goal-continuation";
const CreateGoalParams = Type.Object({
	objective: Type.String({
		description:
			"Required. The concrete objective to start pursuing. This starts a new active goal when no unfinished goal exists. If the previous goal is complete, it is replaced.",
	}),
	token_budget: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: Number.MAX_SAFE_INTEGER,
			multipleOf: 1,
			description:
				"Optional positive integer token budget for the new goal. Omit unless explicitly requested.",
		}),
	),
});

const UpdateGoalParams = Type.Object({
	status: StringEnum(["complete", "blocked"] as const),
});


export default function goalkeeperExtension(pi: ExtensionAPI) {
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

	pi.registerCommand("goal", {
		description: "Goalkeeper: set or view a bounded long-running goal",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "clear", label: "clear", description: "clear the current goal" },
				{ value: "edit", label: "edit", description: "edit the current goal objective" },
				{ value: "pause", label: "pause", description: "pause the current goal" },
				{ value: "resume", label: "resume", description: "resume the current goal" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix.trimStart()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				const snapshot = currentGoalSnapshot();
				showGoalMessage(snapshot ? goalSummary(snapshot) : "Usage: /goal <objective>\n\nNo goal is currently set.");
				updateStatus(ctx);
				return;
			}

			switch (trimmed.toLowerCase()) {
				case "clear": {
					const cleared = clearGoal();
					persist("clear");
					showGoalMessage(cleared ? "Goalkeeper cleared" : "No goal to clear\n\nThis thread does not currently have a goal.");
					updateStatus(ctx);
					return;
				}
				case "pause": {
					try {
						setGoalStatus("paused");
						persist("status");
						showGoalMessage(`Goalkeeper paused\n\n${goalSummary(goal!)}`);
						updateStatus(ctx);
					} catch (err) {
						showGoalMessage(`Failed to update thread goal: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				case "resume": {
					try {
						setGoalStatus("active");
						goal!.responsesUsed = 0;
						goal!.errorRetries = 0;
						persist("status");
						showGoalMessage(`Goalkeeper active\n\n${goalSummary(currentGoalSnapshot()!)}`);
						updateStatus(ctx);
						queueContinuation(ctx);
					} catch (err) {
						showGoalMessage(`Failed to update thread goal: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				case "edit": {
					if (!goal) {
						showGoalMessage("No goal is currently set.\n\nUsage: /goal <objective>");
						return;
					}
					if (!ctx.hasUI) {
						showGoalMessage("/goal edit requires interactive mode. Use /goal <objective> to replace the current goal.");
						return;
					}
					const editingId = goal.id;
					const edited = await ctx.ui.editor("Edit Goalkeeper objective:", sanitizeDisplayText(goal.objective));
					if (goal?.id !== editingId) return;
					if (edited === undefined) {
						ctx.ui.notify("Goal edit cancelled", "info");
						return;
					}
					try {
						editGoalObjective(edited);
						persist("edit");
						showGoalMessage(`Goalkeeper ${statusLabel(goal!.status)}\n\n${goalSummary(currentGoalSnapshot()!)}`);
						updateStatus(ctx);
						if (goal?.status === "active") queueContinuation(ctx);
					} catch (err) {
						showGoalMessage(`Failed to edit thread goal: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
			}

			let objective: string;
			try {
				objective = validateObjective(args);
			} catch (err) {
				showGoalMessage(err instanceof Error ? err.message : String(err));
				return;
			}

			if (goal && goal.status !== "complete") {
				if (!ctx.hasUI) {
					showGoalMessage("An unfinished goal already exists. Run /goal clear first, or use interactive mode to confirm replacement.");
					return;
				}
				const replacingId = goal.id;
				const replace = await ctx.ui.confirm(
					"Replace Goalkeeper goal?",
					sanitizeDisplayText(`New objective: ${objective}`),
				);
				if (!replace || goal?.id !== replacingId) return;
			}

			setGoal(objective);
			persist("set");
			showGoalMessage(`Goalkeeper active\n\n${goalSummary(goal!)}`);
			updateStatus(ctx);
			queueContinuation(ctx);
		},
	});

	pi.registerTool({
		name: "get_goal",
		label: "Goalkeeper: Get goal",
		description:
			"Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.",
		promptSnippet: "Get the current long-running thread goal and its usage/budget state",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const snapshot = currentGoalSnapshot();
			const response = goalResponse(snapshot, ctx.sessionManager.getSessionId());
			return {
				content: [{ type: "text", text: serializeGoalResponse(response) }],
				details: response,
			};
		},
	});

	pi.registerTool({
		name: "create_goal",
		label: "Goalkeeper: Create goal",
		description:
			"Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; if the previous goal is complete, it is replaced.",
		promptSnippet: "Create a new active long-running thread goal when explicitly requested",
		promptGuidelines: [
			"Use create_goal only when the user explicitly asks to create a long-running goal; do not infer goals from ordinary tasks.",
			"Use update_goal with status complete only when the active goal is actually achieved and no required work remains.",
			"Use update_goal with status blocked only when the goal requires user input, permission, credentials, or an external-state change.",
		],
		parameters: CreateGoalParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (goal && goal.status !== "complete") {
				throw new Error(
					"cannot create a new goal because this thread already has an unfinished goal; complete it with update_goal or ask the user to clear or replace it",
				);
			}
			_signal?.throwIfAborted();
			setGoal(params.objective, params.token_budget);
			persist("set");
			updateStatus(ctx);
			const response = goalResponse(currentGoalSnapshot(), ctx.sessionManager.getSessionId());
			return {
				content: [{ type: "text", text: serializeGoalResponse(response) }],
				details: response,
			};
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Goalkeeper: Update goal",
		description:
			"Update the existing goal. Use this tool only to mark the goal achieved or genuinely blocked. Set status to complete only when the objective has actually been achieved and no required work remains. Set status to blocked immediately when meaningful progress requires user input, permission, credentials, or an external-state change. Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.",
		promptSnippet: "Mark the current goal complete or blocked after verifying the required conditions",
		promptGuidelines: [
			"Use update_goal only to mark the active goal complete or blocked after verifying the required conditions; never use it for pause, resume, budget-limit, or usage-limit changes.",
		],
		parameters: UpdateGoalParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.status !== "complete" && params.status !== "blocked") {
				throw new Error(
					"update_goal can only mark the existing goal complete or blocked; pause, resume, budget-limited, and usage-limited status changes are controlled by the user or system",
				);
			}
			if (goal?.status !== "active") throw new Error("Only an active Goalkeeper goal can be completed or blocked.");
			_signal?.throwIfAborted();
			setGoalStatus(params.status);
			persist("status");
			updateStatus(ctx);
			const response = goalResponse(currentGoalSnapshot(), ctx.sessionManager.getSessionId(), params.status === "complete");
			return {
				content: [{ type: "text", text: serializeGoalResponse(response) }],
				details: response,
			};
		},
	});
}
