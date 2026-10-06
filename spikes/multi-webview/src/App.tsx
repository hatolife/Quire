import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createSignal, onCleanup, onMount } from "solid-js";

function App() {
	let browserSlot!: HTMLDivElement;
	let browser: Webview | undefined;
	let resizeObserver: ResizeObserver | undefined;
	const [status, setStatus] = createSignal("starting");
	const [leftWidth, setLeftWidth] = createSignal(42);

	const syncBrowserBounds = async () => {
		if(!browser){ return; }
		const rect = browserSlot.getBoundingClientRect();
		try{
			await browser.setPosition(new LogicalPosition(rect.left, rect.top));
			await browser.setSize(new LogicalSize(Math.max(1, rect.width), Math.max(1, rect.height)));
			setStatus(`browser: ${Math.round(rect.width)} x ${Math.round(rect.height)}`);
		}catch(error){
			setStatus(`resize error: ${String(error)}`);
		}
	};

	const setSplit = (width: number) => {
		setLeftWidth(width);
		requestAnimationFrame(() => { void syncBrowserBounds(); });
	};

	const runBrowserAction = async (action: "focus" | "hide" | "show") => {
		if(!browser){ return; }
		try{
			if(action === "focus"){ await browser.setFocus(); }
			if(action === "hide"){ await browser.hide(); }
			if(action === "show"){
				await browser.show();
				await syncBrowserBounds();
			}
			setStatus(`${action} ok`);
		}catch(error){
			setStatus(`${action} error: ${String(error)}`);
		}
	};

	onMount(() => {
		const appWindow = getCurrentWindow();
		browser = new Webview(appWindow, "browser-pane", {
			url: "https://example.com",
			x: 1,
			y: 1,
			width: 100,
			height: 100,
		});
		browser.once("tauri://created", () => {
			setStatus("browser created");
			void syncBrowserBounds();
		});
		browser.once("tauri://error", event => {
			setStatus(`browser create error: ${String(event.payload)}`);
		});
		resizeObserver = new ResizeObserver(() => { void syncBrowserBounds(); });
		resizeObserver.observe(browserSlot);
	});

	onCleanup(() => {
		resizeObserver?.disconnect();
		void browser?.close();
	});

	return (
		<div class="app">
			<header class="toolbar">
				<strong>Quire / Multi WebView Spike</strong>
				<span>{status()}</span>
			</header>
			<div class="content" style={`grid-template-columns: ${leftWidth()}% 1fr;`}>
				<section class="quire-pane">
					<h1>Quire UI WebView</h1>
					<p>右側は同じWindow内へ追加したchild WebViewです。</p>
					<div class="buttons">
						<button onClick={() => setSplit(30)}>30 / 70</button>
						<button onClick={() => setSplit(50)}>50 / 50</button>
						<button onClick={() => setSplit(70)}>70 / 30</button>
					</div>
					<div class="buttons">
						<button onClick={() => { void runBrowserAction("focus"); }}>Focus browser</button>
						<button onClick={() => { void runBrowserAction("hide"); }}>Hide browser</button>
						<button onClick={() => { void runBrowserAction("show"); }}>Show browser</button>
					</div>
					<p>Window resize、DPI変更、focus移動、Web側のkeyboard入力を確認する。</p>
				</section>
				<div ref={browserSlot} class="browser-slot" aria-label="Browser WebView placement target">
					<span>child WebView target</span>
				</div>
			</div>
		</div>
	);
}

export default App;
