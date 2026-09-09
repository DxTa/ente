import {
    LocalCollections,
    LocalEnteFile,
    localForage,
    LocalTimestamp,
    transformFileIfNeeded,
} from "ente-gallery/services/files-db";
import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { z } from "zod";
import type { TrashItem } from "./trash";

export const savedCollections = async (): Promise<Collection[]> =>
    LocalCollections.parse((await localForage.getItem("collections")) ?? []);

export const saveCollections = async (collections: Collection[]) => {
    await localForage.setItem("collections", collections);
};

export const savedCollectionsUpdationTime = async () =>
    LocalTimestamp.parse(await localForage.getItem("collection-updation-time"));

export const saveCollectionsUpdationTime = async (time: number) => {
    await localForage.setItem("collection-updation-time", time);
};

const TrashItemCollectionKey = z.object({ id: z.number(), key: z.string() });

const TrashItemCollectionKeys = TrashItemCollectionKey.array();

export type TrashItemCollectionKey = z.infer<typeof TrashItemCollectionKey>;

export const savedTrashItemCollectionKeys = async (): Promise<
    TrashItemCollectionKey[]
> =>
    TrashItemCollectionKeys.parse(
        // Historical name; this stores every collection key still used by trash.
        (await localForage.getItem("deleted-collection")) ?? [],
    );

export const saveTrashItemCollectionKeys = async (
    cks: TrashItemCollectionKey[],
) => {
    await localForage.setItem("deleted-collection", cks);
};

const filesManifestKey = "files-v2:manifest";
const filesLegacyIgnoredKey = "files-v2:legacy-ignored";
const filesV2SyncCompleteKey = "files-v2:sync:v2:complete";
const filesChunkSize = 512;

const FileCollectionManifest = z.object({
    generation: z.string(),
    chunkCount: z.number().int().nonnegative(),
});

const FilesManifest = z.object({
    version: z.literal(2),
    collections: z.record(z.string(), FileCollectionManifest),
});

type FileCollectionManifest = z.infer<typeof FileCollectionManifest>;
type FilesManifest = z.infer<typeof FilesManifest>;

let fileGeneration = 0;

const newFileGeneration = () =>
    `${Date.now()}-${fileGeneration++}-${globalThis.crypto.randomUUID()}`;

const fileChunkKey = (
    collectionID: number,
    generation: string,
    chunkIndex: number,
) => `files-v2:${generation}:collection:${collectionID}:chunk:${chunkIndex}`;

const readFilesManifest = async (): Promise<FilesManifest | undefined> => {
    const parsed = FilesManifest.safeParse(
        await localForage.getItem(filesManifestKey),
    );
    return parsed.success ? parsed.data : undefined;
};

const generationReaders = new Map<string, number>();
const retiredGenerations = new Map<
    string,
    { collectionID: number; entry: FileCollectionManifest }
>();

const generationKey = (collectionID: number, generation: string) =>
    `${collectionID}:${generation}`;

const acquireGenerationReaders = (manifest: FilesManifest) => {
    const keys = Object.entries(manifest.collections).map(([id, entry]) =>
        generationKey(Number(id), entry.generation),
    );
    for (const key of keys)
        generationReaders.set(key, (generationReaders.get(key) ?? 0) + 1);
    return async () => {
        for (const key of keys) {
            const readers = (generationReaders.get(key) ?? 1) - 1;
            if (readers > 0) generationReaders.set(key, readers);
            else {
                generationReaders.delete(key);
                const retired = retiredGenerations.get(key);
                if (retired) {
                    retiredGenerations.delete(key);
                    await removeCollectionChunks(
                        retired.collectionID,
                        retired.entry,
                    );
                }
            }
        }
    };
};

const retireCollectionChunks = async (
    collectionID: number,
    entry: FileCollectionManifest,
) => {
    const key = generationKey(collectionID, entry.generation);
    if ((generationReaders.get(key) ?? 0) > 0) {
        retiredGenerations.set(key, { collectionID, entry });
        return;
    }
    await removeCollectionChunks(collectionID, entry);
};

const ignoreLegacyFilesIfNeeded = async () => {
    const legacyFilesIgnored = await localForage.getItem(filesLegacyIgnoredKey);
    const keys = await localForage.keys();
    const hasLegacyFiles =
        keys.includes("files") || keys.includes("hidden-files");
    const keysToRemove = keys.filter(
        (key) =>
            /^-?\d+-time$/.test(key) ||
            /^files-v2:sync:v\d+:collection:-?\d+$/.test(key) ||
            /^files-v2:sync:v\d+:complete$/.test(key) ||
            key == "files" ||
            key == "hidden-files" ||
            key == "files-v2:remote-reconciled" ||
            key == "hidden-collection-ids",
    );
    if (!legacyFilesIgnored && !hasLegacyFiles && keysToRemove.length == 0)
        return;

    // Publish the marker only after cleanup succeeds so a failed cleanup is
    // retried on the next startup. Also clear stale sync times when a previous
    // migration marker exists but the v2 manifest is gone or invalid.
    await Promise.all(keysToRemove.map((key) => localForage.removeItem(key)));
    if (!legacyFilesIgnored)
        await localForage.setItem(filesLegacyIgnoredKey, true);
};

const writeCollectionChunks = async (
    collectionID: number,
    files: EnteFile[],
): Promise<FileCollectionManifest> => {
    const generation = newFileGeneration();
    const chunkCount = Math.ceil(files.length / filesChunkSize);

    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
        const start = chunkIndex * filesChunkSize;
        const chunk = files
            .slice(start, start + filesChunkSize)
            .map(transformFileIfNeeded);
        await localForage.setItem(
            fileChunkKey(collectionID, generation, chunkIndex),
            chunk,
        );
    }

    return { generation, chunkCount };
};

const removeCollectionChunks = async (
    collectionID: number,
    entry: FileCollectionManifest,
) => {
    for (let chunkIndex = 0; chunkIndex < entry.chunkCount; chunkIndex++)
        await localForage.removeItem(
            fileChunkKey(collectionID, entry.generation, chunkIndex),
        );
};

let orphanSweepQueued = false;
const ensureOrphanChunksSwept = async () => {
    if (orphanSweepQueued) {
        await fileManifestWrite;
        return;
    }
    orphanSweepQueued = true;
    const sweep = fileManifestWrite.then(async () => {
        const manifest = await readFilesManifest();
        if (!manifest) return;

        const liveKeys = new Set(
            Object.entries(manifest.collections).flatMap(([id, entry]) =>
                Array.from({ length: entry.chunkCount }, (_, index) =>
                    fileChunkKey(Number(id), entry.generation, index),
                ),
            ),
        );
        const chunkPattern = /^files-v2:(.+):collection:(-?\d+):chunk:\d+$/;
        const keys = await localForage.keys();
        await Promise.all(
            keys
                .filter((key) => {
                    if (liveKeys.has(key)) return false;
                    const match = chunkPattern.exec(key);
                    if (!match) return false;
                    const [, generation, collectionID] = match;
                    if (!generation || !collectionID) return false;
                    return !retiredGenerations.has(
                        generationKey(Number(collectionID), generation),
                    );
                })
                .map((key) => localForage.removeItem(key)),
        );
    });
    fileManifestWrite = sweep.then(
        () => {
            orphanSweepQueued = false;
        },
        () => {
            orphanSweepQueued = false;
        },
    );
    await sweep;
};

const saveCollectionFileGroupsUnsafe = async (
    groups: ReadonlyMap<number, EnteFile[]>,
    replaceAll: boolean,
) => {
    const previousManifest = await readFilesManifest();
    const previousCollections = previousManifest?.collections ?? {};
    const nextCollections: Record<string, FileCollectionManifest> = replaceAll
        ? {}
        : { ...previousCollections };

    for (const [collectionID, files] of groups) {
        const key = collectionID.toString();
        if (files.length == 0) Reflect.deleteProperty(nextCollections, key);
        else
            nextCollections[key] = await writeCollectionChunks(
                collectionID,
                files,
            );
    }

    await localForage.setItem(filesManifestKey, {
        version: 2,
        collections: nextCollections,
    });

    for (const [collectionID, previousEntry] of Object.entries(
        previousCollections,
    )) {
        const nextEntry = nextCollections[collectionID];
        if (nextEntry?.generation != previousEntry.generation)
            await retireCollectionChunks(Number(collectionID), previousEntry);
    }
};

let fileManifestWrite = Promise.resolve();

const enqueueFileManifestWrite = <T>(operation: () => Promise<T>) => {
    const write = fileManifestWrite.then(operation);
    fileManifestWrite = write.then(
        () => undefined,
        () => undefined,
    );
    return write;
};

const saveCollectionFileGroups = (
    groups: ReadonlyMap<number, EnteFile[]>,
    replaceAll: boolean,
) =>
    enqueueFileManifestWrite(() =>
        saveCollectionFileGroupsUnsafe(groups, replaceAll),
    );

export const prepareV2RemoteFileSync = () =>
    enqueueFileManifestWrite(ignoreLegacyFilesIfNeeded);

const collectionFileChunks = async function* (manifest: FilesManifest) {
    const release = acquireGenerationReaders(manifest);
    try {
        for (const [collectionID, entry] of Object.entries(
            manifest.collections,
        )) {
            for (
                let chunkIndex = 0;
                chunkIndex < entry.chunkCount;
                chunkIndex++
            ) {
                const chunk = await localForage.getItem<EnteFile[]>(
                    fileChunkKey(
                        Number(collectionID),
                        entry.generation,
                        chunkIndex,
                    ),
                );
                if (chunk) {
                    for (
                        let start = 0;
                        start < chunk.length;
                        start += filesChunkSize
                    )
                        yield chunk
                            .slice(start, start + filesChunkSize)
                            .map(transformFileIfNeeded);
                }
            }
        }
    } finally {
        await release();
    }
};

const loadSavedCollectionFiles = async (
    manifest: FilesManifest | undefined,
): Promise<EnteFile[]> => {
    if (!manifest) {
        // Never deserialize the legacy monolithic record. The next remote pull
        // starts from scratch after its per-collection sync times are cleared.
        await ignoreLegacyFilesIfNeeded();
        return [];
    }

    const files: EnteFile[] = [];
    for await (const chunk of collectionFileChunks(manifest))
        files.push(...chunk);
    return files;
};

export const savedCollectionFileChunks = async function* () {
    await ensureOrphanChunksSwept();
    await fileManifestWrite;
    const manifest = await readFilesManifest();
    if (!manifest) {
        await ignoreLegacyFilesIfNeeded();
        return;
    }

    for await (const chunk of collectionFileChunks(manifest)) yield chunk;
};

export const savedCollectionFileCollectionIDs = async (): Promise<number[]> => {
    await fileManifestWrite;
    const manifest = await readFilesManifest();
    return manifest ? Object.keys(manifest.collections).map(Number) : [];
};

export const savedCollectionFileChunksForCollections = async function* (
    collectionIDs: number[],
) {
    await ensureOrphanChunksSwept();
    await fileManifestWrite;
    const manifest = await readFilesManifest();
    if (!manifest) return;

    const requestedIDs = new Set(collectionIDs.map(String));
    const collections = Object.fromEntries(
        Object.entries(manifest.collections).filter(([id]) =>
            requestedIDs.has(id),
        ),
    );
    for await (const chunk of collectionFileChunks({ version: 2, collections }))
        yield chunk;
};

export const savedCollectionFilesForCollection = async (
    collectionID: number,
): Promise<EnteFile[]> => {
    const files: EnteFile[] = [];
    for await (const chunk of savedCollectionFileChunksForCollections([
        collectionID,
    ]))
        files.push(...chunk);
    return files;
};

export const savedCollectionFileByID = async (
    collectionID: number,
    fileID: number,
): Promise<EnteFile | undefined> => {
    for await (const chunk of savedCollectionFileChunksForCollections([
        collectionID,
    ])) {
        const file = chunk.find(({ id }) => id == fileID);
        if (file) return file;
    }
    return undefined;
};

export const savedCollectionFiles = async (): Promise<EnteFile[]> => {
    await ensureOrphanChunksSwept();
    await fileManifestWrite;
    const manifest = await readFilesManifest();
    if (!manifest) return loadSavedCollectionFiles(manifest);

    return loadSavedCollectionFiles(manifest);
};

export const saveCollectionFiles = async (files: EnteFile[]) => {
    const groups = new Map<number, EnteFile[]>();
    for (const file of files) {
        const collectionFiles = groups.get(file.collectionID) ?? [];
        collectionFiles.push(file);
        groups.set(file.collectionID, collectionFiles);
    }
    await saveCollectionFileGroups(groups, true);
};

export const saveCollectionFilesForCollection = async (
    collectionID: number,
    files: EnteFile[],
) => {
    await saveCollectionFileGroups(new Map([[collectionID, files]]), false);
};

const mergeCollectionFilesForCollectionUnsafe = async (
    collectionID: number,
    updatedFiles: EnteFile[],
    deletedFileIDs: number[],
) => {
    const manifest = await readFilesManifest();
    const key = collectionID.toString();
    const previousEntry = manifest?.collections[key];
    const generation = newFileGeneration();
    const updatedByID = new Map(updatedFiles.map((file) => [file.id, file]));
    const deletedIDs = new Set(deletedFileIDs);
    let chunkIndex = 0;
    let pendingFiles: EnteFile[] = [];
    const changedFiles: EnteFile[] = [];
    const removedFileIDs: number[] = [];

    const flush = async () => {
        if (pendingFiles.length == 0) return;
        await localForage.setItem(
            fileChunkKey(collectionID, generation, chunkIndex++),
            pendingFiles.map(transformFileIfNeeded),
        );
        pendingFiles = [];
    };

    const append = async (file: EnteFile) => {
        if (deletedIDs.has(file.id)) {
            removedFileIDs.push(file.id);
            updatedByID.delete(file.id);
            return;
        }

        const replacement = updatedByID.get(file.id);
        if (replacement) {
            if (replacement.updationTime != file.updationTime)
                changedFiles.push(replacement);
            pendingFiles.push(replacement);
            updatedByID.delete(file.id);
        } else {
            pendingFiles.push(file);
        }
        if (pendingFiles.length == filesChunkSize) await flush();
    };

    if (previousEntry) {
        for await (const chunk of collectionFileChunks({
            version: 2,
            collections: { [key]: previousEntry },
        }))
            for (const file of chunk) await append(file);
    }

    for (const file of updatedByID.values()) {
        changedFiles.push(file);
        pendingFiles.push(file);
        if (pendingFiles.length == filesChunkSize) await flush();
    }
    await flush();

    const nextCollections = { ...(manifest?.collections ?? {}) };
    if (chunkIndex == 0) Reflect.deleteProperty(nextCollections, key);
    else nextCollections[key] = { generation, chunkCount: chunkIndex };

    await localForage.setItem(filesManifestKey, {
        version: 2,
        collections: nextCollections,
    });
    if (previousEntry)
        await retireCollectionChunks(collectionID, previousEntry);
    return { updatedFiles: changedFiles, deletedFileIDs: removedFileIDs };
};

export const mergeCollectionFilesForCollection = (
    collectionID: number,
    updatedFiles: EnteFile[],
    deletedFileIDs: number[],
) =>
    enqueueFileManifestWrite(() =>
        mergeCollectionFilesForCollectionUnsafe(
            collectionID,
            updatedFiles,
            deletedFileIDs,
        ),
    );

const invalidateV2RemoteFileSync = () =>
    localForage.removeItem(filesV2SyncCompleteKey);

export const hasCompletedV2RemoteFileSync = async () => {
    await fileManifestWrite;
    if ((await localForage.getItem(filesV2SyncCompleteKey)) !== true)
        return false;

    const manifest = await readFilesManifest();
    if (!manifest) {
        await invalidateV2RemoteFileSync();
        return false;
    }

    for (const [collectionID, entry] of Object.entries(manifest.collections)) {
        for (let chunkIndex = 0; chunkIndex < entry.chunkCount; chunkIndex++) {
            const chunk = await localForage.getItem<unknown>(
                fileChunkKey(
                    Number(collectionID),
                    entry.generation,
                    chunkIndex,
                ),
            );
            if (!Array.isArray(chunk)) {
                await invalidateV2RemoteFileSync();
                return false;
            }
        }
    }

    return true;
};

export const ensureV2FileManifest = () =>
    enqueueFileManifestWrite(async () => {
        if (!(await readFilesManifest()))
            await localForage.setItem(filesManifestKey, {
                version: 2,
                collections: {},
            });
    });

export const markV2RemoteFileSyncComplete = () =>
    enqueueFileManifestWrite(() =>
        localForage.setItem(filesV2SyncCompleteKey, true),
    );

export const removeCollectionFilesForCollections = async (
    collectionIDs: number[],
) => {
    if (collectionIDs.length == 0) return;
    await saveCollectionFileGroups(
        new Map(collectionIDs.map((id) => [id, [] as EnteFile[]])),
        false,
    );
};

const v2CollectionSyncTimeKey = (collectionID: number) =>
    `files-v2:sync:v2:collection:${collectionID}`;

export const savedCollectionLastSyncTime = async (collection: Collection) =>
    LocalTimestamp.parse(
        await localForage.getItem(v2CollectionSyncTimeKey(collection.id)),
    );

export const saveCollectionLastSyncTime = async (
    collection: Collection,
    time: number,
) => {
    await localForage.setItem(v2CollectionSyncTimeKey(collection.id), time);
};

export const removeCollectionIDLastSyncTime = async (collectionID: number) => {
    await localForage.removeItem(v2CollectionSyncTimeKey(collectionID));
};

const LocalTrashItem = z.looseObject({
    file: LocalEnteFile,
    updatedAt: z.number(),
    deleteBy: z.number(),
});

export const savedTrashItems = async (): Promise<TrashItem[]> =>
    LocalTrashItem.array().parse(
        (await localForage.getItem("file-trash")) ?? [],
    );

export const saveTrashItems = async (trashItems: TrashItem[]) => {
    await localForage.setItem("file-trash", trashItems);
};

export const savedTrashLastUpdatedAt = async (): Promise<number | undefined> =>
    LocalTimestamp.parse(await localForage.getItem("trash-time"));

export const saveTrashLastUpdatedAt = async (updatedAt: number) => {
    await localForage.setItem("trash-time", updatedAt);
};
