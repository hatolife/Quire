import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import {
	browserBack,
	browserCurrentUrl,
	browserForward,
	browserNavigate,
	browserReload,
} from "../ipc";

type Props = {
	active: boolean;
	navigateTo?: string;
	onStatus: (message: string) => void;
	onUrlChange?: (url: string) => void;
};

function normalizeUrl(value: string): string | null {
	const trimmed = value.trim();
	if(!trimmed){ return null; }
	const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : "https://" + trimmed;
	try{
		const parsed = new URL(candidate);
		if(parsed.protocol !== "http:" && parsed.protocol !== "https:"){ return null; }
		return parsed.toString();
	}catch{
		return null;
	}
}

export default function BrowserPane(props: Props) {
	let slot!: HTMLDivElement;
	let browser: Webview | undefined;
	let resizeObserver: ResizeObserver | undefined;
	let generation = 0;
	let urlPollTimer: number | undefined;
	const [urlDraft, setUrlDraft] = createSignal("https://example.com/");
	const [currentUrl, setCurrentUrl] = createSignal("https://example.com/");
	const [busy, setBusy] = createSignal(false);

	const syncBounds = async () => {
		if(!browser || !props.active){ return; }
		const rect = slot.getBoundingClientRect();
		if(rect.width < 1 || rect.height < 1){ return; }
		await browser.setPosition(new LogicalPosition(rect.left, rect.top));
		await browser.setSize(new LogicalSize(Math.max(1, rect.width), Math.max(1, rect.height)));
	};

	const closeBrowser = async () => {
		const current = browser;
		browser = undefined;
		if(current){
			try{ await current.close(); }catch{}
		}
	};

	const syncCurrentUrl = async () => {
		if(!browser){ return; }
		try{
			const url = await browserCurrentUrl();
			if(url){
				setCurrentUrl(url);
				setUrlDraft(url);
				props.onUrlChange?.(url);
			}
		}catch{
			// The WebView can disappear while closing or being recreated.
		}
	};

	const createBrowser = async (url: string) => {
		const ownGeneration = ++generation;
		setBusy(true);
		await closeBrowser();
		if(ownGeneration !== generation){ return; }

		const appWindow = getCurrentWindow();
		const next = new Webview(appWindow, "browser-pane", {
			url,
			x: 1,
			y: 1,
			width: 100,
			height: 100,
			focus: false,
		});
		browser = next;

		next.once("tauri://created", () => {
			if(ownGeneration !== generation){ return; }
			setBusy(false);
			setCurrentUrl(url);
			setUrlDraft(url);
			props.onUrlChange?.(url);
			props.onStatus("Browser opened: " + url);
			void syncCurrentUrl();
			if(props.active){
				void next.show().then(syncBounds);
			}else{
				void next.hide();
			}
		});
		next.once("tauri://error", event => {
			if(ownGeneration !== generation){ return; }
			setBusy(false);
			props.onStatus("Browser create error: " + String(event.payload));
		});
	};

	const navigateUrl = async (url: string) => {
		setBusy(true);
		try{
			if(browser){
				await browserNavigate(url);
				setCurrentUrl(url);
				setUrlDraft(url);
				props.onUrlChange?.(url);
			}else{
				await createBrowser(url);
			}
			props.onStatus("Browser navigation: " + url);
			window.setTimeout(() => { void syncCurrentUrl(); }, 250);
		}catch(error){
			props.onStatus("Browser navigation error: " + String(error));
		}finally{
			setBusy(false);
		}
	};

	const navigate = async () => {
		const url = normalizeUrl(urlDraft());
		if(!url){
			props.onStatus("Browser URL error: http/https URLを入力してください。");
			return;
		}
		await navigateUrl(url);
	};

	const historyAction = async (action: "back" | "forward" | "reload") => {
		if(!browser){ return; }
		setBusy(true);
		try{
			if(action === "back"){
				await browserBack();
			}else if(action === "forward"){
				await browserForward();
			}else{
				await browserReload();
			}
			window.setTimeout(() => { void syncCurrentUrl(); }, 250);
		}catch(error){
			props.onStatus("Browser " + action + " error: " + String(error));
		}finally{
			setBusy(false);
		}
	};

	createEffect(() => {
		const requested = props.navigateTo;
		if(!requested || requested === currentUrl()){ return; }
		const normalized = normalizeUrl(requested);
		if(!normalized){ return; }
		setUrlDraft(normalized);
		void navigateUrl(normalized);
	});

	createEffect(() => {
		const active = props.active;
		const current = browser;
		if(urlPollTimer !== undefined){
			window.clearInterval(urlPollTimer);
			urlPollTimer = undefined;
		}
		if(!current){ return; }
		if(active){
			void current.show().then(syncBounds).catch(error => props.onStatus("Browser show error: " + String(error)));
			void syncCurrentUrl();
			urlPollTimer = window.setInterval(() => { void syncCurrentUrl(); }, 750);
		}else{
			void current.hide().catch(error => props.onStatus("Browser hide error: " + String(error)));
		}
	});

	onMount(() => {
		resizeObserver = new ResizeObserver(() => { void syncBounds(); });
		resizeObserver.observe(slot);
		void createBrowser(currentUrl());
	});

	onCleanup(() => {
		++generation;
		resizeObserver?.disconnect();
		if(urlPollTimer !== undefined){ window.clearInterval(urlPollTimer); }
		void closeBrowser();
	});

	return (
		<div class="browser-pane-content">
			<form class="browser-toolbar" onSubmit={event => { event.preventDefault(); void navigate(); }}>
				<button type="button" title="戻る" disabled={!browser || busy()} onClick={() => void historyAction("back")}>←</button>
				<button type="button" title="進む" disabled={!browser || busy()} onClick={() => void historyAction("forward")}>→</button>
				<button type="button" title="再読込" disabled={!browser || busy()} onClick={() => void historyAction("reload")}>↻</button>
				<input
					type="url"
					value={urlDraft()}
					onInput={event => setUrlDraft(event.currentTarget.value)}
					aria-label="Browser URL"
					spellcheck={false}
				/>
				<button type="submit" disabled={busy()}>{busy() ? "..." : "開く"}</button>
				<button type="button" disabled={!props.active || !browser} onClick={() => void browser?.setFocus()}>Focus</button>
			</form>
			<div ref={slot} class="browser-webview-slot">
				<span>{busy() ? "Browserを起動中..." : currentUrl()}</span>
			</div>
		</div>
	);
}
