/**
 * Converts terminal output with ANSI colors into an SVG image. Used for the README screenshot:
 *
 *   tmux capture-pane -p -e -t <pane> | node --experimental-strip-types scripts/ansi-to-svg.ts > shot.svg
 *
 * Handles the SGR codes pi-grove emits: bold, dim, reverse, and 16, 256 and true colors.
 * Every character is assumed to be one cell wide, so capture a screen without wide characters.
 */

import { readFileSync } from "node:fs";

const CELL_WIDTH = 8.4;
const CELL_HEIGHT = 18;
const FONT_SIZE = 14;
const PADDING = 16;
const BACKGROUND = "#16181d";
const FOREGROUND = "#d7dae0";

const BASE16 = [
	"#3b4048", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
	"#5c6370", "#ef7a85", "#a8d38a", "#f0cf8f", "#74bcff", "#d58af0", "#66c8d4", "#ffffff",
];

function color256(index: number): string {
	if (index < 16) return BASE16[index] ?? FOREGROUND;
	if (index >= 232) {
		const level = 8 + (index - 232) * 10;
		return rgb(level, level, level);
	}
	const value = index - 16;
	const steps = [0, 95, 135, 175, 215, 255];
	return rgb(steps[Math.floor(value / 36)] ?? 0, steps[Math.floor(value / 6) % 6] ?? 0, steps[value % 6] ?? 0);
}

function rgb(red: number, green: number, blue: number): string {
	return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

interface Style {
	fg?: string;
	bg?: string;
	bold: boolean;
	dim: boolean;
	reverse: boolean;
}

interface Run extends Style {
	column: number;
	text: string;
}

function applySgr(style: Style, codes: number[]): void {
	for (let i = 0; i < codes.length; i++) {
		const code = codes[i] ?? 0;
		if (code === 0) Object.assign(style, { fg: undefined, bg: undefined, bold: false, dim: false, reverse: false });
		else if (code === 1) style.bold = true;
		else if (code === 2) style.dim = true;
		else if (code === 22) Object.assign(style, { bold: false, dim: false });
		else if (code === 7) style.reverse = true;
		else if (code === 27) style.reverse = false;
		else if (code === 39) style.fg = undefined;
		else if (code === 49) style.bg = undefined;
		else if (code >= 30 && code <= 37) style.fg = BASE16[code - 30];
		else if (code >= 90 && code <= 97) style.fg = BASE16[code - 82];
		else if (code >= 40 && code <= 47) style.bg = BASE16[code - 40];
		else if (code >= 100 && code <= 107) style.bg = BASE16[code - 92];
		else if (code === 38 || code === 48) {
			let value: string | undefined;
			if (codes[i + 1] === 5) {
				value = color256(codes[i + 2] ?? 0);
				i += 2;
			} else if (codes[i + 1] === 2) {
				value = rgb(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0);
				i += 4;
			}
			if (code === 38) style.fg = value;
			else style.bg = value;
		}
	}
}

function parseLine(line: string, style: Style): Run[] {
	const runs: Run[] = [];
	let column = 0;
	// Split into SGR sequences and the text between them; other escape sequences are dropped.
	for (const part of line.split(/(\x1b\[[0-9;:]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/)) {
		if (!part) continue;
		if (part.startsWith("\x1b")) {
			if (part.endsWith("m")) {
				const body = part.slice(2, -1);
				applySgr(style, body === "" ? [0] : body.split(/[;:]/).map(Number));
			}
			continue;
		}
		const length = [...part].length;
		runs.push({ ...style, column, text: part });
		column += length;
	}
	return runs;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const input = readFileSync(0, "utf8").replace(/\n+$/, "");
const lines = input.split("\n");
const style: Style = { bold: false, dim: false, reverse: false };
const rows = lines.map((line) => parseLine(line, style));
const columns = Math.max(...rows.map((runs) => runs.reduce((end, run) => Math.max(end, run.column + [...run.text].length), 0)));

const width = Math.ceil(columns * CELL_WIDTH + PADDING * 2);
const height = lines.length * CELL_HEIGHT + PADDING * 2;
const out: string[] = [
	`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
	`<rect width="${width}" height="${height}" rx="8" fill="${BACKGROUND}"/>`,
	`<g font-family="'SF Mono', Menlo, Monaco, Consolas, 'DejaVu Sans Mono', monospace" font-size="${FONT_SIZE}">`,
];

rows.forEach((runs, row) => {
	const top = PADDING + row * CELL_HEIGHT;
	for (const run of runs) {
		const length = [...run.text].length;
		const x = (PADDING + run.column * CELL_WIDTH).toFixed(1);
		const runWidth = (length * CELL_WIDTH).toFixed(1);
		let fg = run.fg ?? FOREGROUND;
		let bg = run.bg;
		if (run.reverse) [fg, bg] = [bg ?? BACKGROUND, fg];
		if (bg) out.push(`<rect x="${x}" y="${top}" width="${runWidth}" height="${CELL_HEIGHT}" fill="${bg}"/>`);
		// One x position per character keeps the grid exact whatever font the viewer picks.
		const characters = [...run.text];
		const positions: string[] = [];
		let text = "";
		characters.forEach((character, index) => {
			if (character === " ") return;
			positions.push((PADDING + (run.column + index) * CELL_WIDTH).toFixed(1));
			text += character;
		});
		if (!text) continue;
		const attributes = [
			`x="${positions.join(" ")}"`,
			`y="${top + CELL_HEIGHT - 5}"`,
			`fill="${fg}"`,
			run.bold ? 'font-weight="bold"' : "",
			run.dim ? 'opacity="0.55"' : "",
		].filter(Boolean);
		out.push(`<text ${attributes.join(" ")}>${escapeXml(text)}</text>`);
	}
});
out.push("</g>", "</svg>");
process.stdout.write(`${out.join("\n")}\n`);
