import { createMemo, createSignal, For, Show } from "solid-js";
import type { LinkGraph } from "../ipc";

type Props = {
	graph: LinkGraph | null;
	currentPath?: string;
	onOpen: (path: string) => void | Promise<unknown>;
};

type PositionedNode = {
	path: string;
	incoming: number;
	outgoing: number;
	x: number;
	y: number;
};

function label(path: string): string {
	const name = path.split("/").pop() ?? path;
	return name.replace(/\.md(?:own)?$/i, "");
}

export default function GraphPane(props: Props) {
	const [mode, setMode] = createSignal<"local" | "all">("local");
	const [query, setQuery] = createSignal("");
	const [showIsolated, setShowIsolated] = createSignal(false);

	const filteredGraph = createMemo(() => {
		const graph = props.graph;
		if(!graph){ return null; }
		const queryValue = query().trim().toLocaleLowerCase();
		let allowed = new Set(graph.nodes.map(node => node.path));

		if(mode() === "local" && props.currentPath){
			allowed = new Set([props.currentPath]);
			for(const edge of graph.edges){
				if(edge.source === props.currentPath){ allowed.add(edge.target); }
				if(edge.target === props.currentPath){ allowed.add(edge.source); }
			}
		}

		if(queryValue){
			allowed = new Set([...allowed].filter(path => path.toLocaleLowerCase().includes(queryValue)));
		}

		const edges = graph.edges.filter(edge => allowed.has(edge.source) && allowed.has(edge.target));
		const connected = new Set<string>();
		for(const edge of edges){
			connected.add(edge.source);
			connected.add(edge.target);
		}
		const nodes = graph.nodes.filter(node => {
			if(!allowed.has(node.path)){ return false; }
			if(showIsolated()){ return true; }
			return connected.has(node.path) || node.path === props.currentPath;
		});
		const visible = new Set(nodes.map(node => node.path));
		return {
			nodes,
			edges: edges.filter(edge => visible.has(edge.source) && visible.has(edge.target)),
		};
	});

	const layout = createMemo(() => {
		const graph = filteredGraph();
		if(!graph || graph.nodes.length === 0){
			return { nodes: [] as PositionedNode[], edges: [] as Array<{ source: PositionedNode; target: PositionedNode }> };
		}
		const sorted = [...graph.nodes].sort((a, b) => {
			if(a.path === props.currentPath){ return -1; }
			if(b.path === props.currentPath){ return 1; }
			const degree = (b.incoming + b.outgoing) - (a.incoming + a.outgoing);
			return degree || a.path.localeCompare(b.path);
		});
		const positioned: PositionedNode[] = [];
		const currentIndex = props.currentPath ? sorted.findIndex(node => node.path === props.currentPath) : -1;

		if(mode() === "local" && currentIndex >= 0){
			const current = sorted[currentIndex];
			positioned.push({ ...current, x: 50, y: 50 });
			const neighbors = sorted.filter((_, index) => index !== currentIndex);
			const count = neighbors.length;
			for(let index = 0; index < count; ++index){
				const node = neighbors[index];
				const angle = (index / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
				const radius = count <= 6 ? 31 : 36;
				positioned.push({
					...node,
					x: 50 + Math.cos(angle) * radius,
					y: 50 + Math.sin(angle) * radius,
				});
			}
		}else{
			const count = sorted.length;
			const ringCapacity = Math.max(8, Math.ceil(Math.sqrt(count) * 2.4));
			let index = 0;
			let ringIndex = 0;
			while(index < count){
				const remaining = count - index;
				const capacity = ringIndex === 0 ? Math.min(1, remaining) : Math.min(ringCapacity * ringIndex, remaining);
				const radius = ringIndex === 0 ? 0 : Math.min(43, 13 + ringIndex * 11);
				for(let slot = 0; slot < capacity; ++slot){
					const node = sorted[index++];
					const angle = capacity <= 1 ? 0 : (slot / capacity) * Math.PI * 2 - Math.PI / 2;
					positioned.push({
						...node,
						x: 50 + Math.cos(angle) * radius,
						y: 50 + Math.sin(angle) * radius,
					});
				}
				++ringIndex;
			}
		}
		const byPath = new Map(positioned.map(node => [node.path, node]));
		const edges = graph.edges
			.map(edge => ({ source: byPath.get(edge.source), target: byPath.get(edge.target) }))
			.filter((edge): edge is { source: PositionedNode; target: PositionedNode } => Boolean(edge.source && edge.target));
		return { nodes: positioned, edges };
	});

	return (
		<div class="graph-pane">
			<div class="graph-toolbar">
				<button classList={{ active: mode() === "local" }} disabled={!props.currentPath} onClick={() => setMode("local")}>Local</button>
				<button classList={{ active: mode() === "all" }} onClick={() => setMode("all")}>All</button>
				<input
					type="search"
					value={query()}
					onInput={event => setQuery(event.currentTarget.value)}
					placeholder="Graphを絞り込み"
				/>
				<label>
					<input type="checkbox" checked={showIsolated()} onChange={event => setShowIsolated(event.currentTarget.checked)} />
					孤立
				</label>
				<span>{layout().nodes.length} nodes / {layout().edges.length} edges</span>
			</div>
			<div class="graph-stage">
				<Show
					when={layout().nodes.length > 0}
					fallback={<div class="empty-pane">Graphを表示するlinkがありません。</div>}
				>
					<svg class="graph-canvas" viewBox="0 0 100 100" role="img" aria-label="Workspace link graph">
					<g class="graph-edges">
						<For each={layout().edges}>
							{edge => <line x1={edge.source.x} y1={edge.source.y} x2={edge.target.x} y2={edge.target.y} />}
						</For>
					</g>
					<g class="graph-nodes">
						<For each={layout().nodes}>
							{node => {
								const degree = node.incoming + node.outgoing;
								const radius = Math.max(1.3, Math.min(3.1, 1.3 + degree * 0.22));
								return (
									<g
										class="graph-node"
										classList={{ current: node.path === props.currentPath, isolated: degree === 0 }}
										transform={"translate(" + node.x + " " + node.y + ")"}
										onClick={() => void props.onOpen(node.path)}
									>
										<title>{node.path + " / in " + node.incoming + " / out " + node.outgoing}</title>
										<circle r={radius} />
										<text y={radius + 2.6} text-anchor="middle">{label(node.path)}</text>
									</g>
								);
							}}
						</For>
					</g>
					</svg>
				</Show>
			</div>
		</div>
	);
}
