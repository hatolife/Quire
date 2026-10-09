import { visibleDockTree, type DockNode, type DockPanelId, type VisibleDockNode } from "./dock-tree";

export function mountDockTree(
	host: HTMLElement,
	layout: DockNode,
	visible: ReadonlySet<DockPanelId>,
	onResize: (path: string, ratio: number) => void,
): void {
	const panels = new Map<DockPanelId, HTMLElement>();
	for(const id of ["explorer", "editor", "right"] as const){
		const element = host.querySelector<HTMLElement>('[data-dock-panel="' + id + '"]');
		if(!element){ return; }
		panels.set(id, element);
	}
	const createNode = (node: VisibleDockNode): HTMLElement => {
		if(node.type === "pane"){
			const leaf = document.createElement("div");
			leaf.className = "quire-dock-leaf";
			leaf.dataset.paneId = node.id;
			const panel = panels.get(node.id);
			if(panel){ leaf.appendChild(panel); }
			return leaf;
		}
		const split = document.createElement("div");
		split.className = "quire-dock-split " + (node.axis === "row" ? "dock-row" : "dock-column");
		const first = createNode(node.first);
		const second = createNode(node.second);
		const separator = document.createElement("div");
		separator.className = "quire-dock-splitter";
		separator.setAttribute("role", "separator");
		separator.setAttribute("aria-orientation", node.axis === "row" ? "vertical" : "horizontal");
		first.style.flex = "0 0 calc(" + (node.ratio * 100) + "% - 2px)";
		second.style.flex = "1 1 0";
		separator.addEventListener("pointerdown", event => {
			if(event.button !== 0){ return; }
			event.preventDefault();
			const rect = split.getBoundingClientRect();
			const start = node.axis === "row" ? event.clientX : event.clientY;
			const size = node.axis === "row" ? rect.width : rect.height;
			const initial = node.ratio;
			let ratio = initial;
			const move = (next: PointerEvent) => {
				const delta = (node.axis === "row" ? next.clientX : next.clientY) - start;
				ratio = Math.max(0.12, Math.min(0.88, initial + delta / Math.max(1, size)));
				first.style.flexBasis = "calc(" + ratio * 100 + "% - 2px)";
			};
			const stop = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", stop);
				window.removeEventListener("blur", stop);
				onResize(node.sourcePath, ratio);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", stop, { once: true });
			window.addEventListener("blur", stop, { once: true });
		});
		split.append(first, separator, second);
		return split;
	};
	const filtered = visibleDockTree(layout, visible);
	if(!filtered){ return; }
	const root = document.createElement("div");
	root.className = "quire-dock-root";
	root.appendChild(createNode(filtered));
	const hidden = document.createElement("div");
	hidden.className = "quire-dock-unused";
	for(const id of ["explorer", "editor", "right"] as const){
		const panel = panels.get(id);
		if(panel && !visible.has(id)){ hidden.appendChild(panel); }
	}
	host.classList.add("dock-tree-enabled");
	host.replaceChildren(root, hidden);
}
