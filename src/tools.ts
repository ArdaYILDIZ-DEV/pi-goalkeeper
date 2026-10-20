import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { goalResponse, serializeGoalResponse } from "./prompts.ts";
import type { GoalSession } from "./session.ts";

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

export function registerGoalTools(pi: ExtensionAPI, session: GoalSession): void {
	pi.registerTool({
		name: "get_goal",
		label: "Goalkeeper: Get goal",
		description:
			"Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.",
		promptSnippet: "Get the current long-running thread goal and its usage/budget state",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const snapshot = session.snapshot();
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
			const goal = session.snapshot();
			if (goal && goal.status !== "complete") {
				throw new Error(
					"cannot create a new goal because this thread already has an unfinished goal; complete it with update_goal or ask the user to clear or replace it",
				);
			}
			_signal?.throwIfAborted();
			session.set(params.objective, params.token_budget, ctx);
			const response = goalResponse(session.snapshot(), ctx.sessionManager.getSessionId());
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
			_signal?.throwIfAborted();
			session.finish(params.status, ctx);
			const response = goalResponse(session.snapshot(), ctx.sessionManager.getSessionId(), params.status === "complete");
			return {
				content: [{ type: "text", text: serializeGoalResponse(response) }],
				details: response,
			};
		},
	});
}
