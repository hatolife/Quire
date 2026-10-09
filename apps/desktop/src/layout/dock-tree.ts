export type DockPanelId = "explorer" | "editor" | "right";
export type DockAxis = "row" | "column";
export type DockEdge = "left" | "right" | "top" | "bottom";
export type DockNode =
	| { type: "pane"; id: DockPanelId }
	| { type: "split"; axis: DockAxis; ratio: number; first: DockNode; second: DockNode };

const pane = (id: DockPanelId): DockNode => ({ type: "pane", id });
export const defaultDockTree = (): DockNode => ({
	type: "split", axis: "row", ratio: 0.23, first: pane("explorer"),
	second: { type: "split", axis: "row", ratio: 0.5, first: pane("editor"), second: pane("right") },
});

export function normalizeDockTree(value: unknown): DockNode {
	const walk = (node: unknown): DockNode | null => {
		if(!node || typeof node !== "object"){ return null; }
		const record = node as Record<string, unknown>;
		if(record.type === "pane" && (record.id === "explorer" || record.id === "editor" || record.id === "right")){
			return pane(record.id);
		}
		if(record.type !== "split" || (record.axis !== "row" && record.axis !== "column")){ return null; }
		const first = walk(record.first), second = walk(record.second);
		if(!first || !second){ return null; }
		const ratio = typeof record.ratio === "number" && Number.isFinite(record.ratio) ? Math.max(0.12, Math.min(0.88, record.ratio)) : 0.5;
		return { type: "split", axis: record.axis, ratio, first, second };
	};
	const result = walk(value);
	if(!result){ return defaultDockTree(); }
	const ids: string[] = [];
	const collect = (node: DockNode) => {
		if(node.type === "pane"){ ids.push(node.id); return; }
		collect(node.first); collect(node.second);
	};
	collect(result);
	return ids.length === 3 && new Set(ids).size === 3 ? result : defaultDockTree();
}

export function filterDockTree(tree: DockNode, visible: ReadonlySet<DockPanelId>): DockNode | null {
	if(tree.type === "pane"){ return visible.has(tree.id) ? tree : null; }
	const first = filterDockTree(tree.first, visible), second = filterDockTree(tree.second, visible);
	if(!first){ return second; }
	if(!second){ return first; }
	return { ...tree, first, second };
}

function removePanel(tree: DockNode, id: DockPanelId): DockNode | null {
	if(tree.type === "pane"){ return tree.id === id ? null : tree; }
	const first = removePanel(tree.first, id), second = removePanel(tree.second, id);
	if(!first){ return second; }
	if(!second){ return first; }
	return { ...tree, first, second };
}

function addAt(tree: DockNode, target: DockPanelId, source: DockPanelId, edge: DockEdge): DockNode {
	if(tree.type === "pane"){
		if(tree.id !== target){ return tree; }
		const axis: DockAxis = edge === "top" || edge === "bottom" ? "column" : "row";
		const incomingFirst = edge === "left" || edge === "top";
		return {
			type: "split", axis, ratio: 0.5,
			first: incomingFirst ? pane(source) : tree,
			second: incomingFirst ? tree : pane(source),
		};
	}
	return { ...tree, first: addAt(tree.first, target, source, edge), second: addAt(tree.second, target, source, edge) };
}

export function moveDockPanel(tree: DockNode, source: DockPanelId, target: DockPanelId, edge: DockEdge): DockNode {
	if(source === target){ return tree; }
	const remaining = removePanel(tree, source);
	if(!remaining){ return tree; }
	return normalizeDockTree(addAt(remaining, target, source, edge));
}

export function updateDockSplit(tree: DockNode, path: string, ratio: number): DockNode {
	if(path === ""){
		if(tree.type !== "split"){ return tree; }
		return { ...tree, ratio: Math.max(0.12, Math.min(0.88, ratio)) };
	}
	if(tree.type !== "split"){ return tree; }
	const head = path[0], tail = path.slice(1);
	if(head === "0"){ return { ...tree, first: updateDockSplit(tree.first, tail, ratio) }; }
	if(head === "1"){ return { ...tree, second: updateDockSplit(tree.second, tail, ratio) }; }
	return tree;
}

export function setDockAxis(tree: DockNode, axis: DockAxis): DockNode {
	if(tree.type === "pane"){ return tree; }
	return { ...tree, axis, first: setDockAxis(tree.first, axis), second: setDockAxis(tree.second, axis) };
}

export type VisibleDockNode =
	| { type: "pane"; id: DockPanelId }
	| { type: "split"; axis: DockAxis; ratio: number; sourcePath: string; first: VisibleDockNode; second: VisibleDockNode };

export function visibleDockTree(tree: DockNode, visible: ReadonlySet<DockPanelId>): VisibleDockNode | null {
	const project = (node: DockNode, path: string): VisibleDockNode | null => {
		if(node.type === "pane"){ return visible.has(node.id) ? { type: "pane", id: node.id } : null; }
		const first = project(node.first, path + "0"), second = project(node.second, path + "1");
		if(!first){ return second; }
		if(!second){ return first; }
		return { type: "split", axis: node.axis, ratio: node.ratio, sourcePath: path, first, second };
	};
	return project(tree, "");
}
