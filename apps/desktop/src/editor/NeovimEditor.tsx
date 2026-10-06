import { Channel, invoke } from "@tauri-apps/api/core";
import { createSignal, onCleanup, onMount } from "solid-js";
import "./neovim-editor.css";

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

type CursorStyle = {
	cursorShape?: "block" | "horizontal" | "vertical";
	cellPercentage?: number;
	attrId?: number;
	shortName?: string;
	name?: string;
};

type UiEvent =
	| { type: "grid_resize"; grid: number; width: number; height: number }
	| { type: "grid_clear"; grid: number }
	| { type: "grid_line"; grid: number; row: number; colStart: number; cells: GridCellUpdate[]; wrap: boolean }
	| { type: "grid_cursor_goto"; grid: number; row: number; col: number }
	| { type: "grid_scroll"; grid: number; top: number; bot: number; left: number; right: number; rows: number; cols: number }
	| { type: "default_colors_set"; foreground: number; background: number; special: number }
	| { type: "hl_attr_define"; id: number; attrs: Highlight }
	| { type: "mode_info_set"; cursorStyleEnabled: boolean; modes: CursorStyle[] }
	| { type: "mode_change"; mode: string; modeIdx: number }
	| { type: "busy_start" }
	| { type: "busy_stop" }
	| { type: "flush" };

type StreamMessage =
	| { kind: "redraw"; events: UiEvent[] }
	| { kind: "buffer_lines"; first: number; last: number; lines: string[]; more: boolean }
	| { kind: "error"; message: string }
	| { kind: "closed"; message: string };

type Cell = {
	text: string;
	hlId: number;
};

type Grid = {
	width: number;
	height: number;
	cells: Cell[][];
};

type Props = {
	relativePath: string;
	onTextChange: (text: string) => void;
	onStatus: (status: string) => void;
	onSave: () => void;
};

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
	return "#" + value.toString(16).padStart(6, "0").slice(-6);
}

export default function NeovimEditor(props: Props) {
	let host!: HTMLDivElement;
	let canvas!: HTMLCanvasElement;
	let input!: HTMLTextAreaElement;
	let preedit!: HTMLDivElement;
	let resizeObserver: ResizeObserver | undefined;
	let composing = false;
	let committedCompositionText: string | null = null;
	let started = false;
	let mouseDownButton: string | null = null;
	let cellWidth = 9;
	let grid = createGrid(80, 24);
	let cursor = { grid: 1, row: 0, col: 0 };
	let cursorStyleEnabled = false;
	let cursorStyles: CursorStyle[] = [];
	let currentModeIdx = 0;
	let cursorVisible = true;
	let defaultForeground = 0xffffff;
	let defaultBackground = 0x000000;
	let defaultSpecial = 0xffffff;
	let bufferLines: string[] = [];
	const highlights = new Map<number, Highlight>();
	const [mode, setMode] = createSignal("unknown");
	const [preeditText, setPreeditText] = createSignal("");

	const sendInput = async (text: string) => {
		if(!text){ return; }
		try{
			await invoke("editor_input", { text });
		}catch(error){
			props.onStatus("Editor input error: " + String(error));
		}
	};

	const mouseModifier = (event: MouseEvent): string => {
		let modifier = "";
		if(event.shiftKey){ modifier += "S-"; }
		if(event.ctrlKey){ modifier += "C-"; }
		if(event.altKey){ modifier += "A-"; }
		return modifier;
	};

	const mousePosition = (event: MouseEvent): { row: number; col: number } | null => {
		const rect = host.getBoundingClientRect();
		const col = Math.floor((event.clientX - rect.left) / cellWidth);
		const row = Math.floor((event.clientY - rect.top) / CELL_HEIGHT);
		if(row < 0 || row >= grid.height || col < 0 || col >= grid.width){ return null; }
		return { row, col };
	};

	const mouseButton = (button: number): string | null => {
		switch(button){
		case 0:
			return "left";
		case 1:
			return "middle";
		case 2:
			return "right";
		default:
			return null;
		}
	};

	const sendMouse = async (button: string, action: string, event: MouseEvent) => {
		const position = mousePosition(event);
		if(!position){ return; }
		try{
			await invoke("editor_mouse", {
				button,
				action,
				modifier: mouseModifier(event),
				...position,
			});
		}catch(error){
			props.onStatus("Editor mouse error: " + String(error));
		}
	};

	const handlePointerDown = (event: PointerEvent) => {
		const button = mouseButton(event.button);
		if(!button){ return; }
		event.preventDefault();
		input.focus();
		mouseDownButton = button;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		void sendMouse(button, "press", event);
	};

	const handlePointerMove = (event: PointerEvent) => {
		if(!mouseDownButton){ return; }
		event.preventDefault();
		void sendMouse(mouseDownButton, "drag", event);
	};

	const handlePointerUp = (event: PointerEvent) => {
		const button = mouseDownButton ?? mouseButton(event.button);
		if(!button){ return; }
		event.preventDefault();
		void sendMouse(button, "release", event);
		mouseDownButton = null;
		const target = event.currentTarget as HTMLElement;
		if(target.hasPointerCapture(event.pointerId)){
			target.releasePointerCapture(event.pointerId);
		}
	};

	const handleWheel = (event: WheelEvent) => {
		event.preventDefault();
		let action: string;
		if(Math.abs(event.deltaX) > Math.abs(event.deltaY)){
			action = event.deltaX < 0 ? "left" : "right";
		}else{
			action = event.deltaY < 0 ? "up" : "down";
		}
		void sendMouse("wheel", action, event);
	};

	const ensureCanvasSize = () => {
		const rect = host.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		const width = Math.max(1, Math.floor(rect.width));
		const height = Math.max(1, Math.floor(rect.height));
		canvas.style.width = width + "px";
		canvas.style.height = height + "px";
		const pixelWidth = Math.max(1, Math.floor(width * dpr));
		const pixelHeight = Math.max(1, Math.floor(height * dpr));
		if(canvas.width !== pixelWidth){ canvas.width = pixelWidth; }
		if(canvas.height !== pixelHeight){ canvas.height = pixelHeight; }
		const ctx = canvas.getContext("2d");
		if(!ctx){ return; }
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.font = FONT_SIZE + "px " + FONT_FAMILY;
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
			props.onStatus("Editor resize error: " + String(error));
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
		input.style.left = left + "px";
		input.style.top = top + "px";
		input.style.height = CELL_HEIGHT + "px";
		preedit.style.left = left + "px";
		preedit.style.top = top + "px";
		preedit.style.height = CELL_HEIGHT + "px";
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
					const fontPrefix = (attrs.italic ? "italic " : "") + (attrs.bold ? "bold " : "");
					ctx.font = fontPrefix + FONT_SIZE + "px " + FONT_FAMILY;
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

		if(cursor.grid === 1 && cursorVisible){
			const style = cursorStyleEnabled ? cursorStyles[currentModeIdx] : undefined;
			const shape = style?.cursorShape ?? "block";
			const percentage = Math.max(1, Math.min(100, style?.cellPercentage ?? (shape === "block" ? 100 : 25)));
			const x = cursor.col * cellWidth;
			const y = cursor.row * CELL_HEIGHT;
			ctx.fillStyle = rgbToCss(defaultForeground, "#ffffff");
			if(shape === "vertical"){
				ctx.fillRect(x, y, Math.max(1, Math.ceil(cellWidth * percentage / 100)), CELL_HEIGHT);
			}else if(shape === "horizontal"){
				const height = Math.max(1, Math.ceil(CELL_HEIGHT * percentage / 100));
				ctx.fillRect(x, y + CELL_HEIGHT - height, cellWidth, height);
			}else{
				ctx.globalAlpha = 0.35;
				ctx.fillRect(x, y, cellWidth, CELL_HEIGHT);
				ctx.globalAlpha = 1;
				ctx.strokeStyle = rgbToCss(defaultForeground, "#ffffff");
				ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, cellWidth - 1), CELL_HEIGHT - 1);
			}
		}
		positionInput();
	};

	const applyScroll = (event: Extract<UiEvent, { type: "grid_scroll" }>) => {
		if(event.grid !== 1){ return; }
		const before = grid.cells.map(row => row.map(cell => ({ ...cell })));
		for(let row = event.top; row < event.bot; ++row){
			for(let col = event.left; col < event.right; ++col){
				const sourceRow = row + event.rows;
				const sourceCol = col + event.cols;
				if(sourceRow >= event.top && sourceRow < event.bot && sourceCol >= event.left && sourceCol < event.right){
					grid.cells[row][col] = { ...before[sourceRow][sourceCol] };
				}else{
					grid.cells[row][col] = blankCell();
				}
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
		case "grid_clear":
			if(event.grid === 1){ grid = createGrid(grid.width, grid.height); }
			break;
		case "grid_line":{
			if(event.grid !== 1 || event.row < 0 || event.row >= grid.height){ return; }
			let col = event.colStart;
			for(const update of event.cells){
				for(let index = 0; index < update.repeat; ++index){
					if(col >= 0 && col < grid.width){
						grid.cells[event.row][col] = { text: update.text, hlId: update.hlId };
					}
					++col;
				}
			}
			break;
		}
		case "grid_cursor_goto":
			cursor = { grid: event.grid, row: event.row, col: event.col };
			break;
		case "grid_scroll":
			applyScroll(event);
			break;
		case "default_colors_set":
			defaultForeground = event.foreground;
			defaultBackground = event.background;
			defaultSpecial = event.special;
			break;
		case "hl_attr_define":
			highlights.set(event.id, event.attrs);
			break;
		case "mode_info_set":
			cursorStyleEnabled = event.cursorStyleEnabled;
			cursorStyles = event.modes;
			break;
		case "mode_change":
			currentModeIdx = event.modeIdx;
			setMode(event.mode);
			break;
		case "busy_start":
			cursorVisible = false;
			break;
		case "busy_stop":
			cursorVisible = true;
			break;
		case "flush":
			renderGrid();
			break;
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
			key = "<" + modifiers.join("-") + "-" + body + ">";
		}
		return key;
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		if(!event.isComposing && event.ctrlKey && !event.altKey && event.key.toLowerCase() === "s"){
			event.preventDefault();
			props.onSave();
			return;
		}
		const text = keyToInput(event);
		if(text === null){ return; }
		event.preventDefault();
		void sendInput(text);
	};

	const handleInput = (event: InputEvent) => {
		if(composing || event.isComposing){
			setPreeditText(input.value);
			return;
		}
		const text = input.value;
		input.value = "";
		if(committedCompositionText !== null){
			if(text === committedCompositionText || !text){
				committedCompositionText = null;
				return;
			}
			committedCompositionText = null;
		}
		if(text){ void sendInput(text); }
	};

	const handleCompositionUpdate = (event: CompositionEvent) => {
		setPreeditText(event.data || input.value);
	};

	const handleCompositionEnd = (event: CompositionEvent) => {
		composing = false;
		const text = event.data || input.value;
		setPreeditText("");
		input.value = "";
		if(!text){ return; }
		committedCompositionText = text;
		void sendInput(text);
	};

	const applyBufferLines = (message: Extract<StreamMessage, { kind: "buffer_lines" }>) => {
		const first = Math.max(0, message.first);
		const last = message.last < 0 ? bufferLines.length : Math.max(first, message.last);
		bufferLines.splice(first, last - first, ...message.lines);
		props.onTextChange(bufferLines.join("\n"));
	};

	onMount(async () => {
		ensureCanvasSize();
		const stream = new Channel<StreamMessage>();
		stream.onmessage = message => {
			if(message.kind === "redraw"){
				for(const event of message.events){ applyEvent(event); }
				props.onStatus("Neovim connected / mode: " + mode());
			}else if(message.kind === "buffer_lines"){
				applyBufferLines(message);
			}else if(message.kind === "error"){
				props.onStatus(message.message);
			}else{
				props.onStatus("Neovim closed: " + message.message);
			}
		};

		try{
			await invoke("editor_start_document", {
				relativePath: props.relativePath,
				stream,
			});
			started = true;
			await requestResize();
			props.onStatus("Neovim connected");
			input.focus();
		}catch(error){
			props.onStatus("Neovim start error: " + String(error));
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
		void invoke("editor_stop");
	});

	return (
		<div
			ref={host}
			class="neovim-editor-host"
			onPointerDown={event => handlePointerDown(event as PointerEvent)}
			onPointerMove={event => handlePointerMove(event as PointerEvent)}
			onPointerUp={event => handlePointerUp(event as PointerEvent)}
			onWheel={event => handleWheel(event as WheelEvent)}
			onContextMenu={event => event.preventDefault()}
		>
			<canvas ref={canvas} class="neovim-editor-canvas" />
			<div ref={preedit} class="neovim-ime-preedit" classList={{ active: !!preeditText() }}>{preeditText()}</div>
			<textarea
				ref={input}
				class="neovim-ime-input"
				aria-label="Neovim input"
				onKeyDown={handleKeyDown}
				onInput={event => handleInput(event as InputEvent)}
				onCompositionStart={() => {
					composing = true;
					committedCompositionText = null;
					setPreeditText("");
				}}
				onCompositionUpdate={event => handleCompositionUpdate(event as CompositionEvent)}
				onCompositionEnd={event => handleCompositionEnd(event as CompositionEvent)}
			/>
		</div>
	);
}
