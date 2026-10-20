import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../scripts/release-notes.mjs", import.meta.url));

test("release gate requires matching version, nonempty changelog and extracts only that version", () => {
	const cwd = mkdtempSync(join(tmpdir(), "goalkeeper-release-"));
	const run = (version: string) => execFileSync(process.execPath, [script, version], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	try {
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: "0.1.0" }));
		const changelog = join(cwd, "CHANGELOG.md");
		writeFileSync(changelog, "# Changelog\n\n## 0.1.0\n\nInitial changes.\n\n## 0.0.1\n\nOld changes.\n");
		assert.equal(run("0.1.0").trim(), "Initial changes.");
		assert.throws(() => run("0.2.0"), /must match package.json/);
		for (const invalid of ["v0.1.0", "01.1.0", "0.1", "0.1.0-01", "0.1.0; echo unsafe"]) {
			assert.throws(() => run(invalid), /semantic version/);
		}
		writeFileSync(changelog, "# Changelog\n\n## 0.0.1\nOld changes.\n");
		assert.throws(() => run("0.1.0"), /CHANGELOG.md section/);
		writeFileSync(changelog, "# Changelog\n\n## 0.1.0\n\n## 0.0.1\nOld changes.\n");
		assert.throws(() => run("0.1.0"), /must not be empty/);
		for (const version of ["1.0.0-rc.1", "1.0.0+build.2", "1.0.0-rc.1+build.2"]) {
			writeFileSync(join(cwd, "package.json"), JSON.stringify({ version }));
			writeFileSync(changelog, `# Changelog\n\n## ${version}\n\nRelease changes.\n`);
			assert.equal(run(version).trim(), "Release changes.");
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
