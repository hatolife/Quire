use std::fs;
use std::path::{Path, PathBuf};
use tauri::{Manager, WebviewUrl};

fn extension_dir() -> Result<PathBuf, std::io::Error> {
	let exe = std::env::current_exe()?;
	let exe_dir = exe.parent().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "実行ファイルのディレクトリを取得できなかった。"))?;
	let adjacent = exe_dir.join("extension");
	if adjacent.is_dir(){ return Ok(adjacent); }

	let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("extension");
	if source.is_dir(){ return Ok(source); }

	Err(std::io::Error::new(std::io::ErrorKind::NotFound, format!("WebView2 extensionディレクトリが見つからない。EXE横にextensionフォルダを配置すること。exe={}", exe.display())))
}

fn main() {
	tauri::Builder::default()
		.setup(|app| {
			let extension_dir = extension_dir()?;
			let profile_dir = app.path().app_local_data_dir()?.join("webview2-profile");
			fs::create_dir_all(&profile_dir)?;
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
