mod diagnostics;
mod documents;
mod library;
mod library_paths;
mod links;
mod sqlite_io;
mod stats;
mod storage_migration;
mod transfer;
mod user_store;

use crate::diagnostics::{
    apply_pending_restore, create_local_backup, export_diagnostic_report, local_data_status,
    stage_local_restore, DataOpenHealth,
};
use library::{
    capture_read_snapshot, clear_conversion_cache, find_related_passages, list_document_extents,
    list_document_links, open_document, open_library, probe_library_path, read_asset,
    read_document_preview, read_document_range, read_document_thumbnail, read_epub_asset,
    read_pdf_reading_mode, read_snapshot_diff, refresh_library, retry_document_index,
    reveal_in_file_manager, search_documents, store_document_thumbnail, AppState, CommandResult,
};
use stats::{list_reading_sessions, record_reading_session, start_reading_session, StatsState};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use transfer::{export_annotations_file, pick_annotations_import_file};
use user_store::{
    add_collection_item, clear_document_annotations, create_collection, create_excerpt,
    create_reading_place, delete_annotation, delete_annotation_entry, delete_collection,
    delete_reflection, detect_moved_documents, import_annotations, list_annotations,
    list_annotations_for_transfer, list_collection_items, list_collections,
    list_document_annotations, list_document_fingerprints, list_review_queue,
    rebind_document_annotations, record_excerpt_review_outcome, record_review_outcome,
    remove_collection_item, rename_collection, reorder_collection_items, restore_annotation_entry,
    restore_document_annotations, review_summary, search_annotation_entries, search_annotations,
    set_review_enrollment, update_excerpt_appearance, upsert_annotation, upsert_reflection,
    UserState,
};

/// D05 close coordination: the first close request is held while the
/// frontend flushes reading statistics (bounded by both the frontend wait
/// and the force-close timer below); the frontend then calls
/// `approve_window_close`. Implemented entirely in Rust so no window
/// capability has to be granted to the webview.
static CLOSE_APPROVED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Grants the pending close and destroys the main window.
#[tauri::command]
fn approve_window_close(app: AppHandle) -> CommandResult<()> {
    CLOSE_APPROVED.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        window
            .destroy()
            .map_err(|error| format!("Cannot close the window: {error}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let cache_directory = app.path().app_cache_dir()?;
            // The durable user database (D04: app_data_dir, away from the
            // disposable conversion cache) must open first: its location
            // migration and initial migration rescue annotations out of the
            // legacy cache files before the cache's "schema mismatch →
            // rebuild" policy gets a chance to delete them.
            let data_directory = app.path().app_data_dir()?;
            apply_pending_restore(&data_directory).map_err(std::io::Error::other)?;
            let mut user_open_error = None;
            let user_state = match UserState::new(data_directory.clone(), cache_directory.clone()) {
                Ok(state) => state,
                Err(error) => {
                    user_open_error = Some(error.clone());
                    UserState::unavailable(error, data_directory.join(user_store::USER_DB_FILE))
                        .map_err(std::io::Error::other)?
                }
            };
            app.manage(user_state);
            let state = AppState::new(cache_directory).map_err(std::io::Error::other)?;
            app.manage(state);
            // Reading statistics persist in app_data_dir, away from the
            // disposable conversion cache in app_cache_dir.
            let mut stats_open_error = None;
            let stats_state = match StatsState::new(data_directory.clone()) {
                Ok(state) => state,
                Err(error) => {
                    stats_open_error = Some(error.clone());
                    StatsState::unavailable(error, data_directory.join("reade-stats.sqlite3"))
                        .map_err(std::io::Error::other)?
                }
            };
            app.manage(stats_state);
            app.manage(DataOpenHealth::new(user_open_error, stats_open_error));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                use std::sync::atomic::Ordering;
                if CLOSE_APPROVED.load(Ordering::SeqCst) {
                    return;
                }
                // Hold the close, ask the frontend to flush, and force the
                // close if the frontend never answers (crash/hang guard).
                api.prevent_close();
                let _ = window.emit("reade-close-requested", ());
                let window = window.clone();
                // A plain thread keeps the async runtime free and needs no
                // extra dependency; `destroy` proxies to the main thread.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    if !CLOSE_APPROVED.load(Ordering::SeqCst) {
                        CLOSE_APPROVED.store(true, Ordering::SeqCst);
                        let _ = window.destroy();
                    }
                });
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_library,
            probe_library_path,
            refresh_library,
            reveal_in_file_manager,
            open_document,
            read_document_range,
            read_pdf_reading_mode,
            read_epub_asset,
            search_documents,
            list_document_extents,
            read_document_thumbnail,
            store_document_thumbnail,
            capture_read_snapshot,
            read_snapshot_diff,
            list_document_links,
            read_document_preview,
            find_related_passages,
            retry_document_index,
            clear_conversion_cache,
            read_asset,
            list_annotations,
            upsert_annotation,
            delete_annotation,
            clear_document_annotations,
            restore_document_annotations,
            list_document_annotations,
            create_excerpt,
            update_excerpt_appearance,
            create_reading_place,
            upsert_reflection,
            delete_reflection,
            delete_annotation_entry,
            restore_annotation_entry,
            set_review_enrollment,
            detect_moved_documents,
            rebind_document_annotations,
            list_review_queue,
            record_review_outcome,
            record_excerpt_review_outcome,
            review_summary,
            search_annotations,
            search_annotation_entries,
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
            start_reading_session,
            approve_window_close,
            local_data_status,
            create_local_backup,
            stage_local_restore,
            export_diagnostic_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
