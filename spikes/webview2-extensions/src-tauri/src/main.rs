use std::path::PathBuf;
use tauri::WebviewUrl;

fn main() {
	tauri::Builder::default()
		.setup(|app| {
			let spike_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
			let extension_dir = spike_dir.join("extension");
			let profile_dir = spike_dir.join("profile");
			tauri::WebviewWindowBuilder::new(
				app,
				"browser",
				WebviewUrl::External("https://example.com".parse().expect("valid spike URL")),
			)
			.title("Quire WebView2 Extensions Spike")
			.inner_size(1100.0, 760.0)
			.browser_extensions_enabled(true)
			.extensions_path(extension_dir)
			.data_directory(profile_dir)
			.devtools(true)
			.build()?;
			Ok(())
		})
		.run(tauri::generate_context!())
		.expect("failed to run Quire WebView2 Extensions spike");
}
