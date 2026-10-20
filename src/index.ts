/** Goalkeeper: branch-local, bounded continuation for Pi. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand } from "./commands.ts";
import { createGoalSession } from "./session.ts";
import { registerGoalTools } from "./tools.ts";

export default function goalkeeperExtension(pi: ExtensionAPI): void {
	const session = createGoalSession(pi);
	registerGoalCommand(pi, session);
	registerGoalTools(pi, session);
}
