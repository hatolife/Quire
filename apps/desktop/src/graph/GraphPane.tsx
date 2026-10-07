import { createMemo, For, Show } from "solid-js";
import type { LinkGraph } from "../ipc";

type Props = {
	graph: LinkGraph | null;
	currentPath?: string;
	onOpen: (path: string) => void | Promise<void>;
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
	const layout = createMemo(() => {
		const graph = props.graph;
		if(!graph || graph.nodes.length === 0){
			return { nodes: [] as PositionedNode[], edges: [] as Array<{ source: PositionedNode; target: PositionedNode }> };
		}
		const sorted = [...graph.nodes].sort((a, b) => {
			const degree = (b.incoming + b.outgoing) - (a.incoming + a.outgoing);
			return degree || a.path.localeCompare(b.path);
		});
		const count = sorted.length;
		const positioned = sorted.map((node, index) => {
			const ring = count <= 1 ? 0 : index / count;
			const angle = ring * Math.PI * 2 - Math.PI / 2;
			const degree = node.incoming + node.outgoing;
			const radius = count <= 1 ? 0 : 34 + Math.min(10, degree * 1.5);
			return {
				...node,
				x: 50 + Math.cos(angle) * radius,
				y: 50 + Math.sin(angle) * radius,
			};
		});
		const byPath = new Map(positioned.map(node => [node.path, node]));
		const edges = graph.edges
			.map(edge => ({ source: byPath.get(edge.source), target: byPath.get(edge.target) }))
			.filter((edge): edge is { source: PositionedNode; target: PositionedNode } => Boolean(edge.source && edge.target));
		return { nodes: positioned, edges };
	});

	return (
		<div class="graph-pane">
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
	);
}
