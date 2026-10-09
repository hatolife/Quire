import { Channel } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import MarkdownIt from "markdown-it";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import type { FloatingPaneKind, FloatingPaneState } from "./layout/DetachedPane";
import { defaultDockTree, moveDockPanel, normalizeDockTree, setDockAxis, updateDockSplit, type DockNode, type DockEdge } from "./layout/dock-tree";
import { mountDockTree } from "./layout/mount-dock-tree";
import BrowserPane from "./browser/BrowserPane";
import GraphPane from "./graph/GraphPane";
import CommandPalette, { type AppCommand } from "./commands/CommandPalette";
import QuickOpen from "./commands/QuickOpen";
import TemplatePicker from "./commands/TemplatePicker";
import NeovimEditor from "./editor/NeovimEditor";
import {
	assetImport,
	assetRead,
	documentBacklinks,
	documentCreate,
	documentCreateWithContent,
	documentDelete,
	documentExists,
	documentMove,
	documentOpen,
	documentResolveMarkdownLink,
	documentResolveWikiLink,
	editorGotoLine,
	editorInsertText,
	editorReplaceContent,
	editorSave,
	editorSetTopLine,
	editorToggleTask,
	historyCreateSnapshot,
	historyList,
	historyListDocuments,
	historyPrune,
	historyReadFile,
	historyRestoreFile,
	logAppend,
	logClear,
	logFilePath,
	logRecent,
	recoveryClear,
	recoveryLoad,
	recoverySave,
	settingsLoad,
	settingsSave,
	workspaceDocuments,
	workspaceEnsureDirectory,
	workspaceGraph,
	workspaceList,
	workspaceOpen,
	workspaceReindex,
	workspaceRefreshDocumentIndex,
	workspaceSearch,
	workspaceTags,
	workspaceTemplates,
	workspaceWatch,
	workspaceWatchStop,
	type Backlink,
	type DesktopSettings,
	type Document,
	type LayoutPreset,
	type MacroDefinition,
	type LinkGraph,
	type LogEntry,
	type RecoveryDraft,
	type SearchHit,
	type Snapshot,
	type TagInfo,
	type WorkspaceEntry,
	type WorkspaceInfo,
	type WorkspaceWatchMessage,
} from "./ipc";

const markdown = new MarkdownIt({
	html: false,
	linkify: true,
	typographer: false,
});

markdown.inline.ruler.before("emphasis", "quire_wiki_embed", (state, silent) => {
	if(state.src.slice(state.pos, state.pos + 3) !== "![["){ return false; }
	const end = state.src.indexOf("]]", state.pos + 3);
	if(end < 0){ return false; }
	const body = state.src.slice(state.pos + 3, end).trim();
	if(!body){ return false; }
	const separator = body.indexOf("|");
	const target = (separator >= 0 ? body.slice(0, separator) : body).trim();
	const label = (separator >= 0 ? body.slice(separator + 1) : target).trim() || target;
	if(!target){ return false; }
	if(!silent){
		const token = state.push("quire_wiki_embed", "", 0);
		token.meta = { target, label };
	}
	state.pos = end + 2;
	return true;
});

markdown.inline.ruler.before("emphasis", "quire_wiki_link", (state, silent) => {
	if(state.src.slice(state.pos, state.pos + 2) !== "[["){ return false; }
	const end = state.src.indexOf("]]", state.pos + 2);
	if(end < 0){ return false; }
	const body = state.src.slice(state.pos + 2, end).trim();
	if(!body){ return false; }
	const separator = body.indexOf("|");
	const target = (separator >= 0 ? body.slice(0, separator) : body).trim();
	const label = (separator >= 0 ? body.slice(separator + 1) : target).trim() || target;
	if(!target){ return false; }
	if(!silent){
		const open = state.push("link_open", "a", 1);
		open.attrSet("href", "quire-wiki:" + encodeURIComponent(target));
		open.attrSet("class", "wiki-link");
		const text = state.push("text", "", 0);
		text.content = label;
		state.push("link_close", "a", -1);
	}
	state.pos = end + 2;
	return true;
});

markdown.inline.ruler.before("emphasis", "quire_highlight", (state, silent) => {
	if(state.src.slice(state.pos, state.pos + 2) !== "=="){ return false; }
	const end = state.src.indexOf("==", state.pos + 2);
	if(end < 0 || end === state.pos + 2){ return false; }
	if(!silent){
		state.push("mark_open", "mark", 1);
		const text = state.push("text", "", 0);
		text.content = state.src.slice(state.pos + 2, end);
		state.push("mark_close", "mark", -1);
	}
	state.pos = end + 2;
	return true;
});

const PREVIEW_IMAGE_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

function isPreviewImageTarget(target: string): boolean {
	const path = target.split("#", 1)[0].split("?", 1)[0];
	return /\.(?:png|jpe?g|gif|webp|bmp|avif|svg|ico)$/i.test(path);
}

markdown.renderer.rules.quire_wiki_embed = (tokens, index) => {
	const token = tokens[index];
	const target = String(token.meta?.target ?? "");
	const label = String(token.meta?.label ?? target);
	const sourceDocument = token.attrGet("data-quire-source-document") ?? "";
	const disabled = token.attrGet("data-quire-document-embed-disabled") === "true";
	const sourceAttr = sourceDocument ? ' data-quire-source-document="' + escapePreviewHtml(sourceDocument) + '"' : "";
	if(isPreviewImageTarget(target)){
		return '<img class="wiki-embed-image" src="' + PREVIEW_IMAGE_PLACEHOLDER
			+ '" data-quire-asset="' + escapePreviewHtml(target)
			+ '"' + sourceAttr
			+ ' alt="' + escapePreviewHtml(label) + '">';
	}
	if(disabled){
		return '<a class="wiki-link wiki-embed-fallback" href="quire-wiki:' + encodeURIComponent(target)
			+ '"' + sourceAttr + '>' + escapePreviewHtml(label) + '</a>';
	}
	return '<section class="wiki-document-embed" data-quire-wiki-embed-target="' + escapePreviewHtml(target)
		+ '"' + sourceAttr + '><div class="wiki-document-embed-loading">埋め込みを読み込み中: '
		+ escapePreviewHtml(label) + '</div></section>';
};

function isLocalAssetSource(source: string): boolean {
	if(!source || source.startsWith("/") || source.startsWith("\\")){ return false; }
	if(source.startsWith("#") || source.startsWith("//")){ return false; }
	return !/^[a-z][a-z0-9+.-]*:/i.test(source);
}

function decoratePreviewTokens(
	tokens: any[],
	lineOffset = 0,
	sourceDocument?: string,
	allowDocumentEmbeds = true,
) {
	for(const token of tokens){
		if(token.map && token.nesting === 1){
			token.attrSet("data-source-line", String(token.map[0] + lineOffset));
		}
		if(sourceDocument && token.type === "link_open"){
			token.attrSet("data-quire-source-document", sourceDocument);
		}
		if(token.type === "image"){
			const source = token.attrGet("src");
			if(source && isLocalAssetSource(source)){
				token.attrSet("data-quire-asset", source);
				if(sourceDocument){ token.attrSet("data-quire-source-document", sourceDocument); }
				token.attrSet("src", PREVIEW_IMAGE_PLACEHOLDER);
			}
		}
		if(token.type === "quire_wiki_embed"){
			if(sourceDocument){ token.attrSet("data-quire-source-document", sourceDocument); }
			if(!allowDocumentEmbeds){ token.attrSet("data-quire-document-embed-disabled", "true"); }
		}
		if(token.children){
			decoratePreviewTokens(token.children, lineOffset, sourceDocument, allowDocumentEmbeds);
		}
	}
}

function escapePreviewHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function splitFrontMatter(source: string): { body: string; lineOffset: number; frontMatter?: string } {
	const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if(!normalized.startsWith("---\n")){ return { body: normalized, lineOffset: 0 }; }
	const lines = normalized.split("\n");
	for(let index = 1; index < lines.length; ++index){
		if(lines[index] !== "---" && lines[index] !== "..."){ continue; }
		return {
			frontMatter: lines.slice(1, index).join("\n"),
			body: lines.slice(index + 1).join("\n"),
			lineOffset: index + 1,
		};
	}
	return { body: normalized, lineOffset: 0 };
}

type FrontMatterProperty = {
	key: string;
	values: string[];
};

function unquoteFrontMatterValue(value: string): string {
	const trimmed = value.trim();
	if(trimmed.length >= 2){
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if((first === '"' && last === '"') || (first === "'" && last === "'")){
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

function splitInlineFrontMatterList(value: string): string[] | null {
	const trimmed = value.trim();
	if(!trimmed.startsWith("[") || !trimmed.endsWith("]")){ return null; }
	const body = trimmed.slice(1, -1);
	const values: string[] = [];
	let current = "";
	let quote = "";
	let escaped = false;
	for(const ch of body){
		if(escaped){
			current += ch;
			escaped = false;
			continue;
		}
		if(ch === "\\"){
			current += ch;
			escaped = true;
			continue;
		}
		if(quote){
			current += ch;
			if(ch === quote){ quote = ""; }
			continue;
		}
		if(ch === '"' || ch === "'"){
			quote = ch;
			current += ch;
			continue;
		}
		if(ch === ","){
			const item = unquoteFrontMatterValue(current);
			if(item){ values.push(item); }
			current = "";
			continue;
		}
		current += ch;
	}
	if(quote){ return null; }
	const item = unquoteFrontMatterValue(current);
	if(item){ values.push(item); }
	return values;
}

function parseFrontMatterProperties(frontMatter: string): { properties: FrontMatterProperty[]; complete: boolean } {
	const lines = frontMatter.split("\n");
	const properties: FrontMatterProperty[] = [];
	let complete = true;

	for(let index = 0; index < lines.length; ++index){
		const line = lines[index];
		const trimmed = line.trim();
		if(!trimmed || trimmed.startsWith("#")){ continue; }
		if(/^\s/.test(line)){
			complete = false;
			continue;
		}

		const match = line.match(/^([^:#][^:]*):(?:[ \t]*(.*))?$/);
		if(!match){
			complete = false;
			continue;
		}
		const key = match[1].trim();
		const rawValue = (match[2] ?? "").trim();
		if(!key){
			complete = false;
			continue;
		}

		if(rawValue){
			const inline = splitInlineFrontMatterList(rawValue);
			properties.push({
				key,
				values: inline ?? [unquoteFrontMatterValue(rawValue)],
			});
			continue;
		}

		const values: string[] = [];
		let cursor = index + 1;
		while(cursor < lines.length){
			const nested = lines[cursor];
			if(!/^\s/.test(nested)){ break; }
			const item = nested.trim();
			if(!item){
				++cursor;
				continue;
			}
			const listMatch = item.match(/^-\s+(.+)$/);
			if(!listMatch){
				complete = false;
				break;
			}
			values.push(unquoteFrontMatterValue(listMatch[1]));
			++cursor;
		}
		if(cursor > index + 1){
			index = cursor - 1;
			properties.push({ key, values });
		}else{
			properties.push({ key, values: [] });
		}
	}
	return { properties, complete };
}

function prepareObsidianPreviewBody(source: string): string {
	const lines = source.split("\n");
	let inFence = false;
	let inComment = false;
	const backtickFence = String.fromCharCode(96, 96, 96);

	return lines.map(line => {
		const trimmed = line.trimStart();
		if(!inComment && (trimmed.startsWith(backtickFence) || trimmed.startsWith("~~~"))){
			inFence = !inFence;
			return line;
		}
		if(inFence){ return line; }

		let output = "";
		let index = 0;
		let inlineTicks = 0;
		while(index < line.length){
			if(inComment){
				const close = line.indexOf("%%", index);
				if(close < 0){ return output; }
				inComment = false;
				index = close + 2;
				continue;
			}

			if(line[index] === String.fromCharCode(96)){
				let run = 1;
				while(index + run < line.length && line[index + run] === String.fromCharCode(96)){ ++run; }
				if(inlineTicks === 0){
					inlineTicks = run;
				}else if(inlineTicks === run){
					inlineTicks = 0;
				}
				output += line.slice(index, index + run);
				index += run;
				continue;
			}

			if(inlineTicks === 0 && line.slice(index, index + 2) === "%%"){
				inComment = true;
				index += 2;
				continue;
			}

			output += line[index];
			++index;
		}

		return output.replace(/(?:^|\s)\^[A-Za-z0-9-]+\s*$/, "").replace(/[ \t]+$/, "");
	}).join("\n");
}

function renderFrontMatterValue(key: string, value: string): string {
	const escaped = escapePreviewHtml(value);
	const normalizedKey = key.toLowerCase();
	if(normalizedKey === "tags" || normalizedKey === "tag"){
		const tag = value.replace(/^#/, "");
		return '<a class="property-chip property-tag" href="quire-tag:' + encodeURIComponent(tag) + '">#'
			+ escapePreviewHtml(tag) + '</a>';
	}
	if(normalizedKey === "aliases" || normalizedKey === "alias"){
		return '<span class="property-chip property-alias">' + escaped + '</span>';
	}
	if(/^(true|false)$/i.test(value)){
		return '<span class="property-boolean">' + escaped.toLowerCase() + '</span>';
	}
	return '<span class="property-value">' + escaped + '</span>';
}

function renderFrontMatter(frontMatter: string | undefined): string {
	if(frontMatter === undefined){ return ""; }
	const parsed = parseFrontMatterProperties(frontMatter);
	const rows = parsed.properties.map(property => {
		const values = property.values.length > 0
			? property.values.map(value => renderFrontMatterValue(property.key, value)).join("")
			: '<span class="property-empty">—</span>';
		return '<div class="property-row"><span class="property-key">'
			+ escapePreviewHtml(property.key)
			+ '</span><div class="property-values">'
			+ values
			+ '</div></div>';
	}).join("");
	const raw = '<details class="frontmatter-raw"><summary>Raw YAML</summary><pre>'
		+ escapePreviewHtml(frontMatter)
		+ '</pre></details>';
	return '<section class="frontmatter" data-source-line="0">'
		+ '<div class="frontmatter-heading">Properties</div>'
		+ (rows || '<div class="property-empty-state">Propertyはありません。</div>')
		+ (!parsed.complete ? '<div class="frontmatter-note">複雑なYAMLはRaw YAMLにそのまま保持されています。</div>' : "")
		+ raw
		+ '</section>';
}

function renderTaggedText(value: string): string {
	const pattern = /(^|[^\p{L}\p{N}_\-\/#])#([\p{L}\p{N}_\-/]+)/gu;
	let result = "";
	let last = 0;
	for(const match of value.matchAll(pattern)){
		const tag = match[2];
		if(!/[\p{L}_]/u.test(tag)){ continue; }
		const matchIndex = match.index ?? 0;
		const hashIndex = matchIndex + match[1].length;
		result += escapePreviewHtml(value.slice(last, hashIndex));
		result += '<a class="quire-tag" href="quire-tag:' + encodeURIComponent(tag) + '">#'
			+ escapePreviewHtml(tag) + '</a>';
		last = hashIndex + tag.length + 1;
	}
	result += escapePreviewHtml(value.slice(last));
	return result;
}

function decorateTagTokens(tokens: any[]) {
	let linkDepth = 0;
	for(const token of tokens){
		if(token.type === "link_open"){
			++linkDepth;
			continue;
		}
		if(token.type === "link_close"){
			linkDepth = Math.max(0, linkDepth - 1);
			continue;
		}
		if(token.type === "text" && linkDepth === 0 && token.content.includes("#")){
			token.type = "quire_tag_text";
		}
		if(token.children){
			decorateTagTokens(token.children);
		}
	}
}

markdown.renderer.rules.quire_tag_text = (tokens, index) => renderTaggedText(tokens[index].content);

function decorateCalloutTokens(tokens: any[]) {
	for(let index = 0; index < tokens.length; ++index){
		if(tokens[index].type !== "blockquote_open"){ continue; }
		let depth = 1;
		let inlineIndex = -1;
		for(let cursor = index + 1; cursor < tokens.length && depth > 0; ++cursor){
			if(tokens[cursor].type === "blockquote_open"){ ++depth; }
			if(tokens[cursor].type === "blockquote_close"){ --depth; }
			if(depth === 1 && inlineIndex < 0 && tokens[cursor].type === "inline"){
				inlineIndex = cursor;
			}
		}
		if(inlineIndex < 0){ continue; }

		const inline = tokens[inlineIndex];
		const match = inline.content.match(/^\[!([A-Za-z0-9_-]+)\]([+-])?[ \t]*(.*)$/);
		if(!match){ continue; }

		const type = match[1].toLowerCase();
		const title = match[3].trim() || match[1].toUpperCase();
		tokens[index].attrJoin("class", "callout callout-" + type);
		tokens[index].attrSet("data-callout", type);
		if(match[2]){
			tokens[index].attrSet("data-callout-fold", match[2]);
			if(match[2] === "-"){ tokens[index].attrJoin("class", "callout-collapsed"); }
		}

		for(let cursor = index + 1; cursor < inlineIndex; ++cursor){
			if(tokens[cursor].type === "paragraph_open"){
				tokens[cursor].attrJoin("class", "callout-title");
				break;
			}
		}

		inline.content = title;
		if(Array.isArray(inline.children) && inline.children.length > 0){
			inline.children[0].content = title;
			for(let childIndex = 1; childIndex < inline.children.length; ++childIndex){
				inline.children[childIndex].content = "";
			}
		}
	}
}

function decorateTaskListTokens(tokens: any[], interactive: boolean) {
	for(let index = 0; index < tokens.length; ++index){
		if(tokens[index].type !== "list_item_open"){ continue; }
		let depth = 1;
		let inlineIndex = -1;
		for(let cursor = index + 1; cursor < tokens.length && depth > 0; ++cursor){
			if(tokens[cursor].type === "list_item_open"){ ++depth; }
			if(tokens[cursor].type === "list_item_close"){ --depth; }
			if(depth === 1 && inlineIndex < 0 && tokens[cursor].type === "inline"){
				inlineIndex = cursor;
			}
		}
		if(inlineIndex < 0){ continue; }
		const inline = tokens[inlineIndex];
		const match = inline.content.match(/^\[([ xX])\][ \t]+/);
		if(!match){ continue; }

		const checked = match[1].toLowerCase() === "x";
		tokens[index].attrJoin("class", "task-list-item");
		tokens[index].attrSet("data-task-checked", checked ? "true" : "false");
		tokens[index].attrSet("data-task-interactive", interactive ? "true" : "false");
		inline.content = inline.content.slice(match[0].length);

		if(Array.isArray(inline.children)){
			for(const child of inline.children){
				if(child.type !== "text"){ continue; }
				const childMatch = child.content.match(/^\[([ xX])\][ \t]+/);
				if(childMatch){
					child.content = child.content.slice(childMatch[0].length);
				}
				break;
			}
		}
	}
}

const defaultListItemOpen = markdown.renderer.rules.list_item_open
	?? ((tokens: any[], index: number, options: any, _env: any, self: any) => self.renderToken(tokens, index, options));
markdown.renderer.rules.list_item_open = (tokens, index, options, env, self) => {
	const token = tokens[index];
	const rendered = defaultListItemOpen(tokens, index, options, env, self);
	const checked = token.attrGet("data-task-checked");
	if(checked === null){ return rendered; }
	const sourceLine = token.attrGet("data-source-line") ?? "";
	const interactive = token.attrGet("data-task-interactive") === "true";
	return rendered
		+ '<input class="quire-task-checkbox" type="checkbox" data-quire-task-line="' + escapePreviewHtml(sourceLine) + '"'
		+ (checked === "true" ? " checked" : "")
		+ (interactive ? "" : " disabled")
		+ ' aria-label="Task">';
};

function renderPreview(source: string, sourceDocument?: string, allowDocumentEmbeds = true): string {
	const parsed = splitFrontMatter(source);
	const environment = {};
	const tokens = markdown.parse(prepareObsidianPreviewBody(parsed.body), environment);
	decoratePreviewTokens(tokens, parsed.lineOffset, sourceDocument, allowDocumentEmbeds);
	decorateTagTokens(tokens);
	decorateCalloutTokens(tokens);
	decorateTaskListTokens(tokens, allowDocumentEmbeds);
	return renderFrontMatter(parsed.frontMatter) + markdown.renderer.render(tokens, markdown.options, environment);
}

type DocumentHeading = {
	line: number;
	level: number;
	text: string;
};

function extractDocumentHeadings(source: string): DocumentHeading[] {
	const parsed = splitFrontMatter(source);
	const lines = prepareObsidianPreviewBody(parsed.body).split("\n");
	const headings: DocumentHeading[] = [];
	let inFence = false;
	const backtickFence = String.fromCharCode(96, 96, 96);

	for(let index = 0; index < lines.length; ++index){
		const line = lines[index];
		const trimmed = line.trimStart();
		if(trimmed.startsWith(backtickFence) || trimmed.startsWith("~~~")){
			inFence = !inFence;
			continue;
		}
		if(inFence){ continue; }

		const atx = line.match(/^[ \t]{0,3}(#{1,6})[ \t]+(.+?)\s*$/);
		if(atx){
			headings.push({
				line: parsed.lineOffset + index + 1,
				level: atx[1].length,
				text: cleanHeadingText(atx[2]),
			});
			continue;
		}

		if(index + 1 < lines.length && line.trim()){
			const underline = lines[index + 1];
			const setext = underline.match(/^[ \t]{0,3}(=+|-+)[ \t]*$/);
			if(setext){
				headings.push({
					line: parsed.lineOffset + index + 1,
					level: setext[1][0] === "=" ? 1 : 2,
					text: cleanHeadingText(line),
				});
				++index;
			}
		}
	}
	return headings.filter(heading => heading.text.length > 0);
}

function contentForEditor(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

function decodeHeadingFragment(fragment: string): string {
	const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
	try{
		return decodeURIComponent(raw);
	}catch{
		return raw;
	}
}

function headingSlug(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase()
		.trim()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function cleanHeadingText(value: string): string {
	return value
		.replace(/\s+#+\s*$/, "")
		.replace(/[*_~]/g, "")
		.replace(new RegExp(String.fromCharCode(96), "g"), "")
		.trim();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^{}()|[\]\\]/g, "\\$&");
}

function findBlockReferenceLine(source: string, fragment: string): number | undefined {
	const wanted = decodeHeadingFragment(fragment).trim();
	if(!wanted.startsWith("^") || wanted.length <= 1){ return undefined; }
	const blockId = wanted.slice(1);
	const pattern = new RegExp("(?:^|\\s)\\^" + escapeRegExp(blockId) + "\\s*$");
	const lines = source.split("\n");
	let inFence = false;
	const backtickFence = String.fromCharCode(96, 96, 96);
	for(let index = 0; index < lines.length; ++index){
		const trimmed = lines[index].trimStart();
		if(trimmed.startsWith(backtickFence) || trimmed.startsWith("~~~")){
			inFence = !inFence;
			continue;
		}
		if(!inFence && pattern.test(lines[index])){ return index + 1; }
	}
	return undefined;
}

function findHeadingLine(source: string, fragment: string): number | undefined {
	const wanted = decodeHeadingFragment(fragment).trim();
	if(!wanted || wanted.startsWith("^")){ return undefined; }
	const wantedLower = wanted.toLocaleLowerCase();
	const wantedSlug = headingSlug(wanted);
	const lines = source.split("\n");
	let inFence = false;
	const backtickFence = String.fromCharCode(96, 96, 96);

	const matches = (text: string) => {
		const cleaned = cleanHeadingText(text);
		return cleaned.toLocaleLowerCase() === wantedLower || headingSlug(cleaned) === wantedSlug;
	};

	for(let index = 0; index < lines.length; ++index){
		const line = lines[index];
		const trimmed = line.trimStart();
		if(trimmed.startsWith(backtickFence) || trimmed.startsWith("~~~")){
			inFence = !inFence;
			continue;
		}
		if(inFence){ continue; }

		const atx = line.match(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)\s*$/);
		if(atx && matches(atx[1])){ return index + 1; }

		if(index + 1 < lines.length && line.trim()){
			const underline = lines[index + 1];
			if(/^[ \t]{0,3}(?:=+|-+)[ \t]*$/.test(underline) && matches(line)){
				return index + 1;
			}
		}
	}
	return undefined;
}

function findFragmentLine(source: string, fragment: string): number | undefined {
	const decoded = decodeHeadingFragment(fragment).trim();
	return decoded.startsWith("^")
		? findBlockReferenceLine(source, decoded)
		: findHeadingLine(source, decoded);
}

function extractBlockReference(source: string, fragment: string): string | undefined {
	const decoded = decodeHeadingFragment(fragment).trim();
	const lineNumber = findBlockReferenceLine(source, decoded);
	if(lineNumber === undefined){ return undefined; }
	const lines = source.split("\n");
	const index = lineNumber - 1;
	const blockId = decoded.startsWith("^") ? decoded.slice(1) : decoded;
	const marker = new RegExp("\\s*\\^" + escapeRegExp(blockId) + "\\s*$");
	let start = index;
	const currentWithoutMarker = lines[index].replace(marker, "");
	if(currentWithoutMarker.trim() === ""){
		start = Math.max(0, index - 1);
	}else{
		lines[index] = currentWithoutMarker;
	}
	while(start > 0){
		const previous = lines[start - 1];
		if(!previous.trim()){ break; }
		if(/^[ \t]{0,3}#{1,6}[ \t]+/.test(previous)){ break; }
		if(previous.trimStart().startsWith(String.fromCharCode(96, 96, 96)) || previous.trimStart().startsWith("~~~")){ break; }
		start -= 1;
	}
	const end = currentWithoutMarker.trim() === "" ? index : index + 1;
	const selected = lines.slice(start, end);
	if(selected.length > 0){
		const last = selected.length - 1;
		selected[last] = selected[last].replace(marker, "");
	}
	return selected.join("\n").trimEnd();
}

function headingLevelAt(lines: string[], index: number): number | undefined {
	const atx = lines[index]?.match(/^[ \t]{0,3}(#{1,6})[ \t]+/);
	if(atx){ return atx[1].length; }
	if(index + 1 < lines.length && lines[index].trim()){
		const underline = lines[index + 1];
		if(/^[ \t]{0,3}=+[ \t]*$/.test(underline)){ return 1; }
		if(/^[ \t]{0,3}-+[ \t]*$/.test(underline)){ return 2; }
	}
	return undefined;
}

function extractHeadingSection(source: string, fragment: string): string | undefined {
	const lineNumber = findHeadingLine(source, fragment);
	if(lineNumber === undefined){ return undefined; }
	const lines = source.split("\n");
	const start = lineNumber - 1;
	const level = headingLevelAt(lines, start);
	if(level === undefined){ return undefined; }
	let end = lines.length;
	for(let index = start + 1; index < lines.length; ++index){
		const candidate = headingLevelAt(lines, index);
		if(candidate !== undefined && candidate <= level){
			end = index;
			break;
		}
	}
	return lines.slice(start, end).join("\n").trimEnd();
}

function extractEmbeddedFragment(source: string, fragment: string): string | undefined {
	const decoded = decodeHeadingFragment(fragment).trim();
	if(!decoded){ return source; }
	return decoded.startsWith("^")
		? extractBlockReference(source, decoded)
		: extractHeadingSection(source, decoded);
}

function linkFragment(value: string): string | undefined {
	const index = value.indexOf("#");
	if(index < 0 || index + 1 >= value.length){ return undefined; }
	return value.slice(index + 1);
}

type DockPanel = "explorer" | "editor" | "right";

function App() {
	let workspaceElement!: HTMLDivElement;
	let previewElement!: HTMLDivElement;
	let explorerSearchInput!: HTMLInputElement;
	let suppressEditorViewport = false;
	let suppressPreviewScroll = false;
	let closeUnlisten: (() => void) | undefined;
	let dragDropUnlisten: (() => void) | undefined;
	let commandKeyHandler: ((event: KeyboardEvent) => void) | undefined;
	let reconcileTimer: number | undefined;
	let searchTimer: number | undefined;
	let settingsTimer: number | undefined;
	let autoSnapshotTimer: number | undefined;
	let documentAutoSaveTimer: number | undefined;
	let recoveryTimer: number | undefined;
	let dockMountFrame: number | undefined;
	let watchGeneration = 0;
	let searchReindexPending = false;
	let pendingWatchChanges: Array<{ change: "create" | "modify" | "remove" | "other"; paths: string[] }> = [];
	let previewResolveGeneration = 0;
	let focusModeRestore: { explorer: boolean; right: boolean } | undefined;
	const assetCache = new Map<string, Promise<string>>();
	const floatingHandles = new Map<FloatingPaneKind, WebviewWindow>();
	const approvedFloatingClose = new Set<string>();
	const floatingUnlisteners: Array<() => void> = [];

	const [workspace, setWorkspace] = createSignal<WorkspaceInfo | null>(null);
	const [recentWorkspaces, setRecentWorkspaces] = createSignal<string[]>([]);
	const [entries, setEntries] = createSignal<WorkspaceEntry[]>([]);
	const [document, setDocument] = createSignal<Document | null>(null);
	const [openDocuments, setOpenDocuments] = createSignal<string[]>([]);
	const [documentNavigation, setDocumentNavigation] = createSignal<string[]>([]);
	const [documentNavigationIndex, setDocumentNavigationIndex] = createSignal(-1);
	const [draft, setDraft] = createSignal("");
	const [status, setStatus] = createSignal("Workspaceを開いてください");
	const [saving, setSaving] = createSignal(false);
	const [externalConflict, setExternalConflict] = createSignal(false);
	const [editorSession, setEditorSession] = createSignal(0);
	const [explorerWidth, setExplorerWidth] = createSignal(260);
	const [editorRatio, setEditorRatio] = createSignal(0.5);
	const [explorerVisible, setExplorerVisible] = createSignal(true);
	const [rightPaneVisible, setRightPaneVisible] = createSignal(true);
	const [focusMode, setFocusMode] = createSignal(false);
	const [logOpen, setLogOpen] = createSignal(false);
	const [logs, setLogs] = createSignal<LogEntry[]>([]);
	const [searchQuery, setSearchQuery] = createSignal("");
	const [searchResults, setSearchResults] = createSignal<SearchHit[]>([]);
	const [searching, setSearching] = createSignal(false);
	const [searchIndexReady, setSearchIndexReady] = createSignal(false);
	const [searchIndexBuilding, setSearchIndexBuilding] = createSignal(false);
	const [tags, setTags] = createSignal<TagInfo[]>([]);
	const [explorerMode, setExplorerMode] = createSignal<"files" | "tags" | "outline">("files");
	const [initialEditorLine, setInitialEditorLine] = createSignal<number | undefined>();
	const [backlinks, setBacklinks] = createSignal<Backlink[]>([]);
	const [historyOpen, setHistoryOpen] = createSignal(false);
	const [historyBusy, setHistoryBusy] = createSignal(false);
	const [snapshots, setSnapshots] = createSignal<Snapshot[]>([]);
	const [historyComparison, setHistoryComparison] = createSignal<{ snapshot: Snapshot; content: string | null } | null>(null);
	const [historyDocuments, setHistoryDocuments] = createSignal<{ snapshot: Snapshot; paths: string[] } | null>(null);
	const [settingsReady, setSettingsReady] = createSignal(false);
	const [settingsOpen, setSettingsOpen] = createSignal(false);
	const [documentAutoSaveEnabled, setDocumentAutoSaveEnabled] = createSignal(true);
	const [documentAutoSaveDelayMs, setDocumentAutoSaveDelayMs] = createSignal(1000);
	const [autoSnapshotEnabled, setAutoSnapshotEnabled] = createSignal(true);
	const [autoSnapshotDelaySeconds, setAutoSnapshotDelaySeconds] = createSignal(5);
	const [historyRetentionSnapshots, setHistoryRetentionSnapshots] = createSignal(200);
	const [templateDirectory, setTemplateDirectory] = createSignal("Templates");
	const [layoutPresets, setLayoutPresets] = createSignal<LayoutPreset[]>([]);
	const [macros, setMacros] = createSignal<MacroDefinition[]>([]);
	const [sidebarCommands, setSidebarCommands] = createSignal<string[]>(["workspace.quickOpen", "document.daily.open", "pane.preview", "pane.browser", "pane.graph", "history.show"]);
	const [macroRunning, setMacroRunning] = createSignal(false);
	const [floatingPanels, setFloatingPanels] = createSignal<Partial<Record<FloatingPaneKind, string>>>({});
	const [dockOrder, setDockOrder] = createSignal<DockPanel[]>(["explorer", "editor", "right"]);
	const [dockDirection, setDockDirection] = createSignal<"row" | "column">("row");
	const [dockTree, setDockTree] = createSignal<DockNode>(defaultDockTree());
	const [draggingDock, setDraggingDock] = createSignal<DockPanel | null>(null);
	const [dailyNotesDirectory, setDailyNotesDirectory] = createSignal("Daily");
	const [dailyNoteTemplate, setDailyNoteTemplate] = createSignal("Templates/Daily.md");
	const [templatePickerOpen, setTemplatePickerOpen] = createSignal(false);
	const [templates, setTemplates] = createSignal<string[]>([]);
	const [rightPaneMode, setRightPaneMode] = createSignal<"preview" | "browser" | "graph">("preview");
	const [linkGraph, setLinkGraph] = createSignal<LinkGraph | null>(null);
	const [browserTargetUrl, setBrowserTargetUrl] = createSignal<string | undefined>();
	const [commandPaletteOpen, setCommandPaletteOpen] = createSignal(false);
	const [quickOpenVisible, setQuickOpenVisible] = createSignal(false);
	const [quickOpenDocuments, setQuickOpenDocuments] = createSignal<string[]>([]);
	const [recoveryDraft, setRecoveryDraft] = createSignal<RecoveryDraft | null>(null);
	const [recoveryTrackingReady, setRecoveryTrackingReady] = createSignal(false);
	const [draggingImageFiles, setDraggingImageFiles] = createSignal(false);
	const preview = createMemo(() => {
		const path = document()?.relativePath;
		if(!path){ return ""; }
		if(!/\.md(?:own)?$/i.test(path)){
			return '<div class="empty-pane">このファイルはNeovimで編集できます。Markdown PreviewはMarkdown文書でのみ使用できます。</div>';
		}
		return renderPreview(draft(), path);
	});
	const documentHeadings = createMemo(() => {
		const path = document()?.relativePath;
		return path && /\.md(?:own)?$/i.test(path) ? extractDocumentHeadings(draft()) : [];
	});
	const dirty = createMemo(() => document() !== null && draft() !== contentForEditor(document()!.content));

	const decodeAssetSource = (source: string) => {
		const pathOnly = source.split("#", 1)[0].split("?", 1)[0];
		try{
			return decodeURIComponent(pathOnly);
		}catch{
			return pathOnly;
		}
	};

	const loadPreviewAsset = (documentRelativePath: string, source: string) => {
		const decoded = decodeAssetSource(source);
		const key = documentRelativePath + "\n" + decoded;
		let pending = assetCache.get(key);
		if(!pending){
			pending = assetRead(documentRelativePath, decoded).catch(error => {
				assetCache.delete(key);
				throw error;
			});
			assetCache.set(key, pending);
		}
		return pending;
	};

	const resolvePreviewAssets = async (documentRelativePath: string, generation = previewResolveGeneration) => {
		if(!previewElement){ return; }
		const images = Array.from(previewElement.querySelectorAll<HTMLImageElement>("img[data-quire-asset]"));
		await Promise.all(images.map(async image => {
			const source = image.dataset.quireAsset;
			if(!source){ return; }
			const sourceDocument = image.dataset.quireSourceDocument || documentRelativePath;
			try{
				const resolved = await loadPreviewAsset(sourceDocument, source);
				if(generation !== previewResolveGeneration){ return; }
				image.src = resolved;
				image.removeAttribute("data-quire-asset");
			}catch(error){
				if(generation !== previewResolveGeneration){ return; }
				image.alt = (image.alt ? image.alt + " — " : "") + "画像を読み込めません";
				image.classList.add("preview-asset-error");
				void appendLog("warn", "preview", "Asset load error: " + source + " / " + String(error));
			}
		}));
	};

	const resolvePreviewEmbeds = async (documentRelativePath: string, generation: number) => {
		if(!previewElement){ return; }
		const embeds = Array.from(previewElement.querySelectorAll<HTMLElement>("[data-quire-wiki-embed-target]"));
		await Promise.all(embeds.map(async element => {
			const rawTarget = element.dataset.quireWikiEmbedTarget;
			if(!rawTarget){ return; }
			const sourceDocument = element.dataset.quireSourceDocument || documentRelativePath;
			try{
				const resolved = await documentResolveWikiLink(sourceDocument, rawTarget);
				if(generation !== previewResolveGeneration){ return; }
				if(!resolved){
					element.innerHTML = '<div class="wiki-document-embed-error">未解決embed: '
						+ escapePreviewHtml(rawTarget) + "</div>";
					return;
				}
				const embedded = await documentOpen(resolved);
				if(generation !== previewResolveGeneration){ return; }
				const source = contentForEditor(embedded.content);
				const fragment = linkFragment(rawTarget);
				const renderedSource = fragment ? extractEmbeddedFragment(source, fragment) : source;
				if(fragment && renderedSource === undefined){
					element.innerHTML = '<div class="wiki-document-embed-error">embed対象が見つかりません: '
						+ escapePreviewHtml(rawTarget) + "</div>";
					return;
				}
				element.dataset.quireEmbeddedDocument = resolved;
				element.removeAttribute("data-quire-wiki-embed-target");
				element.innerHTML = renderPreview(renderedSource ?? source, resolved, false);
			}catch(error){
				if(generation !== previewResolveGeneration){ return; }
				element.innerHTML = '<div class="wiki-document-embed-error">embed読込失敗: '
					+ escapePreviewHtml(String(error)) + "</div>";
			}
		}));
	};

	const appendLog = async (level: string, source: string, message: string) => {
		try{
			await logAppend(level, source, message);
		}catch{
			// Logging must never break the primary UI flow.
		}
	};

	const updateStatus = (message: string, level = "info", source = "app") => {
		setStatus(message);
		void appendLog(level, source, message);
	};

	const refreshLogs = async () => {
		try{
			setLogs(await logRecent());
		}catch(error){
			setStatus("Log read error: " + String(error));
		}
	};

	const toggleLogs = () => {
		const next = !logOpen();
		setLogOpen(next);
		if(next){ void refreshLogs(); }
	};

	const clearLogs = async () => {
		try{
			await logClear();
			setLogs([]);
		}catch(error){
			setStatus("Log clear error: " + String(error));
		}
	};

	const copyLogFilePath = async () => {
		try{
			const path = await logFilePath();
			if(!path){ throw new Error("ログファイルが初期化されていません。"); }
			await navigator.clipboard.writeText(path);
			updateStatus("ログファイルの場所をコピーしました: " + path, "info", "log");
		}catch(error){
			updateStatus("ログファイルの場所: " + String(error), "error", "log");
		}
	};

	const rebuildSearchIndex = async (reason = "manual") => {
		if(!workspace()){
			setSearchIndexReady(false);
			setTags([]);
			return;
		}
		if(searchIndexBuilding()){
			searchReindexPending = true;
			return;
		}
		setSearchIndexBuilding(true);
		try{
			do{
				searchReindexPending = false;
				const count = await workspaceReindex();
				if(count !== null){
					setSearchIndexReady(true);
					void workspaceTags()
						.then(setTags)
						.catch(error => updateStatus("Tag index read error: " + String(error), "error", "index"));
					void workspaceDocuments()
						.then(paths => {
							const existing = new Set(paths);
							setOpenDocuments(open => open.filter(path => existing.has(path)));
							if(quickOpenVisible()){ setQuickOpenDocuments(paths); }
						})
						.catch(error => updateStatus("Document index read error: " + String(error), "error", "index"));
					const current = document();
					if(current){
						void documentBacklinks(current.relativePath)
							.then(setBacklinks)
							.catch(error => updateStatus("Backlink index read error: " + String(error), "error", "links"));
					}
					void workspaceGraph()
						.then(setLinkGraph)
						.catch(error => updateStatus("Graph index read error: " + String(error), "error", "links"));
					void appendLog("info", "index", "Search/link indexes rebuilt: " + count + " documents / " + reason);
				}
			}while(searchReindexPending && workspace());
		}catch(error){
			setSearchIndexReady(false);
			updateStatus("Search index rebuild error: " + String(error), "error", "index");
		}finally{
			setSearchIndexBuilding(false);
		}
	};

	const invalidateSearchIndex = (reason: string) => {
		setSearchIndexReady(false);
		void rebuildSearchIndex(reason);
	};

	const refreshOneDocumentIndex = async (relativePath: string, reason: string) => {
		if(!searchIndexReady() || searchIndexBuilding()){
			invalidateSearchIndex(reason);
			return;
		}
		try{
			const refreshed = await workspaceRefreshDocumentIndex(relativePath);
			if(!refreshed){
				invalidateSearchIndex(reason);
				return;
			}
			void workspaceTags()
				.then(setTags)
				.catch(error => updateStatus("Tag index read error: " + String(error), "error", "index"));
			if(document()?.relativePath === relativePath){
				void documentBacklinks(relativePath)
					.then(setBacklinks)
					.catch(error => updateStatus("Backlink index read error: " + String(error), "error", "links"));
			}
			void workspaceGraph()
				.then(setLinkGraph)
				.catch(error => updateStatus("Graph index read error: " + String(error), "error", "links"));
			void appendLog("info", "index", "Document indexes refreshed: " + relativePath + " / " + reason);
		}catch(error){
			invalidateSearchIndex(reason);
			updateStatus("Document index refresh error: " + String(error), "error", "index");
		}
	};

	const navigateOutline = async (heading: DocumentHeading) => {
		if(!document()){ return; }
		try{
			await editorGotoLine(heading.line);
			updateStatus(
				(document()?.relativePath ?? "") + "#" + heading.text,
				"info",
				"outline",
			);
		}catch(error){
			updateStatus("Outline navigation error: " + String(error), "error", "outline");
		}
	};

	const refreshHistory = async () => {
		if(!workspace()){
			setSnapshots([]);
			return;
		}
		setHistoryBusy(true);
		try{
			setSnapshots(await historyList());
		}catch(error){
			setSnapshots([]);
			updateStatus("History error: " + String(error), "error", "history");
		}finally{
			setHistoryBusy(false);
		}
	};

	const createHistorySnapshot = async (message = "Manual snapshot") => {
		if(!workspace()){ return false; }
		setHistoryBusy(true);
		try{
			const snapshot = await historyCreateSnapshot(message, historyRetentionSnapshots());
			updateStatus("Snapshot created: " + snapshot.id.slice(0, 7), "info", "history");
			if(historyOpen()){ await refreshHistory(); }
			return true;
		}catch(error){
			updateStatus("Snapshot error: " + String(error), "error", "history");
			return false;
		}finally{
			setHistoryBusy(false);
		}
	};

	const createSafetySnapshot = async (reason: string) => {
		const ok = await createHistorySnapshot(reason);
		if(ok){ return true; }
		return window.confirm("Safety Snapshotを作成できませんでした。履歴なしで操作を続行しますか？");
	};

	const scheduleAutoSnapshot = (relativePath: string) => {
		if(autoSnapshotTimer !== undefined){ window.clearTimeout(autoSnapshotTimer); }
		if(!autoSnapshotEnabled()){ return; }
		autoSnapshotTimer = window.setTimeout(() => {
			autoSnapshotTimer = undefined;
			void createHistorySnapshot("Auto save " + relativePath);
		}, autoSnapshotDelaySeconds() * 1000);
	};

	const pruneHistoryNow = async () => {
		if(!workspace() || historyBusy()){ return; }
		setHistoryBusy(true);
		try{
			const removed = await historyPrune(historyRetentionSnapshots());
			updateStatus(
				removed > 0 ? "Historyを整理しました: " + removed + "件削除" : "Historyは保持上限内です。",
				"info",
				"history",
			);
			if(historyOpen()){ await refreshHistory(); }
		}catch(error){
			updateStatus("History prune error: " + String(error), "error", "history");
		}finally{
			setHistoryBusy(false);
		}
	};

	const openQuickOpen = async () => {
		setCommandPaletteOpen(false);
		setQuickOpenVisible(true);
		if(!searchIndexReady()){
			setQuickOpenDocuments([]);
			return;
		}
		try{
			setQuickOpenDocuments(await workspaceDocuments());
		}catch(error){
			setQuickOpenDocuments([]);
			updateStatus("Quick Open error: " + String(error), "error", "index");
		}
	};

	const toggleFocusMode = () => {
		if(focusMode()){
			setExplorerVisible(focusModeRestore?.explorer ?? true);
			setRightPaneVisible(focusModeRestore?.right ?? true);
			focusModeRestore = undefined;
			setFocusMode(false);
			return;
		}
		focusModeRestore = {
			explorer: explorerVisible(),
			right: rightPaneVisible(),
		};
		setExplorerVisible(false);
		setRightPaneVisible(false);
		setFocusMode(true);
	};

	const captureLayoutPreset = (name: string): LayoutPreset => ({
		name,
		explorerWidth: explorerWidth(),
		editorRatio: editorRatio(),
		explorerVisible: explorerVisible(),
		rightPaneVisible: rightPaneVisible(),
		explorerMode: explorerMode(),
		rightPaneMode: rightPaneMode(),
		dockTree: dockTree(),
		floatingPanes: Object.keys(floatingPanels()),
	});

	const saveLayoutPreset = () => {
		const input = window.prompt("layout名を入力してください。", "作業");
		if(input === null){ return; }
		const name = input.trim();
		if(!name){ return; }
		const preset = captureLayoutPreset(name);
		setLayoutPresets(current => {
			const index = current.findIndex(value => value.name.toLocaleLowerCase() === name.toLocaleLowerCase());
			if(index < 0){ return [...current, preset]; }
			const next = [...current];
			next[index] = preset;
			return next;
		});
		updateStatus("layoutを保存しました: " + name, "info", "layout");
	};

	const applyLayoutPreset = (preset: LayoutPreset) => {
		focusModeRestore = undefined;
		setFocusMode(false);
		setExplorerWidth(Math.max(180, Math.min(420, preset.explorerWidth)));
		setEditorRatio(Math.max(0.25, Math.min(0.75, preset.editorRatio)));
		setExplorerVisible(preset.explorerVisible);
		setRightPaneVisible(preset.rightPaneVisible);
		setExplorerMode(preset.explorerMode === "tags" ? "tags" : preset.explorerMode === "outline" ? "outline" : "files");
		setRightPaneMode(preset.rightPaneMode === "browser" ? "browser" : preset.rightPaneMode === "graph" ? "graph" : "preview");
		if(preset.dockTree){ setDockTree(normalizeDockTree(preset.dockTree)); }
		updateStatus("layoutを復元しました: " + preset.name, "info", "layout");
	};

	const deleteLayoutPreset = (name: string) => {
		setLayoutPresets(current => current.filter(value => value.name !== name));
		updateStatus("layoutを削除しました: " + name, "info", "layout");
	};

	const resetPaneLayout = () => {
		setDockTree(defaultDockTree());
		setDockOrder(["explorer", "editor", "right"]);
		setDockDirection("row");
		setExplorerWidth(260);
		setEditorRatio(0.5);
		setExplorerVisible(true);
		setRightPaneVisible(true);
		scheduleSettingsSave();
	};

	const toggleHistory = () => {
		const next = !historyOpen();
		setHistoryOpen(next);
		if(!next){
			setHistoryComparison(null);
			setHistoryDocuments(null);
		}
		if(next){ void refreshHistory(); }
	};

	const showHistoryDocuments = async (snapshot: Snapshot) => {
		setHistoryBusy(true);
		try{
			const paths = await historyListDocuments(snapshot.id);
			setHistoryComparison(null);
			setHistoryDocuments({ snapshot, paths });
		}catch(error){
			updateStatus("History Document list error: " + String(error), "error", "history");
		}finally{
			setHistoryBusy(false);
		}
	};

	const compareHistorySnapshot = async (snapshot: Snapshot) => {
		setHistoryDocuments(null);
		const current = document();
		if(!current){ return; }
		setHistoryBusy(true);
		try{
			const content = await historyReadFile(snapshot.id, current.relativePath);
			setHistoryComparison({ snapshot, content });
		}catch(error){
			updateStatus("History compare error: " + String(error), "error", "history");
		}finally{
			setHistoryBusy(false);
		}
	};

	const restoreHistoryDocument = async (snapshot: Snapshot, relativePath: string) => {
		if(dirty()){
			updateStatus("History復元の前に現在の変更を保存してください。", "warn", "history");
			return;
		}
		if(!window.confirm(snapshot.message + "\n\n" + relativePath + " をこのSnapshotから復元しますか？")){ return; }
		setHistoryBusy(true);
		try{
			if(!await createSafetySnapshot("Before restore " + relativePath)){ return; }
			let expectedRevision: string | undefined;
			try{
				expectedRevision = (await documentOpen(relativePath)).revision;
			}catch{
				// Missing document is the expected case when recovering a deleted file.
			}
			const restored = await historyRestoreFile(snapshot.id, relativePath, expectedRevision);
			assetCache.clear();
			await refreshExplorer();
			invalidateSearchIndex("History document restore");
			if(document()?.relativePath === relativePath){
				setDocument(restored);
				setDraft(contentForEditor(restored.content));
				setExternalConflict(false);
				setEditorSession(value => value + 1);
				void refreshBacklinks(restored.relativePath);
			}
			updateStatus("Historyから復元しました: " + relativePath, "info", "history");
		}catch(error){
			updateStatus("History restore error: " + String(error), "error", "history");
		}finally{
			setHistoryBusy(false);
		}
	};

	const restoreCurrentDocument = async (snapshot: Snapshot) => {
		const current = document();
		if(!current || dirty()){
			updateStatus("History復元の前に現在の変更を保存してください。", "warn", "history");
			return;
		}
		if(!window.confirm(snapshot.message + "\n" + new Date(snapshot.timestamp * 1000).toLocaleString() + "\n\n" + current.relativePath + " をこのSnapshotへ復元しますか？")){ return; }
		setHistoryBusy(true);
		try{
			await createHistorySnapshot("Before restore " + current.relativePath);
			const restored = await historyRestoreFile(snapshot.id, current.relativePath, current.revision);
			setDocument(restored);
			setDraft(contentForEditor(restored.content));
			setExternalConflict(false);
			setEditorSession(value => value + 1);
			assetCache.clear();
			void refreshBacklinks(restored.relativePath);
			invalidateSearchIndex("History restore");
			updateStatus("Historyから復元しました: " + restored.relativePath, "info", "history");
		}catch(error){
			updateStatus("History restore error: " + String(error), "error", "history");
		}finally{
			setHistoryBusy(false);
		}
	};

	createEffect(() => {
		preview();
		const relativePath = document()?.relativePath;
		const generation = ++previewResolveGeneration;
		if(!relativePath){ return; }
		requestAnimationFrame(() => {
			void (async () => {
				await resolvePreviewEmbeds(relativePath, generation);
				await resolvePreviewAssets(relativePath, generation);
			})();
		});
	});

	createEffect(() => {
		if(!settingsReady()){ return; }
		explorerWidth();
		editorRatio();
		explorerVisible();
		rightPaneVisible();
		workspace()?.root;
		recentWorkspaces();
		document()?.relativePath;
		openDocuments();
		documentAutoSaveEnabled();
		documentAutoSaveDelayMs();
		autoSnapshotEnabled();
		autoSnapshotDelaySeconds();
		historyRetentionSnapshots();
		templateDirectory();
		layoutPresets();
		macros();
		sidebarCommands();
		dockOrder();
		dockDirection();
		dockTree();
		floatingPanels();
		dailyNotesDirectory();
		dailyNoteTemplate();
		rightPaneMode();
		browserTargetUrl();
		scheduleSettingsSave();
	});

	createEffect(() => {
		const enabled = documentAutoSaveEnabled();
		const delay = documentAutoSaveDelayMs();
		const isDirty = dirty();
		const conflicted = externalConflict();
		const isSaving = saving();
		document()?.revision;
		draft();

		if(documentAutoSaveTimer !== undefined){
			window.clearTimeout(documentAutoSaveTimer);
			documentAutoSaveTimer = undefined;
		}
		if(!enabled || !isDirty || conflicted || isSaving || !document()){ return; }

		documentAutoSaveTimer = window.setTimeout(() => {
			documentAutoSaveTimer = undefined;
			if(dirty() && !externalConflict() && !saving()){
				void saveDocument();
			}
		}, delay);
	});

	createEffect(() => {
		const trackingReady = recoveryTrackingReady();
		const current = document();
		const currentDraft = draft();
		const isDirty = dirty();
		if(recoveryTimer !== undefined){ window.clearTimeout(recoveryTimer); }
		if(!trackingReady || !current || !workspace()){
			return;
		}
		if(!isDirty){
			recoveryTimer = window.setTimeout(() => {
				recoveryTimer = undefined;
				void recoveryClear().catch(error => updateStatus("Recovery clear error: " + String(error), "error", "recovery"));
			}, 250);
			return;
		}
		recoveryTimer = window.setTimeout(() => {
			recoveryTimer = undefined;
			void recoverySave(current.relativePath, current.revision, currentDraft)
				.catch(error => updateStatus("Recovery save error: " + String(error), "error", "recovery"));
		}, 500);
	});

	createEffect(() => {
		const query = searchQuery().trim();
		const indexReady = searchIndexReady();
		if(searchTimer !== undefined){ window.clearTimeout(searchTimer); }
		if(!query || !workspace()){
			setSearchResults([]);
			setSearching(false);
			return;
		}
		if(!indexReady){
			setSearchResults([]);
			setSearching(false);
			return;
		}
		setSearching(true);
		searchTimer = window.setTimeout(async () => {
			try{
				setSearchResults(await workspaceSearch(query));
			}catch(error){
				updateStatus("Search error: " + String(error), "error", "search");
			}finally{
				setSearching(false);
			}
		}, 150);
	});

	const currentSettings = (): DesktopSettings => ({
		explorerWidth: explorerWidth(),
		editorRatio: editorRatio(),
		explorerVisible: explorerVisible(),
		rightPaneVisible: rightPaneVisible(),
		lastWorkspace: workspace()?.root ?? null,
		recentWorkspaces: recentWorkspaces(),
		lastDocument: document()?.relativePath ?? null,
		openDocuments: openDocuments(),
		documentAutoSaveEnabled: documentAutoSaveEnabled(),
		documentAutoSaveDelayMs: documentAutoSaveDelayMs(),
		autoSnapshotEnabled: autoSnapshotEnabled(),
		autoSnapshotDelaySeconds: autoSnapshotDelaySeconds(),
		historyRetentionSnapshots: historyRetentionSnapshots(),
		templateDirectory: templateDirectory(),
		layoutPresets: layoutPresets(),
		macros: macros(),
		sidebarCommands: sidebarCommands(),
		dockOrder: dockOrder(),
		dockDirection: dockDirection(),
		dockTree: dockTree(),
		dailyNotesDirectory: dailyNotesDirectory(),
		dailyNoteTemplate: dailyNoteTemplate(),
		lastRightPane: rightPaneMode(),
		lastBrowserUrl: browserTargetUrl() ?? null,
	});

	const persistSettings = async () => {
		if(!settingsReady()){ return; }
		try{
			await settingsSave(currentSettings());
		}catch(error){
			updateStatus("Settings save error: " + String(error), "error", "settings");
		}
	};

	const scheduleSettingsSave = () => {
		if(!settingsReady()){ return; }
		if(settingsTimer !== undefined){ window.clearTimeout(settingsTimer); }
		settingsTimer = window.setTimeout(() => {
			settingsTimer = undefined;
			void persistSettings();
		}, 200);
	};

	onMount(() => {
		void settingsLoad()
			.then(async settings => {
				setExplorerWidth(Math.max(180, Math.min(420, settings.explorerWidth)));
				setEditorRatio(Math.max(0.25, Math.min(0.75, settings.editorRatio)));
				setExplorerVisible(settings.explorerVisible);
				setRightPaneVisible(settings.rightPaneVisible);
				setRecentWorkspaces(settings.recentWorkspaces ?? []);
				setDocumentAutoSaveEnabled(settings.documentAutoSaveEnabled);
				setDocumentAutoSaveDelayMs(Math.max(250, Math.min(10000, settings.documentAutoSaveDelayMs)));
				setAutoSnapshotEnabled(settings.autoSnapshotEnabled);
				setAutoSnapshotDelaySeconds(Math.max(1, Math.min(300, settings.autoSnapshotDelaySeconds)));
				setHistoryRetentionSnapshots(Math.max(10, Math.min(10000, settings.historyRetentionSnapshots)));
				setTemplateDirectory(settings.templateDirectory?.trim() || "Templates");
				setLayoutPresets(settings.layoutPresets ?? []);
				setDockOrder(() => {
					const saved = settings.dockOrder ?? [];
					return saved.length === 3 && new Set(saved).size === 3 && saved.every(value => ["explorer", "editor", "right"].includes(value))
						? saved as DockPanel[] : ["explorer", "editor", "right"];
				});
				setDockDirection(settings.dockDirection === "column" ? "column" : "row");
				setDockTree(normalizeDockTree(settings.dockTree));
				setMacros(settings.macros ?? []);
				setSidebarCommands(settings.sidebarCommands ?? ["workspace.quickOpen", "document.daily.open", "pane.preview", "pane.browser", "pane.graph", "history.show"]);
				setDailyNotesDirectory(settings.dailyNotesDirectory?.trim() || "Daily");
				setDailyNoteTemplate(settings.dailyNoteTemplate?.trim() ?? "");
				setRightPaneMode(settings.lastRightPane === "browser" ? "browser" : settings.lastRightPane === "graph" ? "graph" : "preview");
				if(settings.lastBrowserUrl && /^https?:\/\//i.test(settings.lastBrowserUrl)){
					setBrowserTargetUrl(settings.lastBrowserUrl);
				}
				if(settings.lastWorkspace){
					try{
						const opened = await workspaceOpen(settings.lastWorkspace);
						setWorkspace(opened.info);
						setEntries(opened.entries);
						setOpenDocuments([...(settings.openDocuments ?? [])]);
						setSearchIndexReady(false);
						void rebuildSearchIndex("session restore");
						assetCache.clear();
						setExternalConflict(false);
						void startWorkspaceWatcher();
						if(settings.lastDocument){
							try{
								const restored = await documentOpen(settings.lastDocument);
								setDocument(restored);
								addOpenDocument(restored.relativePath);
								setDocumentNavigation([restored.relativePath]);
								setDocumentNavigationIndex(0);
								setDraft(contentForEditor(restored.content));
								setInitialEditorLine(undefined);
								void refreshBacklinks(restored.relativePath);
								try{
									const recovery = await recoveryLoad();
									if(recovery && recovery.relativePath === restored.relativePath && recovery.content !== contentForEditor(restored.content)){
										setRecoveryDraft(recovery);
									}
								}catch(error){
									updateStatus("Recovery load error: " + String(error), "error", "recovery");
								}
								updateStatus("Session restored: " + restored.relativePath, "info", "session");
							}catch(error){
								setDocument(null);
								setDraft("");
								updateStatus("Last Document could not be restored: " + String(error), "warn", "session");
							}
						}else{
							updateStatus("Workspace restored: " + opened.info.name, "info", "session");
						}
					}catch(error){
						setWorkspace(null);
						setEntries([]);
						updateStatus("Last Workspace could not be restored: " + String(error), "warn", "session");
					}
				}
				setRecoveryTrackingReady(true);
				setSettingsReady(true);
				const savedFloatingPanes = (settings.floatingPanes ?? []).filter((kind): kind is FloatingPaneKind =>
					["explorer", "editor", "preview", "browser", "graph"].includes(kind),
				);
				requestAnimationFrame(() => {
					for(const kind of savedFloatingPanes){ void detachPane(kind); }
				});
			})
			.catch(error => {
				setRecoveryTrackingReady(true);
				setSettingsReady(true);
				updateStatus("Settings load error: " + String(error), "error", "settings");
			});

		commandKeyHandler = (event: KeyboardEvent) => {
			const key = event.key.toLowerCase();
			let commandId: string | undefined;
			if(event.altKey && !event.ctrlKey && !event.shiftKey){
				if(key === "arrowleft"){ commandId = "document.navigation.back"; }
				if(key === "arrowright"){ commandId = "document.navigation.forward"; }
			}else if(event.ctrlKey && !event.altKey){
				if(key === "tab"){ commandId = event.shiftKey ? "tabs.previous" : "tabs.next"; }
				else if(event.shiftKey && key === "p"){ commandId = "commands.show"; }
				else if(!event.shiftKey && key === "p"){ commandId = "workspace.quickOpen"; }
				else if(event.shiftKey && key === "e"){ commandId = "layout.focus.toggle"; }
				else if(event.shiftKey && key === "f"){ commandId = "workspace.search.focus"; }
				else if(!event.shiftKey && key === "o"){ commandId = "workspace.open"; }
				else if(event.shiftKey && key === "d"){ commandId = "document.daily.open"; }
				else if(event.shiftKey && key === "n"){ commandId = "document.create.template"; }
				else if(!event.shiftKey && key === "n"){ commandId = "document.create"; }
				else if(!event.shiftKey && key === ","){ commandId = "settings.show"; }
			}
			if(!commandId){ return; }
			event.preventDefault();
			void invokeCommand(commandId);
		};
		window.addEventListener("keydown", commandKeyHandler);
		const listenFloating = <T,>(name: string, callback: (payload: T) => void) => {
			void listen<T>(name, event => callback(event.payload), { target: { kind: "Any" } })
				.then(unlisten => floatingUnlisteners.push(unlisten))
				.catch(error => updateStatus("Pane listener error: " + String(error), "error", "layout"));
		};
		listenFloating<{ kind: FloatingPaneKind; label: string }>("quire:pane-ready", payload => {
			if(floatingPanels()[payload.kind] === payload.label){
				void emitTo(payload.label, "quire:pane-state", floatingPaneState());
			}
		});
		listenFloating<{ kind: FloatingPaneKind; label: string }>("quire:pane-dock", payload => {
			const floating = floatingHandles.get(payload.kind);
			if(!floating || floatingPanels()[payload.kind] !== payload.label){ return; }
			void (async () => {
				if(payload.kind === "editor"){
					const saved = await saveDocument(true);
					if(!saved){ updateStatus("Editorを戻す前に保存エラーを解決してください。", "warn", "layout"); return; }
					approvedFloatingClose.add(payload.label);
				}
				await floating.close();
			})().catch(error => updateStatus("Dock error: " + String(error), "error", "layout"));
		});
		listenFloating<string>("quire:pane-open-document", path => {
			if(workspace()){ void openDocument(path); }
		});
		listenFloating<{ path: string; content: string }>("quire:pane-editor-change", payload => {
			if(document()?.relativePath === payload.path){ setDraft(payload.content); }
		});
		listenFloating<string>("quire:pane-editor-save", path => {
			if(document()?.relativePath === path){ void saveDocument(); }
		});
		listenFloating<number>("quire:pane-editor-scroll", line => handleEditorViewportLine(line));
		listenFloating<string>("quire:pane-browser-url", url => {
			if(url.startsWith("https://") || url.startsWith("http://")){ setBrowserTargetUrl(url); }
		});

		void getCurrentWindow().onDragDropEvent(event => {
			const payload = event.payload;
			if(payload.type === "enter"){
				setDraggingImageFiles(payload.paths.some(isImageFilePath));
				return;
			}
			if(payload.type === "leave"){
				setDraggingImageFiles(false);
				return;
			}
			if(payload.type === "drop"){
				setDraggingImageFiles(false);
				const imagePaths = payload.paths.filter(isImageFilePath);
				if(imagePaths.length > 0){
					void importImageAssets(imagePaths);
				}else if(payload.paths.length > 0){
					updateStatus("画像以外のdropはまだ未対応です。", "warn", "asset");
				}
			}
		}).then(unlisten => {
			dragDropUnlisten = unlisten;
		}).catch(error => {
			updateStatus("Drag & drop handler error: " + String(error), "error", "asset");
		});

		void getCurrentWindow().onCloseRequested(event => {
			if(!dirty()){ return; }
			if(!window.confirm("未保存の変更があります。終了しますか？未保存bufferは次回起動時の復元候補として保持されます。")){
				event.preventDefault();
			}
		}).then(unlisten => {
			closeUnlisten = unlisten;
		}).catch(error => {
			updateStatus("Window close handler error: " + String(error), "error", "window");
		});
	});

	onCleanup(() => {
		closeUnlisten?.();
		for(const unlisten of floatingUnlisteners){ unlisten(); }
		for(const floating of floatingHandles.values()){ void floating.close(); }
		dragDropUnlisten?.();
		if(commandKeyHandler){ window.removeEventListener("keydown", commandKeyHandler); }
		++watchGeneration;
		pendingWatchChanges = [];
		if(reconcileTimer !== undefined){ window.clearTimeout(reconcileTimer); }
		if(searchTimer !== undefined){ window.clearTimeout(searchTimer); }
		if(settingsTimer !== undefined){ window.clearTimeout(settingsTimer); }
		if(autoSnapshotTimer !== undefined){ window.clearTimeout(autoSnapshotTimer); }
		if(documentAutoSaveTimer !== undefined){ window.clearTimeout(documentAutoSaveTimer); }
		if(recoveryTimer !== undefined){ window.clearTimeout(recoveryTimer); }
		if(dockMountFrame !== undefined){ cancelAnimationFrame(dockMountFrame); }
		void workspaceWatchStop();
	});

	const previewAnchors = () => {
		const previewRect = previewElement.getBoundingClientRect();
		return Array.from(previewElement.querySelectorAll<HTMLElement>("[data-source-line]"))
			.map(element => ({
				line: Number.parseInt(element.dataset.sourceLine ?? "0", 10),
				top: element.getBoundingClientRect().top - previewRect.top + previewElement.scrollTop,
			}))
			.filter(anchor => Number.isFinite(anchor.line))
			.sort((left, right) => left.line - right.line);
	};

	const previewTopForLine = (line: number) => {
		const anchors = previewAnchors();
		if(anchors.length === 0){ return 0; }
		if(line <= anchors[0].line){ return anchors[0].top; }

		for(let index = 0; index + 1 < anchors.length; ++index){
			const current = anchors[index];
			const next = anchors[index + 1];
			if(line <= next.line){
				const lineSpan = Math.max(1, next.line - current.line);
				const ratio = Math.max(0, Math.min(1, (line - current.line) / lineSpan));
				return current.top + (next.top - current.top) * ratio;
			}
		}
		return anchors[anchors.length - 1].top;
	};

	const sourceLineForPreviewTop = (top: number) => {
		const anchors = previewAnchors();
		if(anchors.length === 0){ return 0; }
		if(top <= anchors[0].top){ return anchors[0].line; }

		for(let index = 0; index + 1 < anchors.length; ++index){
			const current = anchors[index];
			const next = anchors[index + 1];
			if(top <= next.top){
				const heightSpan = Math.max(1, next.top - current.top);
				const ratio = Math.max(0, Math.min(1, (top - current.top) / heightSpan));
				return current.line + (next.line - current.line) * ratio;
			}
		}
		return anchors[anchors.length - 1].line;
	};

	const handleEditorViewportLine = (line: number) => {
		if(suppressEditorViewport || !previewElement){ return; }
		suppressPreviewScroll = true;
		previewElement.scrollTop = previewTopForLine(line);
		requestAnimationFrame(() => { suppressPreviewScroll = false; });
	};

	const handlePreviewScroll = () => {
		if(suppressPreviewScroll || !document()){ return; }
		const line = Math.max(0, Math.floor(sourceLineForPreviewTop(previewElement.scrollTop)));
		suppressEditorViewport = true;
		void editorSetTopLine(line)
			.catch(error => updateStatus("Editor viewport error: " + String(error), "error", "editor"))
			.finally(() => requestAnimationFrame(() => { suppressEditorViewport = false; }));
	};

	createEffect(() => {
		const root = dockTree();
		const activeWorkspace = workspace();
		const floating = floatingPanels();
		const visible = new Set<DockPanel>(["editor"]);
		if(explorerVisible() && !floating.explorer){ visible.add("explorer"); }
		if(rightPaneVisible()){ visible.add("right"); }
		if(dockMountFrame !== undefined){ cancelAnimationFrame(dockMountFrame); }
		if(!activeWorkspace){ return; }
		dockMountFrame = requestAnimationFrame(() => {
			dockMountFrame = undefined;
			if(workspaceElement?.isConnected){
				mountDockTree(workspaceElement, root, visible, (path, ratio) => setDockTree(current => updateDockSplit(current, path, ratio)));
			}
		});
	});

	const visibleDockPanels = () => dockOrder().filter(panel => panel !== "explorer" || (explorerVisible() && !floatingPanels().explorer)).filter(panel => panel !== "right" || rightPaneVisible());
	const dockIndex = (panel: DockPanel) => visibleDockPanels().indexOf(panel);
	const dockTracks = () => {
		const both = visibleDockPanels().includes("editor") && visibleDockPanels().includes("right");
		return visibleDockPanels().map(panel => {
			if(panel === "explorer"){ return explorerWidth() + "px"; }
			if(!both){ return "minmax(0, 1fr)"; }
			return "minmax(0, " + (panel === "editor" ? editorRatio() : 1 - editorRatio()) + "fr)";
		}).join(" 4px ");
	};
	const beginDockResize = (event: PointerEvent, index: number) => {
		event.preventDefault();
		const panels = visibleDockPanels();
		if(index + 1 >= panels.length){ return; }
		const before = panels[index], after = panels[index + 1];
		const first = workspaceElement.querySelector<HTMLElement>('[data-dock-panel="' + before + '"]');
		const second = workspaceElement.querySelector<HTMLElement>('[data-dock-panel="' + after + '"]');
		if(!first || !second){ return; }
		const column = dockDirection() === "column";
		const start = column ? event.clientY : event.clientX;
		const firstSize = column ? first.getBoundingClientRect().height : first.getBoundingClientRect().width;
		const secondSize = column ? second.getBoundingClientRect().height : second.getBoundingClientRect().width;
		const startExplorer = explorerWidth(), initialRatio = editorRatio();
		const move = (next: PointerEvent) => {
			const delta = (column ? next.clientY : next.clientX) - start;
			if(before === "explorer" || after === "explorer"){
				setExplorerWidth(Math.max(180, Math.min(420, startExplorer + delta * (before === "explorer" ? 1 : -1))));
				return;
			}
			setEditorRatio(Math.max(0.15, Math.min(0.85, initialRatio + delta * (before === "editor" ? 1 : -1) / Math.max(1, firstSize + secondSize))));
		};
		const stop = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", stop);
			scheduleSettingsSave();
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", stop, { once: true });
	};
	const startDockMove = (event: PointerEvent, source: DockPanel) => {
		if(event.button !== 0){ return; }
		event.preventDefault();
		const handle = event.currentTarget as HTMLElement;
		handle.setPointerCapture(event.pointerId);
		const startX = event.clientX, startY = event.clientY;
		const move = (next: PointerEvent) => {
			if(Math.hypot(next.clientX - startX, next.clientY - startY) > 8){ setDraggingDock(source); }
		};
		const cleanup = () => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", finish);
			handle.removeEventListener("pointercancel", cancel);
			if(handle.hasPointerCapture(event.pointerId)){ handle.releasePointerCapture(event.pointerId); }
			setDraggingDock(null);
		};
		const cancel = () => cleanup();
		const finish = (next: PointerEvent) => {
			if(Math.hypot(next.clientX - startX, next.clientY - startY) <= 8){ cleanup(); return; }
			const target = window.document.elementFromPoint(next.clientX, next.clientY)?.closest<HTMLElement>("[data-dock-panel]");
			const destination = target?.dataset.dockPanel as DockPanel | undefined;
			cleanup();
			if(!destination || destination === source || !dockOrder().includes(destination)){ return; }
			const bounds = target!.getBoundingClientRect();
			const x = (next.clientX - bounds.left) / Math.max(1, bounds.width);
			const y = (next.clientY - bounds.top) / Math.max(1, bounds.height);
			const distances: Array<[DockEdge, number]> = [["left", x], ["right", 1 - x], ["top", y], ["bottom", 1 - y]];
			distances.sort((left, right) => left[1] - right[1]);
			setDockTree(root => moveDockPanel(root, source, destination, distances[0][0]));
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", finish);
		handle.addEventListener("pointercancel", cancel);
	};

	const chooseWorkspace = async (requestedPath?: string) => {
		const discardCurrent = dirty();
		if(discardCurrent && !window.confirm("未保存の変更があります。破棄して別のWorkspaceを開きますか？")){ return; }
		const selected = requestedPath ?? await open({
			directory: true,
			multiple: false,
			title: "Quire Workspaceを開く",
		});
		if(typeof selected !== "string"){ return; }
		if(discardCurrent){
			try{ await recoveryClear(); }catch(error){ updateStatus("Recovery clear error: " + String(error), "error", "recovery"); }
		}
		setRecoveryTrackingReady(false);
		if(recoveryTimer !== undefined){ window.clearTimeout(recoveryTimer); recoveryTimer = undefined; }
		try{
			const opened = await workspaceOpen(selected);
			setWorkspace(opened.info);
			setRecentWorkspaces(current => {
				const normalized = opened.info.root.toLocaleLowerCase();
				return [opened.info.root, ...current.filter(path => path.toLocaleLowerCase() !== normalized)].slice(0, 10);
			});
			setEntries(opened.entries);
			setOpenDocuments([]);
			setDocumentNavigation([]);
			setDocumentNavigationIndex(-1);
			setSearchIndexReady(false);
			void rebuildSearchIndex("workspace open");
			assetCache.clear();
			setExternalConflict(false);
			void startWorkspaceWatcher();
			setDocument(null);
			setDraft("");
			setRecoveryDraft(null);
			try{
				const recovery = await recoveryLoad();
				if(recovery){
					try{
						const recoveredDocument = await documentOpen(recovery.relativePath);
						setDocument(recoveredDocument);
						setDraft(contentForEditor(recoveredDocument.content));
						setInitialEditorLine(undefined);
						void refreshBacklinks(recoveredDocument.relativePath);
						if(recovery.content !== contentForEditor(recoveredDocument.content)){
							setRecoveryDraft(recovery);
						}else{
							await recoveryClear();
						}
					}catch(error){
						updateStatus("Recovery Document could not be opened: " + String(error), "warn", "recovery");
					}
				}
			}catch(error){
				updateStatus("Recovery load error: " + String(error), "error", "recovery");
			}
			updateStatus(opened.info.name + " を開きました", "info", "workspace");
		}catch(error){
			updateStatus("Workspace open error: " + String(error), "error", "workspace");
		}finally{
			setRecoveryTrackingReady(true);
		}
	};

	const loadDirectory = async (relativePath: string) => {
		return workspaceList(relativePath);
	};

	const isMarkdownPath = (path: string) => /\.md(?:own)?$/i.test(path);
	const isQuireIgnorePath = (path: string) => path.split("/").at(-1) === ".quireignore";

	const reconcileExternalChanges = async () => {
		const changes = pendingWatchChanges;
		pendingWatchChanges = [];
		if(changes.length === 0){ return; }

		const paths = Array.from(new Set(changes.flatMap(change => change.paths)));
		const structural = changes.some(change => change.change !== "modify")
			|| paths.some(isQuireIgnorePath);
		if(structural){
			await refreshExplorer();
			invalidateSearchIndex("file watcher structural change");
		}else{
			const markdownPaths = paths.filter(isMarkdownPath);
			for(const path of markdownPaths){
				await refreshOneDocumentIndex(path, "file watcher modify");
			}
		}
		if(paths.some(path => !isMarkdownPath(path))){
			assetCache.clear();
		}

		const current = document();
		if(!current || (!structural && !paths.includes(current.relativePath))){ return; }
		try{
			const disk = await documentOpen(current.relativePath);
			if(disk.revision === current.revision){
				setExternalConflict(false);
				return;
			}
			if(dirty()){
				setExternalConflict(true);
				updateStatus("外部変更を検出しました。未保存bufferは保持しています: " + current.relativePath, "warn", "watcher");
				return;
			}
			setDocument(disk);
			setDraft(contentForEditor(disk.content));
			setExternalConflict(false);
			setEditorSession(value => value + 1);
			assetCache.clear();
			updateStatus("外部変更を再読込しました: " + disk.relativePath, "info", "watcher");
		}catch(error){
			if(dirty()){
				setExternalConflict(true);
				updateStatus("外部変更を検出しました。未保存bufferは保持しています: " + String(error), "warn", "watcher");
			}else{
				setDocument(null);
				setDraft("");
				setExternalConflict(false);
				updateStatus("開いていたDocumentが外部で削除または移動されました。", "warn", "watcher");
			}
		}
	};

	const scheduleExternalReconcile = (change: { change: "create" | "modify" | "remove" | "other"; paths: string[] }) => {
		pendingWatchChanges.push(change);
		if(reconcileTimer !== undefined){ window.clearTimeout(reconcileTimer); }
		reconcileTimer = window.setTimeout(() => {
			reconcileTimer = undefined;
			void reconcileExternalChanges();
		}, 200);
	};

	const startWorkspaceWatcher = async () => {
		const generation = ++watchGeneration;
		const stream = new Channel<WorkspaceWatchMessage>();
		stream.onmessage = message => {
			if(generation !== watchGeneration){ return; }
			if(message.kind === "error"){
				updateStatus("Watcher error: " + message.message, "error", "watcher");
				return;
			}
			scheduleExternalReconcile({ change: message.change, paths: message.paths });
		};
		try{
			await workspaceWatch(stream);
			updateStatus("Workspace watcher started", "info", "watcher");
		}catch(error){
			updateStatus("Workspace watcher start error: " + String(error), "error", "watcher");
		}
	};

	const refreshExplorer = async () => {
		try{
			setEntries(await workspaceList(""));
		}catch(error){
			updateStatus("Explorer refresh error: " + String(error), "error", "explorer");
		}
	};

	const normalizeMarkdownPath = (value: string) => {
		const trimmed = value.trim().replace(/\\/g, "/");
		if(!trimmed){ return ""; }
		return /\.md(?:own)?$/i.test(trimmed) ? trimmed : trimmed + ".md";
	};

	const recordDocumentNavigation = (relativePath: string) => {
		setDocumentNavigation(paths => {
			const currentIndex = documentNavigationIndex();
			if(currentIndex >= 0 && paths[currentIndex] === relativePath){ return paths; }
			let next = [...paths.slice(0, currentIndex + 1), relativePath];
			if(next.length > 100){ next = next.slice(next.length - 100); }
			setDocumentNavigationIndex(next.length - 1);
			return next;
		});
	};

	const replaceDocumentNavigation = (from: string, to: string) => {
		setDocumentNavigation(paths => paths.map(path => path === from ? to : path));
	};

	const removeDocumentNavigation = (relativePath: string) => {
		setDocumentNavigation(paths => {
			const oldIndex = documentNavigationIndex();
			const before = paths.slice(0, Math.max(0, oldIndex)).filter(path => path !== relativePath).length;
			const next = paths.filter(path => path !== relativePath);
			setDocumentNavigationIndex(next.length === 0 ? -1 : Math.min(before, next.length - 1));
			return next;
		});
	};

	const addOpenDocument = (relativePath: string) => {
		setOpenDocuments(paths => paths.includes(relativePath) ? paths : [...paths, relativePath]);
	};

	const replaceOpenDocument = (from: string, to: string) => {
		setOpenDocuments(paths => {
			const next = paths.map(path => path === from ? to : path);
			return [...new Set(next)];
		});
	};

	const removeOpenDocument = (relativePath: string) => {
		setOpenDocuments(paths => paths.filter(path => path !== relativePath));
	};

	const documentTabLabel = (relativePath: string) => {
		const normalized = relativePath.replace(/\\/g, "/");
		return normalized.split("/").pop() || normalized;
	};

	const createFolder = async () => {
		if(!workspace()){ return; }
		const input = window.prompt("作成するfolderをWorkspaceからの相対pathで入力してください。", "新しいフォルダー");
		if(input === null){ return; }
		const relativePath = input.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		if(!relativePath){ return; }
		try{
			const created = await workspaceEnsureDirectory(relativePath);
			await refreshExplorer();
			updateStatus("folderを作成しました: " + created, "info", "workspace");
		}catch(error){
			updateStatus("Folder create error: " + String(error), "error", "workspace");
		}
	};

	const createDocument = async () => {
		if(!workspace()){ return; }
		if(!await prepareToLeaveDocument("未保存の変更があります。保存または破棄して新規Documentを作成しますか？")){ return; }
		const input = window.prompt("Workspaceからの相対pathを入力してください。", "新規.md");
		if(input === null){ return; }
		const relativePath = normalizeMarkdownPath(input);
		if(!relativePath){ return; }
		try{
			const created = await documentCreate(relativePath);
			await refreshExplorer();
			setDocument(created);
			addOpenDocument(created.relativePath);
			recordDocumentNavigation(created.relativePath);
			recordDocumentNavigation(created.relativePath);
			setDraft(contentForEditor(created.content));
			setExternalConflict(false);
			setBacklinks([]);
			invalidateSearchIndex("Document create");
			updateStatus(created.relativePath + " を作成しました", "info", "document");
		}catch(error){
			updateStatus("Document create error: " + String(error), "error", "document");
		}
	};

	const templateVariables = (targetPath: string) => {
		const now = new Date();
		const pad = (value: number) => String(value).padStart(2, "0");
		const title = documentTabLabel(targetPath).replace(/\.md(?:own)?$/i, "");
		return {
			date: now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()),
			time: pad(now.getHours()) + ":" + pad(now.getMinutes()),
			title,
		};
	};

	const expandTemplate = (content: string, targetPath: string) => {
		const variables = templateVariables(targetPath);
		return content
			.replace(/\{\{date\}\}/g, variables.date)
			.replace(/\{\{time\}\}/g, variables.time)
			.replace(/\{\{title\}\}/g, variables.title);
	};

	const openTemplatePicker = async () => {
		if(!workspace()){ return; }
		try{
			setTemplates(await workspaceTemplates(templateDirectory().trim() || "Templates"));
			setTemplatePickerOpen(true);
			setCommandPaletteOpen(false);
		}catch(error){
			updateStatus("Template list error: " + String(error), "error", "template");
		}
	};

	const createDocumentFromTemplate = async (templatePath: string) => {
		if(!await prepareToLeaveDocument("未保存の変更があります。保存または破棄してTemplateからDocumentを作成しますか？")){ return; }
		const input = window.prompt("作成先をWorkspaceからの相対pathで入力してください。", "新規.md");
		if(input === null){ return; }
		const relativePath = normalizeMarkdownPath(input);
		if(!relativePath){ return; }
		try{
			const template = await documentOpen(templatePath);
			const created = await documentCreateWithContent(relativePath, expandTemplate(template.content, relativePath));
			await refreshExplorer();
			setDocument(created);
			addOpenDocument(created.relativePath);
			recordDocumentNavigation(created.relativePath);
			setDraft(contentForEditor(created.content));
			setExternalConflict(false);
			setBacklinks([]);
			invalidateSearchIndex("Template Document create");
			updateStatus(templatePath + " から " + created.relativePath + " を作成しました", "info", "template");
		}catch(error){
			updateStatus("Template create error: " + String(error), "error", "template");
		}
	};

	const openDailyNote = async () => {
		if(!workspace()){ return; }
		if(!await prepareToLeaveDocument("未保存の変更があります。保存または破棄してDaily Noteを開きますか？")){ return; }
		const now = new Date();
		const pad = (value: number) => String(value).padStart(2, "0");
		const date = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
		const directory = dailyNotesDirectory().trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		const relativePath = (directory ? directory + "/" : "") + date + ".md";

		try{
			if(await documentExists(relativePath)){
				await openDocument(relativePath);
				return;
			}

			if(directory){ await workspaceEnsureDirectory(directory); }
			let content = "";
			const templatePath = dailyNoteTemplate().trim().replace(/\\/g, "/");
			if(templatePath){
				try{
					const template = await documentOpen(templatePath);
					content = expandTemplate(template.content, relativePath);
				}catch(error){
					updateStatus("Daily Note Templateを読めないため空のnoteを作成します: " + String(error), "warn", "template");
				}
			}
			const created = await documentCreateWithContent(relativePath, content);
			await refreshExplorer();
			setDocument(created);
			addOpenDocument(created.relativePath);
			recordDocumentNavigation(created.relativePath);
			setDraft(contentForEditor(created.content));
			setExternalConflict(false);
			setBacklinks([]);
			invalidateSearchIndex("Daily Note create");
			updateStatus("Daily Noteを作成しました: " + created.relativePath, "info", "daily-note");
		}catch(error){
			updateStatus("Daily Note error: " + String(error), "error", "daily-note");
		}
	};

	const moveCurrentDocument = async () => {
		const current = document();
		if(!current || dirty()){ 
			if(dirty()){ updateStatus("移動・名前変更の前に保存してください。", "warn", "document"); }
			return;
		}
		const input = window.prompt("移動先をWorkspaceからの相対pathで入力してください。", current.relativePath);
		if(input === null){ return; }
		const relativePath = normalizeMarkdownPath(input);
		if(!relativePath || relativePath === current.relativePath){ return; }
		try{
			if(!await createSafetySnapshot("Before move " + current.relativePath)){ return; }
			const moved = await documentMove(current.relativePath, relativePath, current.revision);
			assetCache.clear();
			await refreshExplorer();
			setDocument(moved.document);
			replaceOpenDocument(current.relativePath, moved.document.relativePath);
			replaceDocumentNavigation(current.relativePath, moved.document.relativePath);
			setDraft(contentForEditor(moved.document.content));
			setExternalConflict(false);
			void refreshBacklinks(moved.document.relativePath);
			invalidateSearchIndex("Document move");
			const linkMessage = moved.updatedLinks.length > 0 ? " / Link更新 " + moved.updatedLinks.length + "件" : "";
			updateStatus(current.relativePath + " → " + moved.document.relativePath + linkMessage, "info", "document");
		}catch(error){
			updateStatus("Document move error: " + String(error), "error", "document");
		}
	};

	const deleteCurrentDocument = async () => {
		const current = document();
		if(!current){ return; }
		if(dirty()){
			updateStatus("削除の前に保存するか変更を破棄してください。", "warn", "document");
			return;
		}
		if(!window.confirm(current.relativePath + " を削除しますか？\n削除前にSafety Snapshotを作成します。")){ return; }
		try{
			if(!await createSafetySnapshot("Before delete " + current.relativePath)){ return; }
			await documentDelete(current.relativePath, current.revision);
			removeOpenDocument(current.relativePath);
			removeDocumentNavigation(current.relativePath);
			setDocument(null);
			setDraft("");
			setExternalConflict(false);
			setBacklinks([]);
			assetCache.clear();
			await refreshExplorer();
			invalidateSearchIndex("Document delete");
			updateStatus(current.relativePath + " を削除しました", "info", "document");
		}catch(error){
			updateStatus("Document delete error: " + String(error), "error", "document");
		}
	};

	const prepareToLeaveDocument = async (prompt: string) => {
		if(!dirty()){ return true; }
		if(documentAutoSaveEnabled() && !externalConflict()){
			if(saving()){
				updateStatus("保存処理中です。完了後にもう一度操作してください。", "info", "save");
				return false;
			}
			await saveDocument();
			if(!dirty()){ return true; }
			updateStatus("Documentを保存できなかったため移動を中止しました。", "warn", "save");
			return false;
		}
		return window.confirm(prompt);
	};

	const openDocument = async (relativePath: string, line?: number, heading?: string, recordNavigation = true): Promise<boolean> => {
		const current = document();
		if(current?.relativePath === relativePath && heading){
			const headingLine = findFragmentLine(draft(), heading);
			if(headingLine !== undefined){
				try{
					await editorGotoLine(headingLine);
					updateStatus(relativePath + "#" + decodeHeadingFragment(heading), "info", "links");
				}catch(error){
					updateStatus("Heading navigation error: " + String(error), "error", "links");
				}
			}else{
				updateStatus("見出しが見つかりません: #" + decodeHeadingFragment(heading), "warn", "links");
			}
			return true;
		}
		if(!await prepareToLeaveDocument("未保存の変更があります。破棄して別の文書を開きますか？")){ return false; }
		try{
			const opened = await documentOpen(relativePath);
			const content = contentForEditor(opened.content);
			const targetLine = line ?? (heading ? findFragmentLine(content, heading) : undefined);
			setDocument(opened);
			addOpenDocument(opened.relativePath);
			if(recordNavigation){ recordDocumentNavigation(opened.relativePath); }
			setDraft(content);
			setExternalConflict(false);
			setInitialEditorLine(targetLine);
			if(targetLine !== undefined || document()?.relativePath === relativePath){
				setEditorSession(value => value + 1);
			}
			void refreshBacklinks(relativePath);
			if(heading && targetLine === undefined){
				updateStatus(relativePath + " を開きましたが見出しが見つかりません: #" + decodeHeadingFragment(heading), "warn", "links");
			}else{
				updateStatus(relativePath, "info", "document");
			}
			return true;
		}catch(error){
			updateStatus("Document open error: " + String(error), "error", "document");
			return false;
		}
	};

	const navigateDocumentHistory = async (delta: -1 | 1) => {
		const paths = documentNavigation();
		const targetIndex = documentNavigationIndex() + delta;
		if(targetIndex < 0 || targetIndex >= paths.length){ return; }
		const target = paths[targetIndex];
		if(await openDocument(target, undefined, undefined, false)){
			setDocumentNavigationIndex(targetIndex);
		}
	};

	const closeDocumentTab = async (relativePath: string) => {
		const paths = openDocuments();
		const index = paths.indexOf(relativePath);
		if(index < 0){ return; }

		const current = document();
		const closingCurrent = current?.relativePath === relativePath;
		if(closingCurrent && !await prepareToLeaveDocument("未保存の変更があります。このタブを閉じて変更を破棄しますか？")){
			return;
		}

		const remaining = paths.filter(path => path !== relativePath);
		setOpenDocuments(remaining);
		if(!closingCurrent){ return; }

		setDocument(null);
		setDraft("");
		setBacklinks([]);
		setExternalConflict(false);
		if(remaining.length === 0){ return; }

		const nextIndex = Math.min(index, remaining.length - 1);
		await openDocument(remaining[nextIndex]);
	};

	const openSearchHit = async (hit: SearchHit) => {
		await openDocument(hit.relativePath, hit.line);
	};

	const isImageFilePath = (path: string) => /\.(?:png|jpe?g|gif|webp|bmp|avif|svg|ico)$/i.test(path);

	const importImageAssets = async (paths: string[]) => {
		const current = document();
		if(!current){
			updateStatus("画像を追加するDocumentを開いてください。", "warn", "asset");
			return;
		}
		const imagePaths = paths.filter(isImageFilePath);
		if(imagePaths.length === 0){
			updateStatus("対応画像がありません。", "warn", "asset");
			return;
		}

		let importedCount = 0;
		let lastRelativePath = "";
		try{
			for(const path of imagePaths){
				const imported = await assetImport(current.relativePath, path);
				await editorInsertText((importedCount > 0 ? "\n" : "") + "![](" + imported.markdownSource + ")");
				++importedCount;
				lastRelativePath = imported.relativePath;
			}
			assetCache.clear();
			await refreshExplorer();
			updateStatus(
				importedCount === 1
					? "画像を追加しました: " + lastRelativePath
					: "画像を" + importedCount + "件追加しました。",
				"info",
				"asset",
			);
		}catch(error){
			if(importedCount > 0){
				assetCache.clear();
				await refreshExplorer();
				updateStatus(
					"画像を" + importedCount + "件追加した後に失敗しました: " + String(error),
					"warn",
					"asset",
				);
			}else{
				updateStatus("Asset import error: " + String(error), "error", "asset");
			}
		}
	};

	const addImageAsset = async () => {
		const selected = await open({
			multiple: true,
			directory: false,
			title: "Markdownへ追加する画像を選択",
			filters: [{
				name: "Images",
				extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "ico"],
			}],
		});
		if(typeof selected === "string"){
			await importImageAssets([selected]);
		}else if(Array.isArray(selected)){
			await importImageAssets(selected);
		}
	};

	const refreshBacklinks = async (relativePath: string) => {
		if(!/\.md(?:own)?$/i.test(relativePath)){
			setBacklinks([]);
			return;
		}
		try{
			setBacklinks(await documentBacklinks(relativePath));
		}catch(error){
			setBacklinks([]);
			updateStatus("Backlink error: " + String(error), "error", "links");
		}
	};

	const handlePreviewClick = async (event: MouseEvent) => {
		const targetElement = event.target as HTMLElement;
		const calloutTitle = targetElement.closest<HTMLElement>("blockquote.callout[data-callout-fold] > .callout-title");
		if(calloutTitle){
			event.preventDefault();
			calloutTitle.parentElement?.classList.toggle("callout-collapsed");
			return;
		}

		const task = targetElement.closest<HTMLInputElement>("input[data-quire-task-line]");
		if(task){
			if(task.disabled){ return; }
			const line = Number.parseInt(task.dataset.quireTaskLine ?? "", 10);
			if(!Number.isFinite(line)){
				task.checked = !task.checked;
				return;
			}
			try{
				await editorToggleTask(line, task.checked);
				updateStatus("Taskを更新しました", "info", "editor");
			}catch(error){
				task.checked = !task.checked;
				updateStatus("Task update error: " + String(error), "error", "editor");
			}
			return;
		}
		const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
		if(!anchor){ return; }
		const href = anchor.getAttribute("href") ?? "";
		if(!href){ return; }
		const current = document();
		if(!current){ return; }
		const sourceDocument = anchor.dataset.quireSourceDocument || current.relativePath;

		if(href.startsWith("quire-tag:")){
			event.preventDefault();
			const tag = decodeURIComponent(href.slice("quire-tag:".length));
			setSearchQuery("tag:" + tag);
			setExplorerMode("tags");
			explorerSearchInput?.focus();
			explorerSearchInput?.select();
			updateStatus("Tag検索: #" + tag, "info", "search");
			return;
		}

		if(href.startsWith("quire-wiki:")){
			event.preventDefault();
			const target = decodeURIComponent(href.slice("quire-wiki:".length));
			const heading = linkFragment(target);
			try{
				const resolved = await documentResolveWikiLink(sourceDocument, target);
				if(!resolved){
					updateStatus("未解決Wiki Link: [[" + target + "]]", "warn", "links");
					return;
				}
				await openDocument(resolved, undefined, heading);
			}catch(error){
				updateStatus("Wiki Link error: " + String(error), "error", "links");
			}
			return;
		}

		if(/^https?:\/\//i.test(href)){
			event.preventDefault();
			setBrowserTargetUrl(href);
			setRightPaneMode("browser");
			updateStatus("Browserへ開きました: " + href, "info", "browser");
			return;
		}

		if(href.startsWith("#")){
			event.preventDefault();
			await openDocument(sourceDocument, undefined, href.slice(1));
			return;
		}

		if(/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")){
			event.preventDefault();
			updateStatus("このlink schemeはまだ開けません: " + href, "warn", "links");
			return;
		}

		event.preventDefault();
		const heading = linkFragment(href);
		try{
			const resolved = await documentResolveMarkdownLink(sourceDocument, href);
			if(!resolved){
				updateStatus("Workspace内Markdownとして解決できません: " + href, "warn", "links");
				return;
			}
			await openDocument(resolved, undefined, heading);
		}catch(error){
			updateStatus("Markdown link error: " + String(error), "error", "links");
		}
	};

	const saveDocument = async (force = false): Promise<boolean> => {
		const current = document();
		if(!current || saving()){ return false; }
		if(!dirty() && !force){ return true; }
		if(externalConflict()){
			updateStatus("外部変更Conflict中のため保存しません。内容を確認してください。", "warn", "save");
			return false;
		}
		setSaving(true);
		try{
			const saved = await editorSave(current.revision);
			setDocument(saved);
			setDraft(contentForEditor(saved.content));
			setExternalConflict(false);
			setRecoveryDraft(null);
			void recoveryClear().catch(error => updateStatus("Recovery clear error: " + String(error), "error", "recovery"));
			void refreshOneDocumentIndex(saved.relativePath, "Document save");
			updateStatus(saved.relativePath + " を保存しました", "info", "save");
			scheduleAutoSnapshot(saved.relativePath);
			return true;
		}catch(error){
			updateStatus("Save error: " + String(error), "error", "save");
			return false;
		}finally{
			setSaving(false);
		}
	};

	const applyRecoveryDraft = async () => {
		const recovery = recoveryDraft();
		const current = document();
		if(!recovery || !current){ return; }
		try{
			await editorReplaceContent(recovery.content);
			setRecoveryDraft(null);
			updateStatus(
				recovery.baseRevision === current.revision
					? "前回の未保存bufferを復元しました。"
					: "前回の未保存bufferを復元しました。disk側も変更されているため、保存前に内容を確認してください。",
				recovery.baseRevision === current.revision ? "info" : "warn",
				"recovery",
			);
		}catch(error){
			updateStatus("Recovery apply error: " + String(error), "error", "recovery");
		}
	};

	const discardRecoveryDraft = async () => {
		try{
			await recoveryClear();
			setRecoveryDraft(null);
			updateStatus("前回の未保存bufferを破棄しました。", "info", "recovery");
		}catch(error){
			updateStatus("Recovery clear error: " + String(error), "error", "recovery");
		}
	};


	const runCommand = async (id: string) => {
		const command = commands().find(candidate => candidate.id === id);
		if(!command){ throw new Error("不明なコマンド: " + id); }
		if(command.enabled === false){ throw new Error("現在実行できないコマンド: " + id); }
		await command.run();
	};

	const invokeCommand = async (id: string) => {
		try{
			await runCommand(id);
		}catch(error){
			updateStatus("Command error: " + String(error), "error", "command");
		}
	};

	const runMacro = async (macro: MacroDefinition) => {
		if(macroRunning()){ throw new Error("別のマクロを実行中です。"); }
		if(macro.steps.length === 0 || macro.steps.length > 100){ throw new Error("マクロのステップ数が不正です。"); }
		setMacroRunning(true);
		try{
			for(const id of macro.steps){
				if(id.startsWith("macro.")){ throw new Error("再帰マクロは禁止です: " + id); }
				await runCommand(id);
			}
			updateStatus("マクロ完了: " + macro.name, "info", "macro");
		}finally{
			setMacroRunning(false);
		}
	};

	const editMacro = (existing?: MacroDefinition) => {
		const nameInput = window.prompt("マクロ名を入力してください。", existing?.name ?? "新しいマクロ");
		if(nameInput === null){ return; }
		const name = nameInput.trim();
		if(!name || name.length > 80 || name.includes(".")){ updateStatus("マクロ名が不正です。", "warn", "macro"); return; }
		const idsInput = window.prompt("実行するコマンドIDを順番に入力してください（改行またはカンマ区切り）。コマンド一覧でIDを確認できます。", existing?.steps.join("\n") ?? "document.save\nworkspace.snapshot");
		if(idsInput === null){ return; }
		const steps = idsInput.split(/[\n,]+/).map(value => value.trim()).filter(Boolean);
		if(steps.length === 0 || steps.length > 100 || steps.some(id => id.startsWith("macro.") || !commands().some(command => command.id === id))){
			updateStatus("マクロには存在する通常コマンドIDを1〜100個指定してください。", "warn", "macro");
			return;
		}
		setMacros(current => {
			const filtered = current.filter(value => value.name !== existing?.name && value.name !== name);
			return [...filtered, { name, steps }];
		});
		if(existing && existing.name !== name){
			setSidebarCommands(current => current.map(value => value === "macro." + existing.name ? "macro." + name : value));
		}
		updateStatus("マクロを保存しました: " + name, "info", "macro");
	};


	const floatingPaneState = (): FloatingPaneState => ({
		workspaceName: workspace()?.name ?? null,
		documentPath: document()?.relativePath ?? null,
		previewHtml: preview(),
		graph: linkGraph(),
		entries: entries(),
		browserUrl: browserTargetUrl(),
	});
	const restoreFloatingPane = (kind: FloatingPaneKind, label: string) => {
		if(floatingPanels()[kind] !== label){ return; }
		setFloatingPanels(current => {
			const next = { ...current };
			delete next[kind];
			return next;
		});
		floatingHandles.delete(kind);
		if(kind === "explorer"){ setExplorerVisible(true); }
		else if(kind !== "editor"){ setRightPaneVisible(true); setRightPaneMode(kind); }
	};
	const detachPane = async (kind: FloatingPaneKind) => {
		if(kind === "editor" && dirty()){
			await saveDocument();
			if(dirty()){ updateStatus("Editorを分離する前に未保存内容を解決してください。", "warn", "layout"); return; }
		}
		const existing = floatingHandles.get(kind);
		if(existing){ void existing.setFocus(); return; }
		if(!workspace() && kind !== "browser"){ return; }
		const label = "floating-" + kind + "-" + Date.now().toString(36);
		const floating = new WebviewWindow(label, {
			url: "index.html?pane=" + kind,
			title: "Quire — " + kind,
			width: kind === "explorer" ? 420 : 900,
			height: 650,
			minWidth: 300,
			minHeight: 250,
		});
		floatingHandles.set(kind, floating);
		floating.once("tauri://created", () => {
			setFloatingPanels(current => ({ ...current, [kind]: label }));
		});
		floating.once("tauri://error", event => {
			floatingHandles.delete(kind);
			updateStatus("別ウィンドウの作成に失敗しました: " + String(event.payload), "error", "layout");
		});
		void floating.onCloseRequested(event => {
			if(kind === "editor" && !approvedFloatingClose.has(label)){
				event.preventDefault();
				if(!saving()){
					void saveDocument(true).then(saved => {
						if(saved){
							approvedFloatingClose.add(label);
							void floating.close();
						}
					});
				}
				return;
			}
			approvedFloatingClose.delete(label);
			restoreFloatingPane(kind, label);
		})
			.catch(error => updateStatus("Floating window close handler: " + String(error), "error", "layout"));
	};
	createEffect(() => {
		const data = floatingPaneState();
		for(const label of Object.values(floatingPanels())){
			if(label){ void emitTo(label, "quire:pane-state", data).catch(error => updateStatus("Pane sync error: " + String(error), "error", "layout")); }
		}
	});

	const commandSymbol = (id: string) => {
		if(id.startsWith("macro.")){ return "▶"; }
		if(id.includes("search") || id.includes("quickOpen")){ return "⌕"; }
		if(id.includes("daily")){ return "日"; }
		if(id.includes("preview")){ return "◫"; }
		if(id.includes("browser")){ return "◎"; }
		if(id.includes("graph")){ return "◇"; }
		if(id.includes("history") || id.includes("snapshot")){ return "↶"; }
		if(id.includes("settings")){ return "⚙"; }
		if(id.includes("folder")){ return "▣"; }
		if(id.includes("create")){ return "＋"; }
		return "•";
	};

	const commands = (): AppCommand[] => [
		{
			id: "commands.show",
			title: "コマンドパレットを開く",
			keywords: "command palette action list",
			shortcut: "Ctrl+Shift+P",
			run: () => { setQuickOpenVisible(false); setCommandPaletteOpen(true); },
		},
		{
			id: "workspace.open",
			title: "Workspaceを開く",
			keywords: "folder vault open",
			shortcut: "Ctrl+O",
			run: () => chooseWorkspace(),
		},
		{
			id: "workspace.folder.create",
			title: "新規folder",
			keywords: "folder directory create new",
			enabled: workspace() !== null,
			run: () => createFolder(),
		},
		...recentWorkspaces().map(path => ({
			id: "workspace.recent." + encodeURIComponent(path),
			title: "最近のWorkspace: " + path,
			keywords: "workspace recent switch folder",
			run: () => chooseWorkspace(path),
		} as AppCommand)),
		{
			id: "document.create",
			title: "新規Markdown",
			keywords: "new document note",
			shortcut: "Ctrl+N",
			enabled: workspace() !== null,
			run: () => createDocument(),
		},
		{
			id: "document.move",
			title: "Documentを移動・名前変更",
			enabled: document() !== null && !dirty(),
			run: () => moveCurrentDocument(),
		},
		{
			id: "document.delete",
			title: "Documentを削除",
			enabled: document() !== null && !dirty(),
			run: () => deleteCurrentDocument(),
		},
		{
			id: "workspace.explorer.refresh",
			title: "Explorerを再読込",
			enabled: workspace() !== null,
			run: () => refreshExplorer(),
		},
		{
			id: "document.image.add",
			title: "画像をDocumentへ追加",
			keywords: "asset image attachment insert",
			enabled: document() !== null,
			run: () => addImageAsset(),
		},
		{
			id: "document.save",
			title: "Documentを保存",
			keywords: "save write",
			shortcut: "Ctrl+S",
			enabled: document() !== null && dirty(),
			run: () => saveDocument(),
		},
		{
			id: "document.navigation.back",
			title: "前に開いたDocumentへ戻る",
			keywords: "navigation history back previous",
			shortcut: "Alt+Left",
			enabled: documentNavigationIndex() > 0,
			run: () => navigateDocumentHistory(-1),
		},
		{
			id: "document.navigation.forward",
			title: "次に開いたDocumentへ進む",
			keywords: "navigation history forward next",
			shortcut: "Alt+Right",
			enabled: documentNavigationIndex() >= 0 && documentNavigationIndex() < documentNavigation().length - 1,
			run: () => navigateDocumentHistory(1),
		},
		{
			id: "tabs.next",
			title: "次のDocumentタブ",
			keywords: "tab next document",
			shortcut: "Ctrl+Tab",
			enabled: openDocuments().length > 1,
			run: () => {
				const paths = openDocuments();
				const currentPath = document()?.relativePath;
				if(!currentPath || paths.length <= 1){ return; }
				const index = Math.max(0, paths.indexOf(currentPath));
				return openDocument(paths[(index + 1) % paths.length]);
			},
		},
		{
			id: "tabs.previous",
			title: "前のDocumentタブ",
			keywords: "tab previous document",
			shortcut: "Ctrl+Shift+Tab",
			enabled: openDocuments().length > 1,
			run: () => {
				const paths = openDocuments();
				const currentPath = document()?.relativePath;
				if(!currentPath || paths.length <= 1){ return; }
				const index = Math.max(0, paths.indexOf(currentPath));
				return openDocument(paths[(index - 1 + paths.length) % paths.length]);
			},
		},
		{
			id: "workspace.quickOpen",
			title: "Quick Open",
			keywords: "open switch document file markdown",
			shortcut: "Ctrl+P",
			enabled: workspace() !== null,
			run: () => openQuickOpen(),
		},
		{
			id: "document.daily.open",
			title: "今日のDaily Noteを開く",
			keywords: "daily note today journal",
			shortcut: "Ctrl+Shift+D",
			enabled: workspace() !== null,
			run: () => openDailyNote(),
		},
		{
			id: "document.create.template",
			title: "Templateから新規Document",
			keywords: "template new document note",
			shortcut: "Ctrl+Shift+N",
			enabled: workspace() !== null,
			run: () => openTemplatePicker(),
		},
		{
			id: "workspace.search.focus",
			title: "検索欄へ移動",
			keywords: "search find full text",
			shortcut: "Ctrl+Shift+F",
			enabled: workspace() !== null,
			run: () => {
				explorerSearchInput?.focus();
				explorerSearchInput?.select();
			},
		},
		{
			id: "workspace.snapshot",
			title: "Snapshotを作成",
			keywords: "history snapshot",
			enabled: workspace() !== null && !historyBusy(),
			run: () => createHistorySnapshot(),
		},
		{
			id: "history.toggle",
			title: historyOpen() ? "履歴を閉じる" : "履歴を開く",
			keywords: "history drawer toggle",
			run: () => toggleHistory(),
		},
		{
			id: "history.show",
			title: "履歴を表示",
			keywords: "history restore",
			enabled: workspace() !== null,
			run: () => {
				setHistoryOpen(true);
				void refreshHistory();
			},
		},
		{
			id: "layout.dock.reset",
			title: "Dock配置を初期化",
			run: () => { setDockOrder(["explorer", "editor", "right"]); setDockDirection("row"); setDockTree(defaultDockTree()); },
		},
		{
			id: "layout.dock.vertical",
			title: "Dockを縦方向に並べる",
			run: () => { setDockDirection("column"); setDockTree(root => setDockAxis(root, "column")); },
		},
		{
			id: "layout.dock.horizontal",
			title: "Dockを横方向に並べる",
			run: () => { setDockDirection("row"); setDockTree(root => setDockAxis(root, "row")); },
		},
		{
			id: "layout.reset",
			title: "ペインレイアウトを初期化",
			run: () => resetPaneLayout(),
		},
		{
			id: "layout.preset.save",
			title: "現在のlayoutを保存",
			keywords: "layout workspace preset save",
			run: () => saveLayoutPreset(),
		},
		...layoutPresets().map(preset => ({
			id: "layout.preset." + preset.name,
			title: "layoutを復元: " + preset.name,
			keywords: "layout workspace preset restore",
			run: () => applyLayoutPreset(preset),
		} as AppCommand)),
		{
			id: "layout.focus.toggle",
			title: focusMode() ? "Focus Modeを終了" : "Focus Mode",
			keywords: "layout focus distraction free editor",
			shortcut: "Ctrl+Shift+E",
			run: () => toggleFocusMode(),
		},
		{
			id: "layout.explorer.toggle",
			title: explorerVisible() ? "Explorerを隠す" : "Explorerを表示",
			keywords: "layout explorer sidebar toggle",
			run: () => setExplorerVisible(value => !value),
		},
		{
			id: "layout.right.toggle",
			title: rightPaneVisible() ? "右paneを隠す" : "右paneを表示",
			keywords: "layout preview browser graph pane toggle",
			run: () => setRightPaneVisible(value => !value),
		},
		...(["explorer", "editor", "preview", "browser", "graph"] as FloatingPaneKind[]).map(kind => ({
			id: "pane." + kind + ".detach",
			title: kind + "を別ウィンドウで開く",
			keywords: "float undock window detach",
			run: () => detachPane(kind),
		} as AppCommand)),
		{
			id: "pane.preview",
			title: "Preview paneを表示",
			keywords: "markdown preview pane",
			run: () => setRightPaneMode("preview"),
		},
		{
			id: "pane.graph",
			title: "Graph paneを表示",
			keywords: "graph links backlinks network",
			enabled: workspace() !== null,
			run: () => setRightPaneMode("graph"),
		},
		{
			id: "pane.browser",
			title: "Browser paneを表示",
			keywords: "web browser pane",
			run: () => setRightPaneMode("browser"),
		},
		{
			id: "settings.show",
			title: "設定を開く",
			keywords: "settings preferences",
			shortcut: "Ctrl+,",
			run: () => setSettingsOpen(true),
		},
		...macros().map(macro => ({
			id: "macro." + macro.name,
			title: "マクロ: " + macro.name,
			keywords: "macro automation マクロ 自動化",
			enabled: !macroRunning() && macro.steps.length > 0,
			run: () => runMacro(macro),
		} as AppCommand)),
		{
			id: "logs.show",
			title: "ログを表示",
			keywords: "diagnostic log",
			run: () => {
				setLogOpen(true);
				void refreshLogs();
			},
		},
	];

	return (
		<div class="app">
			<header class="toolbar">
				<button onClick={() => void invokeCommand("workspace.open")}>Workspaceを開く</button>
				<button title="設定" onClick={() => void invokeCommand("settings.show")}>設定</button>
				<Show when={workspace()}>
					<button title="前に開いたDocument (Alt+Left)" disabled={documentNavigationIndex() <= 0} onClick={() => void invokeCommand("document.navigation.back")}>←</button>
					<button title="次に開いたDocument (Alt+Right)" disabled={documentNavigationIndex() < 0 || documentNavigationIndex() >= documentNavigation().length - 1} onClick={() => void invokeCommand("document.navigation.forward")}>→</button>
				</Show>
				<Show when={workspace()}>{value => <span class="workspace-path">{value().root}</span>}</Show>
				<span class="toolbar-spacer" />
				<Show when={workspace()}>
					<button disabled={historyBusy()} onClick={() => void invokeCommand("workspace.snapshot")}>Snapshot</button>
					<button onClick={() => void invokeCommand("history.toggle")}>履歴</button>
				</Show>
				<Show when={workspace()}>
					<button title="Ctrl+Shift+E" classList={{ active: focusMode() }} onClick={() => void invokeCommand("layout.focus.toggle")}>Focus</button>
				</Show>
				<Show when={document()}>
					<button disabled={!dirty() || saving()} onClick={() => void invokeCommand("document.save")}>
						{saving() ? "保存中..." : dirty() ? "保存 *" : "保存"}
					</button>
				</Show>
			</header>
			<nav class="command-sidebar" aria-label="コマンドメニュー">
				<For each={sidebarCommands()}>
					{id => {
						const command = () => commands().find(item => item.id === id);
						return (
							<Show when={command()}>
								{item => (
									<button class="sidebar-command" title={item().title} aria-label={item().title} disabled={item().enabled === false} onClick={() => void invokeCommand(id)}>
										{commandSymbol(id)}
									</button>
								)}
							</Show>
						);
					}}
				</For>
				<span class="sidebar-spacer" />
				<button class="sidebar-command" title="コマンドパレット（Ctrl+Shift+P）" aria-label="コマンドパレット" onClick={() => setCommandPaletteOpen(true)}>⌘</button>
				<button class="sidebar-command" title="左メニューを編集" aria-label="左メニューを編集" onClick={() => setSettingsOpen(true)}>⚙</button>
			</nav>

			<Show
				when={workspace()}
				fallback={
					<main class="welcome">
						<h1>Quire</h1>
						<p>通常のフォルダを、そのままWorkspaceとして扱います。</p>
						<button class="primary" onClick={() => void invokeCommand("workspace.open")}>Workspaceを開く</button>
						<Show when={recentWorkspaces().length > 0}>
							<section class="recent-workspaces">
								<h2>Recent Workspaces</h2>
								<For each={recentWorkspaces()}>
									{path => <button title={path} onClick={() => void chooseWorkspace(path)}>{path}</button>}
								</For>
							</section>
						</Show>
					</main>
				}
			>
				<div
					ref={workspaceElement}
					class="workspace"
					classList={{ "dock-column": dockDirection() === "column", "dock-dragging": draggingDock() !== null }}
					style={{
						"grid-template-columns": dockDirection() === "row" ? dockTracks() : "minmax(0, 1fr)",
						"grid-template-rows": dockDirection() === "column" ? dockTracks() : "minmax(0, 1fr)",
					}}
				>
					<aside data-dock-panel="explorer" style={{ order: String(dockIndex("explorer") * 2) }} class="explorer" classList={{ hidden: !explorerVisible() || Boolean(floatingPanels().explorer) }}>
						<div class="pane-title explorer-title">
							<span class="dock-grip" title="ドラッグでドッキング位置を変更" onPointerDown={event => startDockMove(event as PointerEvent, "explorer")}>⠿</span>
							<button class="explorer-mode" classList={{ active: explorerMode() === "files" }} onClick={() => setExplorerMode("files")}>Files</button>
							<button class="explorer-mode" classList={{ active: explorerMode() === "tags" }} onClick={() => setExplorerMode("tags")}>Tags</button>
							<button class="explorer-mode" classList={{ active: explorerMode() === "outline" }} onClick={() => setExplorerMode("outline")}>Outline</button>
							<span class="toolbar-spacer" />
							<button class="pane-action" title="Explorerを別ウィンドウに分離" onClick={() => detachPane("explorer")}>↗</button>
							<button class="pane-action" title="新規Markdown" onClick={() => void invokeCommand("document.create")}>＋</button>
							<button class="pane-action" title="新規folder" onClick={() => void invokeCommand("workspace.folder.create")}>F＋</button>
							<button class="pane-action" title="Templateから新規" onClick={() => void invokeCommand("document.create.template")}>T＋</button>
							<button class="pane-action" title="再読込" onClick={() => void invokeCommand("workspace.explorer.refresh")}>↻</button>
						</div>
						<div class="explorer-search-row">
							<input
								ref={explorerSearchInput}
								class="explorer-search"
								type="search"
								value={searchQuery()}
								onInput={event => setSearchQuery(event.currentTarget.value)}
								placeholder='検索 / path:notes tag:project "完全な語句"'
							/>
						</div>
						<div class="tree explorer-body">
							<Show
								when={searchQuery().trim()}
								fallback={
									<Show
										when={explorerMode() === "files"}
										fallback={
											<Show
												when={explorerMode() === "tags"}
												fallback={
													<div class="outline-list">
														<For each={documentHeadings()}>
															{heading => (
																<button
																	class="outline-entry"
																	style={{ "--outline-level": String(heading.level) }}
																	title={"L" + heading.line + " " + heading.text}
																	onClick={() => void navigateOutline(heading)}
																>
																	<span>{heading.text}</span>
																	<small>L{heading.line}</small>
																</button>
															)}
														</For>
														<Show when={!document()}>
															<div class="search-state">Documentを開くと見出しを表示します</div>
														</Show>
														<Show when={document() && documentHeadings().length === 0}>
															<div class="search-state">見出しはありません</div>
														</Show>
													</div>
												}
											>
												<div class="tag-list">
													<For each={tags()}>
														{tag => (
															<button class="tag-entry" onClick={() => {
																setSearchQuery("tag:" + tag.name);
																explorerSearchInput?.focus();
															}}>
																<span>#{tag.name}</span>
																<small>{tag.count}</small>
															</button>
														)}
													</For>
													<Show when={searchIndexReady() && tags().length === 0}>
														<div class="search-state">タグはありません</div>
													</Show>
												</div>
											</Show>
										}
									>
										<For each={entries()}>
											{entry => <TreeEntry entry={entry} currentPath={document()?.relativePath} loadDirectory={loadDirectory} openDocument={openDocument} />}
										</For>
									</Show>
								}
							>
								<Show
									when={searchIndexReady()}
									fallback={
										<div class="search-state">
											{searchIndexBuilding() ? "検索indexを構築中..." : "検索indexを利用できません"}
										</div>
									}
								>
									<Show when={!searching()} fallback={<div class="search-state">検索中...</div>}>
										<For each={searchResults()}>
											{hit => (
												<button class="search-hit" onClick={() => void openSearchHit(hit)}>
													<span class="search-hit-path">
														{hit.relativePath}{hit.line ? ":" + hit.line : ""}
													</span>
													<span class="search-hit-preview">{hit.preview}</span>
												</button>
											)}
										</For>
										<Show when={searchResults().length === 0}>
											<div class="search-state">該当なし</div>
										</Show>
									</Show>
								</Show>
							</Show>
						</div>
					</aside>
					<div
						class="pane-splitter explorer-splitter"
						style={{ order: "1" }}
						classList={{ hidden: visibleDockPanels().length < 2 }}
						role="separator"
						aria-orientation={dockDirection() === "column" ? "horizontal" : "vertical"}
						onPointerDown={event => beginDockResize(event as PointerEvent, 0)}
					/>
					<section data-dock-panel="editor" style={{ order: String(dockIndex("editor") * 2) }} class="editor-pane" classList={{ "has-document-tabs": openDocuments().length > 0 }}>
						<div class="pane-title">
							<span class="dock-grip" title="ドラッグでドッキング位置を変更" onPointerDown={event => startDockMove(event as PointerEvent, "editor")}>⠿</span>
							<span class="pane-document-path">{document()?.relativePath ?? "Editor"}</span>
							<Show when={dirty()}><span class="dirty-mark">●</span></Show>
							<Show when={externalConflict()}><span class="external-conflict">外部変更</span></Show>
							<span class="toolbar-spacer" />
							<Show when={document()}>
								<button class="pane-action" title="Editorを別ウィンドウに分離" onClick={() => void detachPane("editor")}>↗</button>
								<button class="pane-action" title="画像を追加" onClick={() => void invokeCommand("document.image.add")}>画像</button>
								<button class="pane-action" title="移動・名前変更" disabled={dirty()} onClick={() => void invokeCommand("document.move")}>移動</button>
								<button class="pane-action danger" title="削除" disabled={dirty()} onClick={() => void invokeCommand("document.delete")}>削除</button>
							</Show>
						</div>
						<Show when={openDocuments().length > 0}>
							<div class="document-tabs">
								<For each={openDocuments()}>
									{path => (
										<div class="document-tab" classList={{ active: document()?.relativePath === path }}>
											<button class="document-tab-open" title={path} onClick={() => void openDocument(path)}>
												<span>{documentTabLabel(path)}</span>
												<Show when={document()?.relativePath === path && dirty()}><span class="dirty-mark">●</span></Show>
											</button>
											<button
												class="document-tab-close"
												title="タブを閉じる"
												onClick={event => {
													event.stopPropagation();
													void closeDocumentTab(path);
												}}
											>
												×
											</button>
										</div>
									)}
								</For>
							</div>
						</Show>
						<Show when={!floatingPanels().editor} fallback={<div class="empty-pane">Editorは別ウィンドウで開いています。</div>}>
						<For
							each={document() ? [{ relativePath: document()!.relativePath, session: editorSession() }] : []}
							fallback={<div class="empty-pane">左からファイルを選択してください。</div>}
						>
							{item => (
								<NeovimEditor
									relativePath={item.relativePath}
									initialLine={initialEditorLine()}
									onTextChange={setDraft}
									onViewportLineChange={handleEditorViewportLine}
									onStatus={message => updateStatus(message, message.toLowerCase().includes("error") || message.toLowerCase().includes("closed") ? "error" : "info", "editor")}
									onSave={() => void saveDocument()}
								/>
							)}
						</For></Show>
					</section>
					<div
						class="pane-splitter right-splitter"
						style={{ order: "3" }}
						classList={{ hidden: visibleDockPanels().length < 3 }}
						role="separator"
						aria-orientation={dockDirection() === "column" ? "horizontal" : "vertical"}
						onPointerDown={event => beginDockResize(event as PointerEvent, 1)}
					/>
					<section data-dock-panel="right" style={{ order: String(dockIndex("right") * 2) }} class="preview-pane" classList={{ hidden: !rightPaneVisible() }}>
						<div class="pane-title right-pane-title">
							<span class="dock-grip" title="ドラッグでドッキング位置を変更" onPointerDown={event => startDockMove(event as PointerEvent, "right")}>⠿</span>
							<button
								class="pane-tab"
								classList={{ active: rightPaneMode() === "preview" }}
								onClick={() => void invokeCommand("pane.preview")}
							>
								Preview
							</button>
							<button
								class="pane-tab"
								classList={{ active: rightPaneMode() === "browser" }}
								onClick={() => void invokeCommand("pane.browser")}
							>
								Browser
							</button>
							<button
								class="pane-tab"
								classList={{ active: rightPaneMode() === "graph" }}
								onClick={() => void invokeCommand("pane.graph")}
							>
								Graph
							</button>
							<span class="toolbar-spacer" />
							<button class="pane-action" title="現在のペインを別ウィンドウに分離" onClick={() => detachPane(rightPaneMode())}>↗</button>
						</div>
						<div class="right-pane-content">
							<div class="right-pane-layer" classList={{ hidden: rightPaneMode() !== "preview" }}>
								<Show
									when={document()}
									fallback={<div class="empty-pane">Preview</div>}
								>
									<div class="preview-scroll" ref={previewElement} onScroll={handlePreviewScroll}>
										<article
											class="markdown-preview"
											innerHTML={preview()}
											onClick={event => void handlePreviewClick(event as MouseEvent)}
										/>
										<Show when={backlinks().length > 0}>
											<section class="backlinks">
												<h3>Backlinks</h3>
												<For each={backlinks()}>
													{backlink => (
														<button class="backlink" onClick={() => void openDocument(backlink.sourcePath, backlink.line)}>
															<span>{backlink.sourcePath}:{backlink.line}</span>
															<small>{backlink.preview}</small>
														</button>
													)}
												</For>
											</section>
										</Show>
									</div>
								</Show>
							</div>
							<div class="right-pane-layer" classList={{ hidden: rightPaneMode() !== "graph" }}>
								<Show when={!floatingPanels().graph}><GraphPane
									graph={linkGraph()}
									currentPath={document()?.relativePath}
									onOpen={path => openDocument(path)}
								/></Show>
							</div>
							<div class="right-pane-layer" classList={{ hidden: rightPaneMode() !== "browser" }}>
								<Show when={!floatingPanels().browser}><BrowserPane
									active={rightPaneVisible() && rightPaneMode() === "browser" && !draggingDock() && !historyOpen() && !commandPaletteOpen() && !quickOpenVisible() && !templatePickerOpen() && !settingsOpen() && !logOpen() && !recoveryDraft() && !draggingImageFiles()}
									navigateTo={browserTargetUrl()}
									onUrlChange={url => setBrowserTargetUrl(url)}
									onStatus={message => updateStatus(message, message.toLowerCase().includes("error") ? "error" : "info", "browser")}
								/></Show>
							</div>
						</div>
					</section>
				</div>
			</Show>

			<Show when={draggingImageFiles() && document()}>
				<div class="file-drop-overlay">
					<div>
						<strong>画像を追加</strong>
						<span>Dropすると _assets/ へ取り込み、現在のカーソル位置へMarkdownを挿入します。</span>
					</div>
				</div>
			</Show>

			<Show when={recoveryDraft()}>
				{recovery => (
					<div class="recovery-backdrop">
						<div class="recovery-dialog">
							<h2>未保存bufferを検出しました</h2>
							<p>{recovery().relativePath}</p>
							<Show when={document() && recovery().baseRevision !== document()!.revision}>
								<div class="recovery-warning">前回終了後にdisk側Documentが変更されています。復元しても自動保存はしません。</div>
							</Show>
							<div class="recovery-preview">{recovery().content.slice(0, 600)}{recovery().content.length > 600 ? "…" : ""}</div>
							<div class="recovery-actions">
								<button onClick={() => void discardRecoveryDraft()}>破棄</button>
								<button class="primary" onClick={() => void applyRecoveryDraft()}>bufferを復元</button>
							</div>
						</div>
					</div>
				)}
			</Show>

			<Show when={settingsOpen()}>
				<div class="settings-backdrop" onMouseDown={event => {
					if(event.target === event.currentTarget){ setSettingsOpen(false); }
				}}>
					<div class="settings-panel">
						<div class="settings-header">
							<strong>Settings</strong>
							<span class="toolbar-spacer" />
							<button onClick={() => setSettingsOpen(false)}>閉じる</button>
						</div>
						<div class="settings-content">
							<section class="settings-section">
								<h3>Editor</h3>
								<label class="settings-toggle">
									<input
										type="checkbox"
										checked={documentAutoSaveEnabled()}
										onChange={event => setDocumentAutoSaveEnabled(event.currentTarget.checked)}
									/>
									<span>Documentを自動保存</span>
								</label>
								<label class="settings-field">
									<span>保存待ち時間（ms）</span>
									<input
										type="number"
										min="250"
										max="10000"
										step="250"
										value={documentAutoSaveDelayMs()}
										disabled={!documentAutoSaveEnabled()}
										onChange={event => {
											const value = Number.parseInt(event.currentTarget.value, 10);
											setDocumentAutoSaveDelayMs(Number.isFinite(value) ? Math.max(250, Math.min(10000, value)) : 1000);
										}}
									/>
								</label>
								<div class="settings-summary">外部変更Conflictを検出したDocumentは自動保存しません。</div>
							</section>
							<section class="settings-section">
								<h3>Daily Notes</h3>
								<label class="settings-field">
									<span>保存directory</span>
									<input type="text" value={dailyNotesDirectory()} onInput={event => setDailyNotesDirectory(event.currentTarget.value)} placeholder="Daily" />
								</label>
								<label class="settings-field">
									<span>Template</span>
									<input type="text" value={dailyNoteTemplate()} onInput={event => setDailyNoteTemplate(event.currentTarget.value)} placeholder="Templates/Daily.md" />
								</label>
								<div class="settings-summary">ファイル名は YYYY-MM-DD.md。Templateが存在しない場合は空のnoteを作成します。</div>
								<button disabled={!workspace()} onClick={() => void openDailyNote()}>今日のDaily Noteを開く</button>
							</section>
							<section class="settings-section">
								<h3>Templates</h3>
								<label class="settings-field">
									<span>Template directory</span>
									<input
										type="text"
										value={templateDirectory()}
										onInput={event => setTemplateDirectory(event.currentTarget.value)}
										placeholder="Templates"
									/>
								</label>
								<div class="settings-summary">通常のMarkdownをTemplateとして使用します。{"{{date}}"} / {"{{time}}"} / {"{{title}}"} を作成時に展開します。</div>
								<button disabled={!workspace()} onClick={() => void openTemplatePicker()}>Templateを選ぶ</button>
							</section>
							<section class="settings-section">
								<h3>History</h3>
								<label class="settings-toggle">
									<input
										type="checkbox"
										checked={autoSnapshotEnabled()}
										onChange={event => setAutoSnapshotEnabled(event.currentTarget.checked)}
									/>
									<span>保存後にAuto Snapshotを作成</span>
								</label>
								<label class="settings-field">
									<span>待ち時間（秒）</span>
									<input
										type="number"
										min="1"
										max="300"
										value={autoSnapshotDelaySeconds()}
										disabled={!autoSnapshotEnabled()}
										onChange={event => {
											const value = Number.parseInt(event.currentTarget.value, 10);
											setAutoSnapshotDelaySeconds(Number.isFinite(value) ? Math.max(1, Math.min(300, value)) : 5);
										}}
									/>
								</label>
								<label class="settings-field">
									<span>Snapshot保持件数</span>
									<input
										type="number"
										min="10"
										max="10000"
										value={historyRetentionSnapshots()}
										onChange={event => {
											const value = Number.parseInt(event.currentTarget.value, 10);
											setHistoryRetentionSnapshots(Number.isFinite(value) ? Math.max(10, Math.min(10000, value)) : 200);
										}}
									/>
								</label>
								<div class="settings-summary">上限を約20%超えた時に自動整理します。.quireignoreでHistory/index対象外を指定できます。</div>
								<button disabled={!workspace() || historyBusy()} onClick={() => void pruneHistoryNow()}>今すぐ保持上限を適用</button>
							</section>
							<section class="settings-section">
								<h3>Recent Workspaces</h3>
								<div class="recent-workspace-settings">
									<For each={recentWorkspaces()}>
										{path => (
											<div>
												<button title={path} onClick={() => void chooseWorkspace(path)}>{path}</button>
												<button class="danger" onClick={() => setRecentWorkspaces(current => current.filter(value => value !== path))}>削除</button>
											</div>
										)}
									</For>
									<Show when={recentWorkspaces().length === 0}><div class="settings-summary">履歴はありません。</div></Show>
								</div>
							</section>
							<section class="settings-section">
								<h3>マクロ</h3>
								<div class="settings-summary">既存のコマンドIDを順番に実行します。失敗または無効なコマンドがあれば中断します。任意のスクリプトは実行しません。</div>
								<button onClick={() => editMacro()}>マクロを追加</button>
								<div class="layout-preset-list">
									<For each={macros()}>
										{macro => (
											<div class="layout-preset-entry">
												<span title={macro.steps.join(" → ")}>{macro.name} ({macro.steps.length}手順)</span>
												<button onClick={() => editMacro(macro)}>編集</button>
												<button class="danger" onClick={() => {
													setMacros(current => current.filter(value => value.name !== macro.name));
													setSidebarCommands(current => current.filter(value => value !== "macro." + macro.name));
												}}>削除</button>
											</div>
										)}
									</For>
								</div>
								<details><summary>利用できるコマンドID</summary><div class="macro-command-list">
									<For each={commands().filter(command => !command.id.startsWith("macro."))}>
										{command => <div><code>{command.id}</code> — {command.title}</div>}
									</For>
								</div></details>
							</section>
							<section class="settings-section">
								<h3>左メニュー</h3>
								<div class="settings-summary">コマンドとマクロを追加・並べ替えできます。設定は次回起動時も保持されます。</div>
								<div class="sidebar-settings-list">
									<For each={sidebarCommands()}>
										{(id, index) => <div class="sidebar-settings-entry">
											<span>{commands().find(command => command.id === id)?.title ?? id}</span>
											<button disabled={index() === 0} onClick={() => setSidebarCommands(items => {
												const next = [...items];
												[next[index() - 1], next[index()]] = [next[index()], next[index() - 1]];
												return next;
											})}>↑</button>
											<button disabled={index() === sidebarCommands().length - 1} onClick={() => setSidebarCommands(items => {
												const next = [...items];
												[next[index() + 1], next[index()]] = [next[index()], next[index() + 1]];
												return next;
											})}>↓</button>
											<button onClick={() => setSidebarCommands(items => items.filter((_, at) => at !== index()))}>×</button>
										</div>}
									</For>
								</div>
								<select value="" onChange={event => {
									const id = event.currentTarget.value;
									if(id){ setSidebarCommands(current => current.includes(id) ? current : [...current, id]); }
									event.currentTarget.value = "";
								}}>
									<option value="">追加するコマンドを選択</option>
									<For each={commands().filter(command => !sidebarCommands().includes(command.id))}>
										{command => <option value={command.id}>{command.title}</option>}
									</For>
								</select>
							</section>
							<section class="settings-section">
								<h3>Layout</h3>
								<div class="layout-preset-actions">
									<button classList={{ active: dockDirection() === "row" }} onClick={() => { setDockDirection("row"); setDockTree(root => setDockAxis(root, "row")); }}>左右に並べる</button>
									<button classList={{ active: dockDirection() === "column" }} onClick={() => { setDockDirection("column"); setDockTree(root => setDockAxis(root, "column")); }}>上下に並べる</button>
									<button onClick={() => { setDockOrder(["explorer", "editor", "right"]); setDockDirection("row"); setDockTree(defaultDockTree()); }}>Dockを初期化</button>
								</div>
								<div class="settings-summary">ペイン見出しの⠿をドラッグすると配置を変更できます。領域上端・下端は上下、左右中央は横方向にドッキングします。</div>
								<label class="settings-toggle">
									<input type="checkbox" checked={explorerVisible()} onChange={event => setExplorerVisible(event.currentTarget.checked)} />
									<span>Explorerを表示</span>
								</label>
								<label class="settings-toggle">
									<input type="checkbox" checked={rightPaneVisible()} onChange={event => setRightPaneVisible(event.currentTarget.checked)} />
									<span>右paneを表示</span>
								</label>
								<div class="settings-summary">Explorer {Math.round(explorerWidth())}px / Editor {Math.round(editorRatio() * 100)}%</div>
								<div class="layout-preset-actions">
									<button onClick={saveLayoutPreset}>現在のlayoutを保存</button>
									<button onClick={resetPaneLayout}>pane layoutを初期値へ戻す</button>
								</div>
								<Show when={layoutPresets().length > 0}>
									<div class="layout-preset-list">
										<For each={layoutPresets()}>
											{preset => (
												<div class="layout-preset-entry">
													<span>{preset.name}</span>
													<button onClick={() => applyLayoutPreset(preset)}>復元</button>
													<button class="danger" onClick={() => deleteLayoutPreset(preset.name)}>削除</button>
												</div>
											)}
										</For>
									</div>
								</Show>
							</section>
						</div>
					</div>
				</div>
			</Show>

			<TemplatePicker
				open={templatePickerOpen()}
				templates={templates()}
				directory={templateDirectory().trim() || "Templates"}
				onChoose={path => createDocumentFromTemplate(path)}
				onClose={() => setTemplatePickerOpen(false)}
			/>

			<QuickOpen
				open={quickOpenVisible()}
				documents={quickOpenDocuments()}
				currentPath={document()?.relativePath}
				indexReady={searchIndexReady()}
				onOpen={path => openDocument(path)}
				onClose={() => setQuickOpenVisible(false)}
			/>

			<CommandPalette
				open={commandPaletteOpen()}
				commands={commands()}
				onClose={() => setCommandPaletteOpen(false)}
			/>

			<Show when={historyOpen()}>
				<div class="history-drawer">
					<div class="history-drawer-header">
						<strong>History</strong>
						<span>{snapshots().length} snapshots</span>
						<span class="toolbar-spacer" />
						<button disabled={historyBusy()} onClick={() => void createHistorySnapshot()}>Snapshot</button>
						<button disabled={historyBusy()} onClick={() => void refreshHistory()}>更新</button>
						<button onClick={() => setHistoryOpen(false)}>閉じる</button>
					</div>
					<div class="history-list">
						<Show when={!historyBusy()} fallback={<div class="history-empty">処理中...</div>}>
							<For each={snapshots()}>
								{snapshot => (
									<div class="history-entry">
										<div>
											<strong>{snapshot.message}</strong>
											<small>{new Date(snapshot.timestamp * 1000).toLocaleString()} · {snapshot.id.slice(0, 7)}</small>
										</div>
										<div class="history-entry-actions">
											<button onClick={() => void showHistoryDocuments(snapshot)}>文書</button>
											<button disabled={!document()} onClick={() => void compareHistorySnapshot(snapshot)}>比較</button>
											<button disabled={!document() || dirty()} onClick={() => void restoreCurrentDocument(snapshot)}>復元</button>
										</div>
									</div>
								)}
							</For>
							<Show when={snapshots().length === 0}>
								<div class="history-empty">Snapshotはありません。</div>
							</Show>
						</Show>
					</div>
					<Show when={historyDocuments()}>
						{view => (
							<div class="history-documents-panel">
								<div class="history-comparison-header">
									<strong>Snapshot Documents</strong>
									<span>{view().snapshot.message}</span>
									<span class="toolbar-spacer" />
									<button onClick={() => setHistoryDocuments(null)}>閉じる</button>
								</div>
								<div class="history-document-list">
									<For each={view().paths}>
										{path => (
											<div class="history-document-entry">
												<span title={path}>{path}</span>
												<button disabled={dirty() || historyBusy()} onClick={() => void restoreHistoryDocument(view().snapshot, path)}>復元</button>
											</div>
										)}
									</For>
									<Show when={view().paths.length === 0}>
										<div class="history-empty">Markdown Documentはありません。</div>
									</Show>
								</div>
							</div>
						)}
					</Show>
					<Show when={historyComparison()}>
						{comparison => (
							<div class="history-comparison">
								<div class="history-comparison-header">
									<strong>{document()?.relativePath}</strong>
									<span>{comparison().snapshot.message}</span>
									<span class="toolbar-spacer" />
									<button onClick={() => setHistoryComparison(null)}>比較を閉じる</button>
								</div>
								<div class="history-comparison-columns">
									<section>
										<h4>Snapshot</h4>
										<pre>{comparison().content ?? "このSnapshotにはDocumentが存在しません。"}</pre>
									</section>
									<section>
										<h4>Current</h4>
										<pre>{draft()}</pre>
									</section>
								</div>
							</div>
						)}
					</Show>
				</div>
			</Show>

			<Show when={logOpen()}>
				<div class="log-drawer">
					<div class="log-drawer-header">
						<strong>Recent logs</strong>
						<span>{logs().length} / 300</span>
						<span class="toolbar-spacer" />
						<button onClick={() => void refreshLogs()}>更新</button>
						<button onClick={() => void copyLogFilePath()} title="永続ログのフルパスをコピー">ログファイル</button>
						<button onClick={() => void clearLogs()} title="画面上のログだけを消去。ファイルは保持">表示をクリア</button>
						<button onClick={() => setLogOpen(false)}>閉じる</button>
					</div>
					<div class="log-list">
						<For each={logs()}>
							{entry => (
								<div class={"log-entry " + entry.level}>
									<time>{new Date(entry.timestampMs).toLocaleTimeString()}</time>
									<span class="log-source">{entry.source}</span>
									<span>{entry.message}</span>
								</div>
							)}
						</For>
						<Show when={logs().length === 0}>
							<div class="log-empty">ログはありません。</div>
						</Show>
					</div>
				</div>
			</Show>

			<footer class="statusbar statusbar-clickable" onClick={toggleLogs} title="クリックで直近ログを表示">
				<span>{status()}</span>
				<span class="toolbar-spacer" />
				<span>Milestone 3 / Vertical Slice</span>
			</footer>
		</div>
	);
}

function TreeEntry(props: {
	entry: WorkspaceEntry;
	currentPath?: string;
	loadDirectory: (relativePath: string) => Promise<WorkspaceEntry[]>;
	openDocument: (relativePath: string) => Promise<unknown>;
}) {
	const [expanded, setExpanded] = createSignal(false);
	const [children, setChildren] = createSignal<WorkspaceEntry[] | null>(null);

	createEffect(() => {
		const currentPath = props.currentPath;
		if(props.entry.kind !== "directory" || !currentPath){ return; }
		const prefix = props.entry.relativePath.replace(/\/$/, "") + "/";
		if(!currentPath.startsWith(prefix)){ return; }
		if(children() === null){
			void props.loadDirectory(props.entry.relativePath)
				.then(entries => {
					setChildren(entries);
					setExpanded(true);
				});
		}else{
			setExpanded(true);
		}
	});

	const activate = async () => {
		if(props.entry.kind === "directory"){
			if(!expanded() && children() === null){
				setChildren(await props.loadDirectory(props.entry.relativePath));
			}
			setExpanded(!expanded());
			return;
		}
		await props.openDocument(props.entry.relativePath);
	};

	return (
		<div>
			<button
				class={"tree-entry " + props.entry.kind}
				classList={{ active: props.entry.kind !== "directory" && props.entry.relativePath === props.currentPath }}
				onClick={() => void activate()}
				title={props.entry.relativePath}
			>
				<span class="tree-icon">
					{props.entry.kind === "directory" ? (expanded() ? "▾" : "▸") : props.entry.kind === "markdown" ? "◇" : "·"}
				</span>
				<span>{props.entry.name}{props.entry.kind === "directory" ? "/" : ""}</span>
			</button>
			<Show when={expanded() && children()}>
				<div class="tree-children">
					<For each={children() ?? []}>
						{entry => <TreeEntry entry={entry} currentPath={props.currentPath} loadDirectory={props.loadDirectory} openDocument={props.openDocument} />}
					</For>
				</div>
			</Show>
		</div>
	);
}

export default App;
