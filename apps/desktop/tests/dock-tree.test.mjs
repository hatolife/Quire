import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "src/layout/dock-tree.ts"), "utf8");
const compiled = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tree = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));

function ids(node) {
	if(node.type === "pane"){ return [node.id]; }
	return [...ids(node.first), ...ids(node.second)];
}

test("default split contains exactly one of each active panel", () => {
	const original = tree.defaultDockTree();
	assert.deepEqual(ids(original).sort(), ["editor", "explorer", "right"]);
	assert.equal(original.axis, "row");
});

test("malformed or duplicate layouts fall back without losing a panel", () => {
	const broken = { type: "split", axis: "row", ratio: NaN,
		first: { type: "pane", id: "editor" },
		second: { type: "pane", id: "editor" } };
	assert.deepEqual(ids(tree.normalizeDockTree(broken)).sort(), ["editor", "explorer", "right"]);
	assert.deepEqual(ids(tree.normalizeDockTree({ type: "pane", id: "../../escape" })).sort(), ["editor", "explorer", "right"]);
});

test("docking creates nested layouts, preserving all panels", () => {
	const original = tree.defaultDockTree();
	const moved = tree.moveDockPanel(original, "explorer", "right", "top");
	assert.deepEqual(ids(moved).sort(), ["editor", "explorer", "right"]);
	assert.equal(moved.second.axis, "column");
	assert.equal(moved.second.first.id, "explorer");
	assert.deepEqual(ids(original).sort(), ["editor", "explorer", "right"]);
});

test("same-panel docking makes no structural changes", () => {
	const original = tree.defaultDockTree();
	assert.equal(tree.moveDockPanel(original, "right", "right", "left"), original);
});

test("hiding a panel collapses only its surrounding split", () => {
	const visible = tree.filterDockTree(tree.defaultDockTree(), new Set(["editor", "right"]));
	assert.deepEqual(ids(visible).sort(), ["editor", "right"]);
	assert.equal(visible.axis, "row");
	assert.equal(tree.filterDockTree(tree.defaultDockTree(), new Set([])), null);
});

test("split ratios are bounded and invalid paths are ignored", () => {
	const original = tree.defaultDockTree();
	assert.equal(tree.updateDockSplit(original, "", 0).ratio, 0.12);
	assert.equal(tree.updateDockSplit(original, "1", 9).second.ratio, 0.88);
	assert.deepEqual(tree.updateDockSplit(original, "000", 0.1), original);
});

test("orientation applies recursively without changing the pane set", () => {
	const oriented = tree.setDockAxis(tree.defaultDockTree(), "column");
	assert.equal(oriented.axis, "column");
	assert.equal(oriented.second.axis, "column");
	assert.deepEqual(ids(oriented).sort(), ["editor", "explorer", "right"]);
});

test("a divider retains its original path when hidden panels collapse the root", () => {
	const original = tree.defaultDockTree();
	const visible = tree.visibleDockTree(original, new Set(["editor", "right"]));
	assert.equal(visible.type, "split");
	assert.equal(visible.sourcePath, "1");
	const resized = tree.updateDockSplit(original, visible.sourcePath, 0.3);
	assert.equal(resized.ratio, original.ratio);
	assert.equal(resized.second.ratio, 0.3);
});
