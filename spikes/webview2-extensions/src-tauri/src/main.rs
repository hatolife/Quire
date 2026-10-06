use std::fs;
use std::path::Path;
use tauri::{Manager, WebviewUrl};

fn write_extension_file(path: &Path, content: &str) -> Result<(), std::io::Error> {
	if fs::read_to_string(path).ok().as_deref() == Some(content){ return Ok(()); }
	fs::write(path, content)
}

fn main() {
	tauri::Builder::default()
		.setup(|app| {
			let app_data = app.path().app_local_data_dir()?;
			let extensions_root = app_data.join("extensions");
			let extension_dir = extensions_root.join("quire-spike");
			let profile_dir = app_data.join("webview2-profile");
			fs::create_dir_all(&extension_dir)?;
			fs::create_dir_all(&profile_dir)?;
			write_extension_file(&extension_dir.join("manifest.json"), include_str!("../../extension/manifest.json"))?;
			write_extension_file(&extension_dir.join("content.js"), include_str!("../../extension/content.js"))?;
			write_extension_file(&extension_dir.join("background.js"), include_str!("../../extension/background.js"))?;

			tauri::WebviewWindowBuilder::new(
				app,
				"browser",
				WebviewUrl::External("https://example.com".parse().expect("valid spike URL")),
			)
			.title("Quire WebView2 Extensions Spike")
			.inner_size(1100.0, 760.0)
			.browser_extensions_enabled(true)
			.extensions_path(extensions_root)
			.data_directory(profile_dir)
			.devtools(true)
			.build()?;
			Ok(())
		})
		.run(tauri::generate_context!())
		.expect("failed to run Quire WebView2 Extensions spike");
}
