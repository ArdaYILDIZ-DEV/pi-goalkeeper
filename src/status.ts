import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Goal } from "./state.ts";
import { formatElapsedSeconds, formatTokensCompact } from "./prompts.ts";

/** Owns only the footer and its refresh timer; never accounts or persists usage. */
export function createGoalStatus(snapshot: () => Goal | null) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let context: ExtensionContext | null = null;

	function stop(): void {
		if (timer !== null) clearInterval(timer);
		timer = null;
		context = null;
	}

	function update(ctx: ExtensionContext): void {
		const goal = snapshot();
		// Pi stores a string, not a live renderer. Only elapsed-time TUI labels tick.
		if (ctx.mode === "tui" && ctx.hasUI && goal?.status === "active" && goal.tokenBudget === undefined) {
			context = ctx;
			if (timer === null) {
				timer = setInterval(() => { if (context) update(context); }, 1000);
				timer.unref();
			}
		} else {
			stop();
		}
		if (!ctx.hasUI) return;
		if (!goal) {
			ctx.ui.setStatus("goal", undefined);
			return;
		}
		const theme = ctx.ui.theme;
		switch (goal.status) {
			case "active": {
				const usage = goal.tokenBudget === undefined
					? ` (${formatElapsedSeconds(goal.timeUsedSeconds)})`
					: ` (${formatTokensCompact(goal.tokensUsed)} / ${formatTokensCompact(goal.tokenBudget)})`;
				ctx.ui.setStatus("goal", theme.fg("accent", `Goalkeeper: pursuing goal${usage}`));
				break;
			}
			case "paused":
				ctx.ui.setStatus("goal", theme.fg("warning", "Goalkeeper paused (/goal resume)"));
				break;
			case "blocked":
				ctx.ui.setStatus("goal", theme.fg("warning", "Goalkeeper blocked (/goal resume)"));
				break;
			case "usageLimited":
				ctx.ui.setStatus("goal", theme.fg("warning", "Goalkeeper hit usage limits (/goal resume)"));
				break;
			case "budgetLimited":
				ctx.ui.setStatus("goal", theme.fg("warning", "Goalkeeper budget reached"));
				break;
			case "complete":
				ctx.ui.setStatus("goal", theme.fg("success", "Goalkeeper complete"));
				break;
		}
	}

	return { update, stop };
}
