import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

type Props = {
	open: boolean;
	templates: string[];
	directory: string;
	onChoose: (path: string) => void | Promise<void>;
	onClose: () => void;
};

function name(path: string): string {
	const file = path.split("/").pop() ?? path;
	return file.replace(/\.md(?:own)?$/i, "");
}

export default function TemplatePicker(props: Props) {
	let input!: HTMLInputElement;
	const [query, setQuery] = createSignal("");
	const [selected, setSelected] = createSignal(0);
	const results = createMemo(() => {
		const needle = query().trim().toLocaleLowerCase();
		return props.templates
			.filter(path => !needle || path.toLocaleLowerCase().includes(needle))
			.slice(0, 100);
	});

	createEffect(() => {
		if(!props.open){ return; }
		setQuery("");
		setSelected(0);
		queueMicrotask(() => input?.focus());
	});

	const choose = async (path?: string) => {
		if(!path){ return; }
		props.onClose();
		await props.onChoose(path);
	};

	const keyDown = (event: KeyboardEvent) => {
		if(event.key === "Escape"){
			event.preventDefault();
			props.onClose();
		}else if(event.key === "ArrowDown"){
			event.preventDefault();
			setSelected(value => Math.min(value + 1, Math.max(0, results().length - 1)));
		}else if(event.key === "ArrowUp"){
			event.preventDefault();
			setSelected(value => Math.max(0, value - 1));
		}else if(event.key === "Enter"){
			event.preventDefault();
			void choose(results()[selected()]);
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
						onKeyDown={keyDown}
						placeholder={"Templateを選択 — " + props.directory}
						spellcheck={false}
					/>
					<div class="quick-open-list">
						<For each={results()}>
							{(path, index) => (
								<button
									class="quick-open-entry"
									classList={{ selected: index() === selected() }}
									onMouseEnter={() => setSelected(index())}
									onClick={() => void choose(path)}
								>
									<strong>{name(path)}</strong>
									<small>{path}</small>
								</button>
							)}
						</For>
						<Show when={results().length === 0}>
							<div class="quick-open-empty">{props.directory}/ にMarkdown Templateがありません。</div>
						</Show>
					</div>
				</div>
			</div>
		</Show>
	);
}
