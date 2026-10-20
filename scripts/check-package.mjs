import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "goalkeeper-package-"));
try {
	const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], { encoding: "utf8" }));
	const expected = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "src/index.ts", "src/session.ts", "src/commands.ts", "src/tools.ts", "src/state.ts", "src/prompts.ts", "src/status.ts"].sort();
	assert.deepEqual(pack.files.map(file => file.path).sort(), expected, "Unexpected package contents");
	const unpacked = join(temp, "unpacked");
	mkdirSync(unpacked);
	execFileSync("tar", ["-xzf", join(temp, pack.filename), "-C", unpacked]);
	execFileSync(process.execPath, ["--import", "tsx", "--test", "test/integration.test.ts"], {
		stdio: "inherit",
		timeout: 120_000,
		env: { ...process.env, GOALKEEPER_EXTENSION_PATH: resolve(unpacked, "package/src/index.ts") },
	});
	console.log("Package allowlist and packed-source Pi SDK integration passed.");
} finally {
	rmSync(temp, { recursive: true, force: true });
}
