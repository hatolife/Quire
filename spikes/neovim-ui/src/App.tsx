import { Channel, invoke } from "@tauri-apps/api/core";
import { onCleanup, onMount } from "solid-js";
import { createSignal } from "solid-js";

type Highlight = {
	foreground?: number;
	background?: number;
	special?: number;
	reverse: boolean;
	bold: boolean;
	italic: boolean;
	underline: boolean;
	strikethrough: boolean;
};

type GridCellUpdate = {
	text: string;
	hlId: number;
	repeat: number;
};

type UiEvent =
	| { type: "grid_resize"; grid: number; width: number; height: number }
	| { type: "grid_clear"; grid: number }
	| { type: "grid_line"; grid: number; row: number; colStart: number; cells: GridCellUpdate[]; wrap: boolean }
	| { type: "grid_cursor_goto"; grid: number; row: number; col: number }
	| { type: "grid_scroll"; grid: number; top: number; bot: number; left: number; right: number; rows: number; cols: number }
	| { type: "default_colors_set"; foreground: number; background: number; special: number }
	| { type: "hl_attr_define"; id: number; attrs: Highlight }
	| { type: "flush" };

type StreamMessage =
	| { kind: "redraw"; events: UiEvent[] }
	| { kind: "closed"; message: string };

type Cell = { text: string; hlId: number };
type Grid = { width: number; height: number; cells: Cell[][] };

const FONT_SIZE = 16;
const CELL_HEIGHT = 22;
const FONT_FAMILY = '"Cascadia Mono", "Yu Gothic UI", Consolas, monospace';

function blankCell(): Cell {
	return { text: " ", hlId: 0 };
}

function createGrid(width: number, height: number): Grid {
	return {
		width,
		height,
		cells: Array.from({ length: height }, () => Array.from({ length: width }, blankCell)),
	};
}

function rgbToCss(value: number, fallback: string): string {
	if(value < 0){ return fallback; }
	return `#${value.toString(16).padStart(6, "0").slice(-6)}`;
}

function App() {
	let host!: HTMLDivElement;
	let canvas!: HTMLCanvasElement;
	let input!: HTMLTextAreaElement;
	let resizeObserver: ResizeObserver | undefined;
	let composing = false;
	let started = false;
	let cellWidth = 9;
	let grid = createGrid(80, 24);
	let cursor = { grid: 1, row: 0, col: 0 };
	let defaultForeground = 0xffffff;
	let defaultBackground = 0x000000;
	let defaultSpecial = 0xffffff;
	const highlights = new Map<number, Highlight>();
	const [status, setStatus] = createSignal("starting");

	const sendInput = async (text: string) => {
		if(!text){ return; }
		try{
			await invoke("editor_input", { text });
		}catch(error){
			setStatus(`input error: ${String(error)}`);
		}
	};

	const ensureCanvasSize = () => {
		const rect = host.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		const width = Math.max(1, Math.floor(rect.width));
		const height = Math.max(1, Math.floor(rect.height));
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;
		canvas.width = Math.max(1, Math.floor(width * dpr));
		canvas.height = Math.max(1, Math.floor(height * dpr));
		const ctx = canvas.getContext("2d");
		if(!ctx){ return; }
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
		cellWidth = Math.max(1, Math.ceil(ctx.measureText("M").width));
	};

	const requestResize = async () => {
		if(!started){ return; }
		const rect = host.getBoundingClientRect();
		const cols = Math.max(10, Math.floor(rect.width / cellWidth));
		const rows = Math.max(4, Math.floor(rect.height / CELL_HEIGHT));
		try{
			await invoke("editor_resize", { width: cols, height: rows });
		}catch(error){
			setStatus(`resize error: ${String(error)}`);
		}
	};

	const resolveHighlight = (hlId: number) => {
		const attrs = highlights.get(hlId) ?? {
			reverse: false,
			bold: false,
			italic: false,
			underline: false,
			strikethrough: false,
		};
		let foreground = attrs.foreground ?? defaultForeground;
		let background = attrs.background ?? defaultBackground;
		if(attrs.reverse){
			[foreground, background] = [background, foreground];
		}
		return { attrs, foreground, background };
	};

	const positionInput = () => {
		const left = Math.max(0, cursor.col * cellWidth);
		const top = Math.max(0, cursor.row * CELL_HEIGHT);
		input.style.left = `${left}px`;
		input.style.top = `${top}px`;
		input.style.height = `${CELL_HEIGHT}px`;
	};

	const renderGrid = () => {
		ensureCanvasSize();
		const ctx = canvas.getContext("2d");
		if(!ctx){ return; }
		const rect = host.getBoundingClientRect();
		ctx.fillStyle = rgbToCss(defaultBackground, "#000000");
		ctx.fillRect(0, 0, rect.width, rect.height);
		ctx.textBaseline = "top";

		for(let row = 0; row < grid.height; ++row){
			for(let col = 0; col < grid.width; ++col){
				const cell = grid.cells[row]?.[col];
				if(!cell){ continue; }
				const { attrs, foreground, background } = resolveHighlight(cell.hlId);
				const x = col * cellWidth;
				const y = row * CELL_HEIGHT;
				if(background !== defaultBackground){
					ctx.fillStyle = rgbToCss(background, "#000000");
					ctx.fillRect(x, y, cellWidth, CELL_HEIGHT);
				}
				if(cell.text){
					const fontPrefix = `${attrs.italic ? "italic " : ""}${attrs.bold ? "bold " : ""}`;
					ctx.font = `${fontPrefix}${FONT_SIZE}px ${FONT_FAMILY}`;
					ctx.fillStyle = rgbToCss(foreground, "#ffffff");
					ctx.fillText(cell.text, x, y + 2);
					if(attrs.underline){
						ctx.fillStyle = rgbToCss(attrs.special ?? defaultSpecial, "#ffffff");
						ctx.fillRect(x, y + CELL_HEIGHT - 2, cellWidth, 1);
					}
					if(attrs.strikethrough){
						ctx.fillStyle = rgbToCss(foreground, "#ffffff");
						ctx.fillRect(x, y + Math.floor(CELL_HEIGHT / 2), cellWidth, 1);
					}
				}
			}
		}

		if(cursor.grid === 1){
			ctx.strokeStyle = rgbToCss(defaultForeground, "#ffffff");
			ctx.lineWidth = 1;
			ctx.strokeRect(cursor.col * cellWidth + 0.5, cursor.row * CELL_HEIGHT + 0.5, Math.max(1, cellWidth - 1), CELL_HEIGHT - 1);
		}
		positionInput();
	};

	const applyScroll = (event: Extract<UiEvent, { type: "grid_scroll" }>) => {
		if(event.grid !== 1 || event.cols !== 0){ return; }
		const before = grid.cells.map(row => row.map(cell => ({ ...cell })));
		for(let row = event.top; row < event.bot; ++row){
			const sourceRow = row + event.rows;
			if(sourceRow < event.top || sourceRow >= event.bot){ continue; }
			for(let col = event.left; col < event.right; ++col){
				grid.cells[row][col] = { ...before[sourceRow][col] };
			}
		}
	};

	const applyEvent = (event: UiEvent) => {
		switch(event.type){
		case "grid_resize":{
			if(event.grid !== 1){ return; }
			const next = createGrid(event.width, event.height);
			for(let row = 0; row < Math.min(grid.height, next.height); ++row){
				for(let col = 0; col < Math.min(grid.width, next.width); ++col){
					next.cells[row][col] = grid.cells[row][col];
				}
			}
			grid = next;
			break;
		}
		case "grid_clear":{
			if(event.grid === 1){ grid = createGrid(grid.width, grid.height); }
			break;
		}
		case "grid_line":{
			if(event.grid !== 1 || event.row < 0 || event.row >= grid.height){ return; }
			let col = event.colStart;
			for(const update of event.cells){
				for(let i = 0; i < update.repeat; ++i){
					if(col >= 0 && col < grid.width){
						grid.cells[event.row][col] = { text: update.text, hlId: update.hlId };
					}
					++col;
				}
			}
			break;
		}
		case "grid_cursor_goto":{
			cursor = { grid: event.grid, row: event.row, col: event.col };
			break;
		}
		case "grid_scroll":{
			applyScroll(event);
			break;
		}
		case "default_colors_set":{
			defaultForeground = event.foreground;
			defaultBackground = event.background;
			defaultSpecial = event.special;
			break;
		}
		case "hl_attr_define":{
			highlights.set(event.id, event.attrs);
			break;
		}
		case "flush":{
			renderGrid();
			break;
		}
		}
	};

	const keyToInput = (event: KeyboardEvent): string | null => {
		if(event.isComposing || event.key === "Process" || event.keyCode === 229){ return null; }
		const special: Record<string, string> = {
			Enter: "<CR>",
			Backspace: "<BS>",
			Escape: "<Esc>",
			Tab: "<Tab>",
			ArrowLeft: "<Left>",
			ArrowRight: "<Right>",
			ArrowUp: "<Up>",
			ArrowDown: "<Down>",
			Delete: "<Del>",
			Home: "<Home>",
			End: "<End>",
			PageUp: "<PageUp>",
			PageDown: "<PageDown>",
		};
		let key = special[event.key] ?? (event.key.length === 1 ? (event.key === "<" ? "<LT>" : event.key) : null);
		if(!key){ return null; }
		const modifiers: string[] = [];
		if(event.ctrlKey){ modifiers.push("C"); }
		if(event.altKey){ modifiers.push("A"); }
		if(event.shiftKey && special[event.key]){ modifiers.push("S"); }
		if(modifiers.length){
			const body = special[event.key] ? special[event.key].slice(1, -1) : event.key;
			key = `<${modifiers.join("-")}-${body}>`;
		}
		return key;
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		const text = keyToInput(event);
		if(text === null){ return; }
		event.preventDefault();
		void sendInput(text);
	};

	const handleInput = (event: InputEvent) => {
		if(composing || event.isComposing){ return; }
		const text = input.value;
		input.value = "";
		if(text){ void sendInput(text); }
	};

	onMount(async () => {
		ensureCanvasSize();
		const stream = new Channel<StreamMessage>();
		stream.onmessage = message => {
			if(message.kind === "redraw"){
				for(const event of message.events){ applyEvent(event); }
				setStatus("connected");
			}else{
				setStatus(`closed: ${message.message}`);
			}
		};
		try{
			await invoke("start_editor", { stream });
			started = true;
			await requestResize();
			setStatus("connected");
			input.focus();
		}catch(error){
			setStatus(`start error: ${String(error)}`);
		}
		resizeObserver = new ResizeObserver(() => {
			ensureCanvasSize();
			void requestResize();
			renderGrid();
		});
		resizeObserver.observe(host);
	});

	onCleanup(() => {
		resizeObserver?.disconnect();
		void invoke("stop_editor");
	});

	return (
		<div class="app">
			<div class="toolbar">
				<strong>Quire / Neovim UI Spike</strong>
				<span>{status()}</span>
				<span>Canvas + ext_linegrid + Tauri Channel</span>
			</div>
			<div
				ref={host}
				class="editor"
				onMouseDown={() => input.focus()}
			>
				<canvas ref={canvas} />
				<textarea
					ref={input}
					class="ime-input"
					aria-label="Neovim input"
					onKeyDown={handleKeyDown}
					onInput={event => handleInput(event as InputEvent)}
					onCompositionStart={() => { composing = true; }}
					onCompositionEnd={() => { composing = false; }}
				/>
			</div>
		</div>
	);
}

export default App;
