mod documents;
mod library;

use library::{
    clear_conversion_cache, open_document, open_library, read_asset, read_document_range,
    read_epub_asset, read_pdf_reading_mode, refresh_library, retry_document_index,
    search_documents, AppState,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let cache_directory = app.path().app_cache_dir()?;
            let state = AppState::new(cache_directory).map_err(std::io::Error::other)?;
            app.manage(state);
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_library,
            refresh_library,
            open_document,
            read_document_range,
            read_pdf_reading_mode,
            read_epub_asset,
            search_documents,
            retry_document_index,
            clear_conversion_cache,
            read_asset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
