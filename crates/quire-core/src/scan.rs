use ignore::WalkBuilder;
use std::io;
use std::path::{Path, PathBuf};

pub(crate) fn workspace_files(root: &Path) -> Result<Vec<PathBuf>, io::Error> {
	let mut builder = WalkBuilder::new(root);
	builder
		.hidden(false)
		.ignore(false)
		.git_ignore(false)
		.git_global(false)
		.git_exclude(false)
		.parents(false)
		.add_custom_ignore_filename(".quireignore");

	let walker = builder.build();
	let mut files = Vec::new();
	for result in walker {
		let entry = result.map_err(ignore_error)?;
		if entry.depth() == 0 {
			continue;
		}
		let path = entry.path();
		if entry.file_type().is_some_and(|file_type| file_type.is_dir()) && entry.file_name() == ".git" {
			continue;
		}
		if path.components().any(|component| component.as_os_str() == ".git") {
			continue;
		}
		if entry.file_type().is_some_and(|file_type| file_type.is_file()) {
			files.push(path.to_path_buf());
		}
	}
	Ok(files)
}

pub(crate) fn markdown_files(root: &Path) -> Result<Vec<PathBuf>, io::Error> {
	let mut files = workspace_files(root)?;
	files.retain(|path| is_markdown(path));
	Ok(files)
}

fn is_markdown(path: &Path) -> bool {
	path.extension()
		.and_then(|extension| extension.to_str())
		.is_some_and(|extension| extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown"))
}

fn ignore_error(error: ignore::Error) -> io::Error {
	io::Error::new(io::ErrorKind::Other, error.to_string())
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;

	#[test]
	fn quireignore_filters_files_without_using_gitignore() {
		let temp = tempfile::tempdir().unwrap();
		fs::create_dir_all(temp.path().join("generated")).unwrap();
		fs::write(temp.path().join(".quireignore"), "generated/\nignored.md\n").unwrap();
		fs::write(temp.path().join(".gitignore"), "kept.md\n").unwrap();
		fs::write(temp.path().join("ignored.md"), "ignored").unwrap();
		fs::write(temp.path().join("kept.md"), "kept").unwrap();
		fs::write(temp.path().join("generated").join("nested.md"), "generated").unwrap();

		let files = workspace_files(temp.path()).unwrap();
		let relative = files
			.iter()
			.map(|path| path.strip_prefix(temp.path()).unwrap().to_string_lossy().replace('\\', "/"))
			.collect::<Vec<_>>();

		assert!(relative.contains(&".quireignore".to_string()));
		assert!(relative.contains(&".gitignore".to_string()));
		assert!(relative.contains(&"kept.md".to_string()));
		assert!(!relative.contains(&"ignored.md".to_string()));
		assert!(!relative.contains(&"generated/nested.md".to_string()));
	}

	#[test]
	fn markdown_files_return_only_unignored_markdown() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join(".quireignore"), "hidden.markdown\n").unwrap();
		fs::write(temp.path().join("note.md"), "note").unwrap();
		fs::write(temp.path().join("hidden.markdown"), "hidden").unwrap();
		fs::write(temp.path().join("asset.png"), b"png").unwrap();

		let files = markdown_files(temp.path()).unwrap();

		assert_eq!(files.len(), 1);
		assert!(files[0].ends_with("note.md"));
	}
}
