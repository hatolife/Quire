chrome.runtime.onInstalled.addListener(() => {
	chrome.storage.local.set({
		installedAt: new Date().toISOString(),
		serviceWorkerInstalled: true,
	});
});

chrome.runtime.onStartup.addListener(() => {
	chrome.storage.local.set({
		lastStartupAt: new Date().toISOString(),
		serviceWorkerStarted: true,
	});
});
