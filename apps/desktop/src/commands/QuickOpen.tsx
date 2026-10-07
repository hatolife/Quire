import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

type Props = {
	open: boolean;
	documents: string[];
	currentPath?: string;
	indexReady: boolean;
	onOpen: (path: string) => void | Promise<unknown>;
	onClose: () => void;
};

type RankedPath = {
	path: string;
	score: number;
};

function fileName(path: string): string {
	const index = path.lastIndexOf("/");
	return index >= 0 ? path.slice(index + 1) : path;
}

function rank(path: string, rawQuery: string): number | null {
	const query = rawQuery.trim().toLocaleLowerCase();
	if(!query){ return 0; }
	const lowerPath = path.toLocaleLowerCase();
	const lowerName = fileName(path).toLocaleLowerCase();

	if(lowerName === query){ return 10000; }
	if(lowerName.startsWith(query)){ return 9000 - lowerName.length; }
	const nameIndex = lowerName.indexOf(query);
	if(nameIndex >= 0){ return 8000 - nameIndex * 10 - lowerName.length; }
	const pathIndex = lowerPath.indexOf(query);
	if(pathIndex >= 0){ return 6000 - pathIndex - lowerPath.length * 0.01; }

	let cursor = 0;
	let gaps = 0;
	let previous = -1;
	for(const ch of query){
		const found = lowerPath.indexOf(ch, cursor);
		if(found < 0){ return null; }
		if(previous >= 0){ gaps += found - previous - 1; }
		previous = found;
		cursor = found + 1;
	}
	return 3000 - gaps * 4 - lowerPath.length * 0.01;
}

export default function QuickOpen(props: Props) {
	let input!: HTMLInputElement;
	const [query, setQuery] = createSignal("");
	const [selected, setSelected] = createSignal(0);

	const results = createMemo(() => {
		const ranked = props.documents
			.map(path => ({ path, score: rank(path, query()) }))
			.filter((value): value is RankedPath => value.score !== null)
			.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
		return ranked.slice(0, 100);
	});

	createEffect(() => {
		if(!props.open){ return; }
		setQuery("");
		setSelected(0);
		queueMicrotask(() => input?.focus());
	});

	createEffect(() => {
		results();
		setSelected(index => Math.max(0, Math.min(index, Math.max(0, results().length - 1))));
	});

	const choose = async (path: string | undefined) => {
		if(!path){ return; }
		props.onClose();
		await props.onOpen(path);
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		if(event.key === "Escape"){
			event.preventDefault();
			props.onClose();
			return;
		}
		if(event.key === "ArrowDown"){
			event.preventDefault();
			setSelected(index => Math.min(index + 1, Math.max(0, results().length - 1)));
			return;
		}
		if(event.key === "ArrowUp"){
			event.preventDefault();
			setSelected(index => Math.max(0, index - 1));
			return;
		}
		if(event.key === "Enter"){
			event.preventDefault();
			void choose(results()[selected()]?.path);
		}
	};

	return (
		<Show when={props.open}>
			<div class="quick-open-backdrop" onMouseDown={event => {
				if(event.target === event.currentTarget){ props.onClose(); }
			}}>
				<div class="quick-open">
					<input
						ref={input}
						value={query()}
						onInput={event => { setQuery(event.currentTarget.value); setSelected(0); }}
						onKeyDown={handleKeyDown}
						placeholder="Markdownを開く"
						spellcheck={false}
					/>
					<div class="quick-open-list">
						<Show when={props.indexReady} fallback={<div class="quick-open-empty">検索indexを構築中...</div>}>
							<For each={results()}>
								{(result, index) => (
									<button
										class="quick-open-entry"
										classList={{
											selected: index() === selected(),
											current: result.path === props.currentPath,
										}}
										onMouseEnter={() => setSelected(index())}
										onClick={() => void choose(result.path)}
									>
										<strong>{fileName(result.path)}</strong>
										<small>{result.path}</small>
									</button>
								)}
							</For>
							<Show when={results().length === 0}>
								<div class="quick-open-empty">該当するMarkdownはありません。</div>
							</Show>
						</Show>
					</div>
				</div>
			</div>
		</Show>
	);
}
