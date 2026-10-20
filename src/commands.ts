import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { goalSummary, statusLabel } from "./prompts.ts";
import { sanitizeDisplayText, validateObjective } from "./state.ts";
import type { GoalSession } from "./session.ts";

/** Interactive policy and dialogs belong here, not in the session state machine. */
export function registerGoalCommand(pi: ExtensionAPI, session: GoalSession): void {
	pi.registerCommand("goal", {
		description: "Goalkeeper: set or view a bounded long-running goal",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "clear", label: "clear", description: "clear the current goal" },
				{ value: "edit", label: "edit", description: "edit the current goal objective" },
				{ value: "pause", label: "pause", description: "pause the current goal" },
				{ value: "resume", label: "resume", description: "resume the current goal" },
			];
			const filtered = items.filter(item => item.value.startsWith(prefix.trimStart()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const goal = session.snapshot();
			if (!trimmed) {
				session.message(goal ? goalSummary(goal) : "Usage: /goal <objective>\n\nNo goal is currently set.");
				session.refresh(ctx);
				return;
			}

			switch (trimmed.toLowerCase()) {
				case "clear": {
					const cleared = session.clear(ctx);
					session.message(cleared ? "Goalkeeper cleared" : "No goal to clear\n\nThis thread does not currently have a goal.");
					return;
				}
				case "pause": {
					try {
						const paused = session.pause(ctx);
						session.message(`Goalkeeper paused\n\n${goalSummary(paused)}`);
					} catch (err) {
						session.message(`Failed to update thread goal: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				case "resume": {
					try {
						const resumed = session.resume(ctx);
						session.message(`Goalkeeper active\n\n${goalSummary(resumed)}`);
						session.queueContinuation(ctx);
					} catch (err) {
						session.message(`Failed to update thread goal: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				case "edit": {
					if (!goal) {
						session.message("No goal is currently set.\n\nUsage: /goal <objective>");
						return;
					}
					if (!ctx.hasUI) {
						session.message("/goal edit requires interactive mode. Use /goal <objective> to replace the current goal.");
						return;
					}
					const edited = await ctx.ui.editor("Edit Goalkeeper objective:", sanitizeDisplayText(goal.objective));
					if (session.snapshot()?.id !== goal.id) return;
					if (edited === undefined) {
						ctx.ui.notify("Goal edit cancelled", "info");
						return;
					}
					try {
						const updated = session.edit(edited, ctx);
						session.message(`Goalkeeper ${statusLabel(updated.status)}\n\n${goalSummary(updated)}`);
						if (updated.status === "active") session.queueContinuation(ctx);
					} catch (err) {
						session.message(`Failed to edit thread goal: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
			}

			let objective: string;
			try {
				objective = validateObjective(args);
			} catch (err) {
				session.message(err instanceof Error ? err.message : String(err));
				return;
			}
			if (goal && goal.status !== "complete") {
				if (!ctx.hasUI) {
					session.message("An unfinished goal already exists. Run /goal clear first, or use interactive mode to confirm replacement.");
					return;
				}
				const replace = await ctx.ui.confirm("Replace Goalkeeper goal?", sanitizeDisplayText(`New objective: ${objective}`));
				if (!replace || session.snapshot()?.id !== goal.id) return;
			}
			const created = session.set(objective, undefined, ctx);
			session.message(`Goalkeeper active\n\n${goalSummary(created)}`);
			session.queueContinuation(ctx);
		},
	});
}
