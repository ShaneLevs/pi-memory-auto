/**
 * Rebuild the generated MEMORY.md index files (global + a project).
 *
 * Usage:
 *   node --experimental-strip-types scripts/rebuild-index.ts [projectRoot] [--print]
 *
 * Defaults to the current directory. `--print` also dumps the exact block that
 * would be injected into the system prompt.
 */

import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { buildMemoryIndex } from "../src/index-map.ts";
import { materializeAll } from "../src/indexer.ts";
import { loadAllEntries } from "../src/search.ts";
import { FileMutex } from "../src/store.ts";
import { loadUsage } from "../src/usage.ts";
import { INJECTION_PREAMBLE } from "../src/constants.ts";

const args = process.argv.slice(2);
const print = args.includes("--print");
const projectRoot = path.resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
const config = loadConfig();
const projectName = path.basename(projectRoot);

const result = await materializeAll({
	globalDir: config.globalDir,
	projectRoot,
	mutex: new FileMutex(),
	indexBudget: config.indexBudget,
	projectName,
});

console.log(`project root : ${projectRoot}`);
for (const layer of ["global", "project"] as const) {
	const s = result[layer];
	console.log(
		`${layer.padEnd(13)}: ${s.written ? "written" : "unchanged"} — ${s.entries} memories, ${s.keywords} keywords, sinceLast=${s.sinceLast}`,
	);
}

if (print) {
	const entries = await loadAllEntries(config.globalDir, projectRoot);
	const usageByLayer = await loadUsage(config.globalDir, projectRoot);
	const index = buildMemoryIndex(entries, { budget: config.indexBudget, projectName, usageByLayer });
	console.log("\n=== injection preview ===\n");
	console.log(index ? `${INJECTION_PREAMBLE}\n\n${index}` : "(nothing stored — no injection)");
}
