mod documents;
mod library;
mod stats;

use library::{
    clear_conversion_cache, clear_document_annotations, delete_annotation, list_annotations,
    open_document, open_library, read_asset, read_document_range, read_epub_asset,
    read_pdf_reading_mode, refresh_library, retry_document_index, search_documents,
    upsert_annotation, AppState,
};
use stats::{list_reading_sessions, record_reading_session, StatsState};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let cache_directory = app.path().app_cache_dir()?;
            let state = AppState::new(cache_directory).map_err(std::io::Error::other)?;
            app.manage(state);
            // Reading statistics persist in app_data_dir, away from the
            // disposable conversion cache in app_cache_dir.
            let data_directory = app.path().app_data_dir()?;
            let stats_state = StatsState::new(data_directory).map_err(std::io::Error::other)?;
            app.manage(stats_state);
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
            list_annotations,
            upsert_annotation,
            delete_annotation,
            clear_document_annotations,
            record_reading_session,
            list_reading_sessions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
