import type { Annotation } from "./backend";

const DB_NAME = "reade-annotations";
const STORE_NAME = "annotations";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("relativePath", "relativePath", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Cannot open annotation store"));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Annotation request failed"));
  });
}

export async function listWebAnnotations(relativePath: string | null): Promise<Annotation[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  const matches = relativePath
    ? await requestToPromise(
        store.index("relativePath").getAll(relativePath) as IDBRequest<Annotation[]>,
      )
    : await requestToPromise(store.getAll() as IDBRequest<Annotation[]>);
  return matches.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export async function upsertWebAnnotation(annotation: Annotation): Promise<Annotation> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  await requestToPromise(tx.objectStore(STORE_NAME).put(annotation));
  return annotation;
}

export async function deleteWebAnnotation(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  await requestToPromise(tx.objectStore(STORE_NAME).delete(id));
}

export async function clearWebDocumentAnnotations(relativePath: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const index = store.index("relativePath");
  const matches = await requestToPromise(index.getAllKeys(relativePath) as IDBRequest<IDBValidKey[]>);
  await Promise.all(matches.map((key) => requestToPromise(store.delete(key))));
}
