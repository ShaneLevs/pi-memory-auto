/**
 * Entry serialization/parsing: MemoryEntry <-> markdown with a metadata comment.
 *
 * Format:
 * <!-- mid: 20261011-a1b2 | t: 2026-10-11 19:40:00 | p: myproject | src: user | tags: auth,db -->
 * body text (may be multi-line, until a blank line followed by another entry comment or EOF)
 *
 * This module is the single source of truth for the on-disk entry format.
 */

import { ENTRY_META_PREFIX } from "./constants.ts";
import type { Layer, MemoryEntry, MemorySource } from "./types.ts";

/** Generate a unique entry id: YYYYMMDD-xxxx (time + 4 random hex chars). */
export function generateEntryId(now: Date = new Date()): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	const rand = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
	return `${y}${m}${d}-${rand}`;
}

/** Format a Date as "YYYY-MM-DD HH:mm:ss" (local time). */
export function formatTime(now: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

/** Parse "YYYY-MM-DD HH:mm:ss" to epoch ms; returns 0 on failure. */
export function parseTime(s: string): number {
	const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
	if (!m) return 0;
	const [, y, mo, d, h, mi, se] = m;
	return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)).getTime();
}

function escapeField(s: string): string {
	return s.replace(/\|/g, "\\|").trim();
}

/** Serialize one entry to its on-disk markdown form (ends with newline). */
export function serializeEntry(entry: MemoryEntry): string {
	const tags = entry.tags.length > 0 ? escapeField(entry.tags.join(",")) : "-";
	const project = escapeField(entry.project || "-");
	const meta = `${ENTRY_META_PREFIX} ${entry.id} | t: ${entry.time} | p: ${project} | src: ${entry.source} | tags: ${tags} -->`;
	const text = entry.text.trim();
	return `${meta}\n${text}\n\n`;
}

/**
 * Parse all entries from a markdown file body.
 * Tolerant: malformed metadata lines become entries with defaults; text outside
 * any entry is ignored (e.g. file headers).
 */
export function parseEntries(content: string): MemoryEntry[] {
	const entries: MemoryEntry[] = [];
	const lines = content.split("\n");
	let current: MemoryEntry | undefined;
	let textLines: string[] = [];

	const flush = () => {
		if (!current) return;
		current.text = textLines.join("\n").trim();
		if (current.text.length > 0) entries.push(current);
		current = undefined;
		textLines = [];
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith(ENTRY_META_PREFIX) && trimmed.endsWith("-->")) {
			flush();
			current = parseMetaLine(trimmed);
			continue;
		}
		if (current) textLines.push(line);
	}
	flush();
	return entries;
}

/** Parse one metadata comment line into a MemoryEntry (text empty). */
function parseMetaLine(line: string): MemoryEntry {
	const inner = line.replace(/^<!--\s*/, "").replace(/\s*-->$/, "");
	const fields: Record<string, string> = {};
	// Split on unescaped pipes.
	const parts: string[] = [];
	let buf = "";
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (ch === "\\" && inner[i + 1] === "|") {
			buf += "|";
			i++;
			continue;
		}
		if (ch === "|") {
			parts.push(buf.trim());
			buf = "";
			continue;
		}
		buf += ch;
	}
	parts.push(buf.trim());
	for (const part of parts) {
		const idx = part.indexOf(":");
		if (idx < 0) continue;
		const key = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (key) fields[key] = value;
	}
	const id = fields.mid || generateEntryId();
	const time = fields.t || formatTime();
	const project = fields.p && fields.p !== "-" ? fields.p : "";
	const source: MemorySource = fields.src === "auto" ? "auto" : "user";
	const layer: Layer = project ? "project" : "global";
	const tags = fields.tags && fields.tags !== "-" ? fields.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
	return { id, time, project, layer, source, tags, text: "" };
}
