(() => {
	const markerId = "quire-extension-spike-marker";
	if(document.getElementById(markerId)){ return; }

	const marker = document.createElement("div");
	marker.id = markerId;
	marker.textContent = "Quire WebView2 extension: content script active";
	Object.assign(marker.style, {
		position: "fixed",
		top: "0",
		left: "0",
		right: "0",
		zIndex: "2147483647",
		padding: "10px 14px",
		background: "#202020",
		color: "#ffffff",
		font: "14px system-ui, sans-serif",
		textAlign: "center",
	});
	document.documentElement.dataset.quireExtensionSpike = "active";
	document.body.appendChild(marker);

	chrome.storage.local.set({
		lastContentScriptUrl: location.href,
		lastContentScriptAt: new Date().toISOString(),
	});
})();
