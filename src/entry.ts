/**
 * Entry serialization/parsing: MemoryEntry <-> markdown with a metadata comment.
 *
 * Format:
 * <!-- mid: 20261011-a1b2 | t: 2026-10-11 19:40:00 | p: myproject | src: user | tags: auth,db -->
 * body text (may be multi-line, until a blank line followed by another entry comment or EOF)
 *
 * A re-confirmed memory keeps one row and carries two extra fields:
 * <!-- mid: 20261011-a1b2 | t: ... | p: ... | src: ... | tags: ... | seen: 3 | last: 2026-10-24 09:00:00 -->
 * `seen` is how many times the same body was written again, `last` when it last
 * was. Both are omitted while seen === 1, so a normal entry's bytes are
 * unchanged from the original format.
 *
 * A replaced memory keeps its row too, marked instead of deleted:
 *   ... | supersedes: 20261011-a1b2 -->      (on the new, corrected entry)
 *   ... | superseded-by: 20261020-c3d4 -->   (on the entry it replaced)
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

/**
 * Serialize the metadata comment line of one entry (no trailing newline).
 *
 * Used both by serializeEntry and by the in-place `seen`/`last` bump, so the
 * bump rewrites exactly one line and leaves the body bytes untouched.
 */
/** Entry id shape: YYYYMMDD-xxxx. */
export const ENTRY_ID_RE = /^\d{8}-[0-9a-f]{4}$/i;

export function serializeMetaLine(entry: MemoryEntry): string {
	const tags = entry.tags.length > 0 ? escapeField(entry.tags.join(",")) : "-";
	const project = escapeField(entry.project || "-");
	const seen = entry.seen ?? 1;
	// Omitted at 1 so entries that were never re-confirmed keep the original bytes.
	const repeat = seen > 1 ? ` | seen: ${seen} | last: ${escapeField(entry.last ?? entry.time)}` : "";
	const supersedes = entry.supersedes && entry.supersedes.length > 0 ? ` | supersedes: ${entry.supersedes.join(",")}` : "";
	const supersededBy = entry.supersededBy ? ` | superseded-by: ${entry.supersededBy}` : "";
	return `${ENTRY_META_PREFIX} ${entry.id} | t: ${entry.time} | p: ${project} | src: ${entry.source} | tags: ${tags}${supersedes}${supersededBy}${repeat} -->`;
}

/** Serialize one entry to its on-disk markdown form (ends with newline). */
export function serializeEntry(entry: MemoryEntry): string {
	return `${serializeMetaLine(entry)}\n${entry.text.trim()}\n\n`;
}

/**
 * Normalize a memory body for write-time idempotency.
 *
 * Deliberately conservative: only case, whitespace and trailing punctuation are
 * ignored. Stripping more (all punctuation, word order) would make genuinely
 * different memories collide, and a collision silently drops the second one.
 */
export function normalizeMemoryText(text: string): string {
	return text
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.。;；,，:：!！?？]+$/u, "")
		.trim();
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
	// Legacy entries have neither field; a malformed count means "once", never
	// "zero" — the counter only ever grows.
	const parsedSeen = fields.seen ? Number.parseInt(fields.seen, 10) : Number.NaN;
	const seen = Number.isFinite(parsedSeen) && parsedSeen > 1 ? parsedSeen : undefined;
	const last = fields.last && fields.last !== "-" ? fields.last : undefined;
	// Ids are shape-checked on read: a hand-edited or truncated file must not be
	// able to make an entry point at garbage, or de-index itself.
	const supersedes = (fields.supersedes ?? "")
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter((s) => ENTRY_ID_RE.test(s) && s !== id);
	const supersededBy = fields["superseded-by"] && ENTRY_ID_RE.test(fields["superseded-by"]) ? fields["superseded-by"] : undefined;
	return {
		id,
		time,
		project,
		layer,
		source,
		tags,
		text: "",
		...(seen ? { seen } : {}),
		...(last ? { last } : {}),
		...(supersedes.length > 0 ? { supersedes } : {}),
		...(supersededBy ? { supersededBy } : {}),
	};
}
