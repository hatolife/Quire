import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

export type AppCommand = {
	id: string;
	title: string;
	keywords?: string;
	shortcut?: string;
	enabled?: boolean;
	run: () => void | Promise<void>;
};

type Props = {
	open: boolean;
	commands: AppCommand[];
	onClose: () => void;
};

export default function CommandPalette(props: Props) {
	let input!: HTMLInputElement;
	const [query, setQuery] = createSignal("");
	const [selected, setSelected] = createSignal(0);

	const commands = createMemo(() => {
		const needle = query().trim().toLowerCase();
		const enabled = props.commands.filter(command => command.enabled !== false);
		if(!needle){ return enabled; }
		return enabled.filter(command => {
			const haystack = (command.title + " " + (command.keywords ?? "")).toLowerCase();
			return haystack.includes(needle);
		});
	});

	createEffect(() => {
		if(!props.open){ return; }
		setQuery("");
		setSelected(0);
		queueMicrotask(() => input?.focus());
	});

	createEffect(() => {
		commands();
		setSelected(index => Math.max(0, Math.min(index, Math.max(0, commands().length - 1))));
	});

	const execute = async (command: AppCommand | undefined) => {
		if(!command){ return; }
		props.onClose();
		await command.run();
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		if(event.key === "Escape"){
			event.preventDefault();
			props.onClose();
			return;
		}
		if(event.key === "ArrowDown"){
			event.preventDefault();
			setSelected(index => Math.min(index + 1, Math.max(0, commands().length - 1)));
			return;
		}
		if(event.key === "ArrowUp"){
			event.preventDefault();
			setSelected(index => Math.max(0, index - 1));
			return;
		}
		if(event.key === "Enter"){
			event.preventDefault();
			void execute(commands()[selected()]);
		}
	};

	return (
		<Show when={props.open}>
			<div class="command-palette-backdrop" onMouseDown={event => {
				if(event.target === event.currentTarget){ props.onClose(); }
			}}>
				<div class="command-palette">
					<input
						ref={input}
						value={query()}
						onInput={event => { setQuery(event.currentTarget.value); setSelected(0); }}
						onKeyDown={handleKeyDown}
						placeholder="コマンドを検索"
						spellcheck={false}
					/>
					<div class="command-list">
						<For each={commands()}>
							{(command, index) => (
								<button
									class="command-entry"
									classList={{ selected: index() === selected() }}
									onMouseEnter={() => setSelected(index())}
									onClick={() => void execute(command)}
								>
									<span>{command.title}</span>
									<Show when={command.shortcut}><kbd>{command.shortcut}</kbd></Show>
								</button>
							)}
						</For>
						<Show when={commands().length === 0}>
							<div class="command-empty">該当するコマンドはありません。</div>
						</Show>
					</div>
				</div>
			</div>
		</Show>
	);
}
