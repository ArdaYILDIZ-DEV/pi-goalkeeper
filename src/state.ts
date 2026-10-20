import { randomUUID } from "node:crypto";

export const MAX_OBJECTIVE_CHARS = 5_000;

export type GoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	responsesUsed: number;
	errorRetries: number;
	recoveryReason?: string;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

export interface PersistedGoalState {
	version: 3;
	action: "set" | "edit" | "status" | "clear" | "account";
	goal: Goal | null;
}


export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

export function cloneGoal(goal: Goal): Goal {
	return { ...goal };
}

export function charCount(value: string): number {
	return [...value].length;
}

export function escapeXmlText(input: string): string {
	return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function sanitizeDisplayText(input: string): string {
	return input
		.replace(/\t/g, " ")
		.replace(
			/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
			"�",
		);
}

export function validateObjective(input: string): string {
	const objective = input.trim();
	if (!objective) {
		throw new Error("goal objective must not be empty");
	}
	if (charCount(objective) > MAX_OBJECTIVE_CHARS) {
		throw new Error(
			`Goal objective is too long: ${charCount(objective).toLocaleString()} characters. Limit: ${MAX_OBJECTIVE_CHARS.toLocaleString()} characters. Put longer instructions in a file and refer to that file in the goal, for example: /goal follow the instructions in docs/goal.md.`,
		);
	}
	return objective;
}

export function validateTokenBudget(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error("goal budgets must be positive safe integers when provided");
	}
	return value;
}

export function normalizeStatus(value: unknown): GoalStatus {
	switch (value) {
		case "active":
		case "paused":
		case "blocked":
		case "complete":
			return value;
		case "usageLimited":
		case "usage_limited":
			return "usageLimited";
		case "budgetLimited":
		case "budget_limited":
			return "budgetLimited";
		case undefined:
			return "active";
		default:
			// Unknown persisted statuses must not start unattended continuation.
			return "paused";
	}
}

export function normalizeNonNegativeInteger(value: unknown, fallback = 0): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

export function normalizeGoal(value: unknown): Goal | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Partial<Goal> & Record<string, unknown>;
	const objective = typeof raw.objective === "string" ? raw.objective : "";
	if (!objective.trim() || charCount(objective) > MAX_OBJECTIVE_CHARS) return null;
	let tokenBudget: number | undefined;
	if (raw.tokenBudget !== undefined) {
		if (
			typeof raw.tokenBudget !== "number" ||
			!Number.isSafeInteger(raw.tokenBudget) ||
			raw.tokenBudget <= 0
		) {
			// Do not turn a damaged bounded goal into an unbounded active one.
			return null;
		}
		tokenBudget = raw.tokenBudget;
	}
	const ts = nowSeconds();
	return {
		id: typeof raw.id === "string" && raw.id ? raw.id : randomUUID(),
		objective,
		status: normalizeStatus(raw.status),
		tokenBudget,
		tokensUsed: normalizeNonNegativeInteger(raw.tokensUsed),
		responsesUsed: normalizeNonNegativeInteger(raw.responsesUsed),
		errorRetries: normalizeNonNegativeInteger(raw.errorRetries),
		recoveryReason: typeof raw.recoveryReason === "string" ? raw.recoveryReason : undefined,
		timeUsedSeconds: normalizeNonNegativeInteger(raw.timeUsedSeconds),
		createdAt: normalizeNonNegativeInteger(raw.createdAt, ts),
		updatedAt: normalizeNonNegativeInteger(raw.updatedAt, ts),
	};
}


export const MAX_RESPONSES = 50;
export const MAX_ERROR_RETRIES = 10;

export function usageTokens(usage: unknown): number | null {
	if (!usage || typeof usage !== "object") return null;
	const raw = usage as Record<string, unknown>;
	const values = [raw.input, raw.cacheWrite, raw.output];
	if (!values.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return null;
	return Math.min(Number.MAX_SAFE_INTEGER, (raw.input as number) + (raw.cacheWrite as number) + (raw.output as number));
}

export function restoreGoal(data: unknown): Goal | null {
	if (!data || typeof data !== "object") return null;
	const raw = data as { version?: unknown; goal?: unknown };
	const goal = normalizeGoal(raw.goal);
	if (!goal) return null;
	const source = raw.goal as Record<string, unknown>;
	const countersValid = ["tokensUsed", "responsesUsed", "errorRetries", "timeUsedSeconds"].every(
		key => typeof source[key] === "number" && Number.isSafeInteger(source[key]) && (source[key] as number) >= 0,
	);
	if (raw.version !== 3 || !countersValid || typeof source.id !== "string" || !source.id.trim() ||
		!["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(String(source.status))) {
		goal.status = "paused";
		goal.recoveryReason = "Incompatible or damaged saved state. Historical usage cannot be verified. Clear or explicitly replace this goal; the original session entries are preserved.";
	}
	// Restoring a session is never permission to restart unattended work.
	if (goal.status === "active") goal.status = "paused";
	return goal;
}

export function retryDelay(retriesUsed: number): number {
	return Math.min(30_000, 2_000 * 2 ** retriesUsed);
}

/** No detached timer survives cancellation, replacement, or shutdown. */
export function waitForRetry(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise(resolve => {
		const finish = (completed: boolean) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			resolve(completed);
		};
		const abort = () => finish(false);
		const timer = setTimeout(() => finish(true), ms);
		signal.addEventListener("abort", abort, { once: true });
	});
}
