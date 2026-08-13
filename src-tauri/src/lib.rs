mod documents;
mod library;
mod links;
mod stats;
mod transfer;
mod user_store;

use library::{
    clear_conversion_cache, find_related_passages, list_document_extents, list_document_links,
    open_document, open_library, probe_library_path, read_asset, read_document_range,
    read_epub_asset, read_pdf_reading_mode, refresh_library, retry_document_index,
    search_documents, AppState,
};
use stats::{list_reading_sessions, record_reading_session, StatsState};
use tauri::Manager;
use transfer::{export_annotations_file, pick_annotations_import_file};
use user_store::{
    add_collection_item, clear_document_annotations, create_collection, delete_annotation,
    delete_collection, detect_moved_documents, import_annotations, list_annotations,
    list_annotations_for_transfer, list_collection_items, list_collections,
    list_document_fingerprints, list_review_queue, rebind_document_annotations,
    record_review_outcome, remove_collection_item, rename_collection, reorder_collection_items,
    review_summary, search_annotations, upsert_annotation, UserState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let cache_directory = app.path().app_cache_dir()?;
            // The durable user database must open first: its initial
            // migration rescues annotations out of the legacy cache file
            // before the cache's "schema mismatch → rebuild" policy gets a
            // chance to delete them.
            let user_state =
                UserState::new(cache_directory.clone()).map_err(std::io::Error::other)?;
            app.manage(user_state);
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
            probe_library_path,
            refresh_library,
            open_document,
            read_document_range,
            read_pdf_reading_mode,
            read_epub_asset,
            search_documents,
            list_document_extents,
            list_document_links,
            find_related_passages,
            retry_document_index,
            clear_conversion_cache,
            read_asset,
            list_annotations,
            upsert_annotation,
            delete_annotation,
            clear_document_annotations,
            detect_moved_documents,
            rebind_document_annotations,
            list_review_queue,
            record_review_outcome,
            review_summary,
            search_annotations,
            list_collections,
            create_collection,
            rename_collection,
            delete_collection,
            list_collection_items,
            add_collection_item,
            remove_collection_item,
            reorder_collection_items,
            list_annotations_for_transfer,
            list_document_fingerprints,
            import_annotations,
            export_annotations_file,
            pick_annotations_import_file,
            record_reading_session,
            list_reading_sessions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
