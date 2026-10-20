import { readFileSync } from "node:fs";

// Read only: usable locally and by the release workflow before any remote write.
const version = process.argv[2];
const number = "(?:0|[1-9]\\d*)";
const prereleaseId = `(?:${number}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(`^${number}\\.${number}\\.${number}(?:-${prereleaseId}(?:\\.${prereleaseId})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
if (!semver.test(version ?? "")) {
	throw new Error("Expected a semantic version without the v prefix.");
}
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.version !== version) throw new Error("Release version must match package.json.");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const heading = `## ${version}`;
const lines = changelog.split(/\r?\n/);
const start = lines.indexOf(heading);
if (start === -1) throw new Error("Release version must have a CHANGELOG.md section.");
const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
const notes = lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
if (!notes) throw new Error("Release notes must not be empty.");
console.log(notes);
