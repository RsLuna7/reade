mod library;

use library::{
    open_library, read_asset, read_document, refresh_library, search_documents, AppState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new().expect("failed to initialize the in-memory search index"))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_library,
            refresh_library,
            read_document,
            search_documents,
            read_asset
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
