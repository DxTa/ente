import { beforeEach, describe, expect, test, vi } from "vitest";

const store = vi.hoisted(() => {
    const data = new Map<string, unknown>();
    return {
        data,
        config: vi.fn(),
        getItem: vi.fn((key: string) => Promise.resolve(data.get(key))),
        setItem: vi.fn((key: string, value: unknown) => {
            data.set(key, value);
            return Promise.resolve(value);
        }),
        removeItem: vi.fn((key: string) => {
            data.delete(key);
            return Promise.resolve();
        }),
        keys: vi.fn(() => Promise.resolve([...data.keys()])),
    };
});

vi.mock("localforage", () => ({ default: store }));

import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import {
    hasCompletedV2RemoteFileSync,
    mergeCollectionFilesForCollection,
    prepareV2RemoteFileSync,
    saveCollectionFiles,
    saveCollectionFilesForCollection,
    saveCollectionLastSyncTime,
    savedCollectionFileChunks,
    savedCollectionFiles,
} from "ente-new/photos/services/photos-fdb";

const file = (id: number, collectionID: number): EnteFile => ({
    id,
    collectionID,
    ownerID: 1,
    key: "key",
    file: { decryptionHeader: "header" },
    thumbnail: { decryptionHeader: "header" },
    updationTime: 1,
    metadata: {
        fileType: 1,
        modificationTime: 1,
        title: "file",
        creationTime: 1,
    },
});

const resetStoreMocks = () => {
    store.getItem.mockImplementation((key: string) =>
        Promise.resolve(store.data.get(key)),
    );
    store.setItem.mockImplementation((key: string, value: unknown) => {
        store.data.set(key, value);
        return Promise.resolve(value);
    });
    store.removeItem.mockImplementation((key: string) => {
        store.data.delete(key);
        return Promise.resolve();
    });
    store.keys.mockImplementation(() =>
        Promise.resolve([...store.data.keys()]),
    );
};

describe("collection file persistence", () => {
    beforeEach(() => {
        store.data.clear();
        vi.clearAllMocks();
        resetStoreMocks();
    });

    test("bounds chunks yielded to gallery hydration", async () => {
        const generation = "legacy";
        store.data.set("files-v2:manifest", {
            version: 2,
            collections: { "10": { generation, chunkCount: 1 } },
        });
        store.data.set(
            `files-v2:${generation}:collection:10:chunk:0`,
            Array.from({ length: 513 }, (_, id) => file(id, 10)),
        );

        const chunks: EnteFile[][] = [];
        for await (const chunk of savedCollectionFileChunks())
            chunks.push(chunk);

        expect(chunks.map((chunk) => chunk.length)).toEqual([512, 1]);
    });

    test("round trips collection files without a monolithic record", async () => {
        const files = [file(1, 10), file(2, 20)];

        await saveCollectionFiles(files);

        expect(store.data.has("files")).toBe(false);
        const manifest = store.data.get("files-v2:manifest") as {
            version: number;
            collections: Record<string, { chunkCount: number }>;
        };
        expect(manifest.version).toBe(2);
        expect(manifest.collections["10"]?.chunkCount).toBe(1);
        expect(manifest.collections["20"]?.chunkCount).toBe(1);
        await expect(savedCollectionFiles()).resolves.toEqual(files);
    });

    test("does not retain loaded files across reads", async () => {
        const files = [file(1, 10)];
        await saveCollectionFiles(files);

        const first = await savedCollectionFiles();
        const second = await savedCollectionFiles();

        expect(second).toEqual(first);
        expect(second).not.toBe(first);

        await saveCollectionFilesForCollection(10, [file(2, 10)]);
        await expect(savedCollectionFiles()).resolves.toEqual([file(2, 10)]);
    });

    test("streams v2 chunks without assembling a second full array", async () => {
        const files = [file(1, 10), file(2, 20)];
        await saveCollectionFiles(files);

        const chunks: EnteFile[][] = [];
        for await (const chunk of savedCollectionFileChunks())
            chunks.push(chunk);

        expect(chunks.flat()).toEqual(files);
        expect(chunks).toHaveLength(2);
    });

    test("repeats orphan cleanup after a successful sweep", async () => {
        store.data.set("files-v2:manifest", { version: 2, collections: {} });
        store.data.set("files-v2:g1:collection:10:chunk:0", [file(1, 10)]);

        const firstRead = savedCollectionFileChunks();
        await expect(firstRead.next()).resolves.toEqual({ done: true });
        expect(store.data.has("files-v2:g1:collection:10:chunk:0")).toBe(false);

        store.data.set("files-v2:g2:collection:20:chunk:0", [file(2, 20)]);
        const secondRead = savedCollectionFileChunks();
        await expect(secondRead.next()).resolves.toEqual({ done: true });
        expect(store.data.has("files-v2:g2:collection:20:chunk:0")).toBe(false);
    });

    test("cleans legacy records before V2 repair", async () => {
        store.data.set("files", [file(1, 10)]);
        store.data.set("hidden-files", [file(2, 20)]);
        store.data.set("10-time", 123);
        store.data.set("files-v2:sync:v2:complete", true);

        await prepareV2RemoteFileSync();

        expect(store.data.has("files")).toBe(false);
        expect(store.data.has("hidden-files")).toBe(false);
        expect(store.data.has("10-time")).toBe(false);
        expect(store.data.has("files-v2:sync:v2:complete")).toBe(false);
        expect(store.data.has("files-v2:legacy-ignored")).toBe(true);
    });

    test("reads v2 chunks without requesting the monolithic files record", async () => {
        store.data.set("files-v2:manifest", {
            version: 2,
            collections: { "10": { generation: "g1", chunkCount: 1 } },
        });
        store.data.set("files-v2:g1:collection:10:chunk:0", [file(1, 10)]);

        await expect(savedCollectionFiles()).resolves.toEqual([file(1, 10)]);
        expect(store.getItem).not.toHaveBeenCalledWith("files");
    });

    test("merges remote changes without loading full collection", async () => {
        await saveCollectionFiles([file(1, 10), file(2, 10), file(3, 20)]);

        const merged = await mergeCollectionFilesForCollection(
            10,
            [file(4, 10)],
            [1],
        );

        expect(merged.updatedFiles).toEqual([file(4, 10)]);
        expect(merged.deletedFileIDs).toEqual([1]);
        await expect(savedCollectionFiles()).resolves.toEqual([
            file(2, 10),
            file(4, 10),
            file(3, 20),
        ]);
    });

    test("serializes collection replacement without deleting siblings", async () => {
        await saveCollectionFiles([file(1, 10), file(2, 20)]);

        await Promise.all([
            saveCollectionFilesForCollection(10, [file(3, 10)]),
            saveCollectionFilesForCollection(20, [file(4, 20)]),
        ]);
        await expect(savedCollectionFiles()).resolves.toEqual([
            file(3, 10),
            file(4, 20),
        ]);

        await saveCollectionFilesForCollection(10, []);
        await expect(savedCollectionFiles()).resolves.toEqual([file(4, 20)]);
    });

    test("transforms only legacy entries within a chunk", async () => {
        const legacy = {
            ...file(1, 10),
            metadata: { ...file(1, 10).metadata, modificationTime: undefined },
        } as unknown as EnteFile;
        const clean = file(2, 10);

        await saveCollectionFiles([legacy, clean]);
        const manifest = store.data.get("files-v2:manifest") as {
            collections: Record<string, { generation: string }>;
        };
        const generation = manifest.collections["10"]!.generation;
        const chunk = store.data.get(
            `files-v2:${generation}:collection:10:chunk:0`,
        ) as EnteFile[];

        expect(chunk[0]).not.toBe(legacy);
        expect(chunk[1]).toBe(clean);
    });

    test("ignores legacy files without loading the monolithic value", async () => {
        store.data.set("files", [file(1, 10)]);
        store.data.set("10-time", 123);

        await expect(savedCollectionFiles()).resolves.toEqual([]);
        expect(store.getItem).not.toHaveBeenCalledWith("files");
        expect(store.data.has("files-v2:legacy-ignored")).toBe(true);
        expect(store.data.has("10-time")).toBe(false);
    });

    test("retries legacy cleanup after a removal failure", async () => {
        store.data.set("files", [file(1, 10)]);
        store.data.set("10-time", 123);
        let shouldFail = true;
        store.removeItem.mockImplementation((key) => {
            if (shouldFail && key == "10-time")
                throw new Error("cleanup failed");
            store.data.delete(key);
            return Promise.resolve();
        });

        await expect(savedCollectionFiles()).rejects.toThrow("cleanup failed");
        expect(store.data.has("files-v2:legacy-ignored")).toBe(false);

        shouldFail = false;
        await expect(savedCollectionFiles()).resolves.toEqual([]);
        expect(store.data.has("files-v2:legacy-ignored")).toBe(true);
        expect(store.data.has("10-time")).toBe(false);
    });

    test("resets sync times when a migrated manifest disappears", async () => {
        store.data.set("files-v2:legacy-ignored", true);
        store.data.set("files-v2:sync:v2:collection:10", 123);
        store.data.set("files-v2:sync:v2:complete", true);
        store.data.set("files-v2:remote-reconciled", true);

        await expect(savedCollectionFiles()).resolves.toEqual([]);
        expect(store.data.has("files-v2:legacy-ignored")).toBe(true);
        expect(store.data.has("files-v2:sync:v2:collection:10")).toBe(false);
        expect(store.data.has("files-v2:sync:v2:complete")).toBe(false);
        expect(store.data.has("files-v2:remote-reconciled")).toBe(false);
    });

    test("ignores the hidden-files legacy key without loading it", async () => {
        store.data.set("hidden-files", [file(1, 10)]);
        store.data.set("hidden-collection-ids", [10]);
        store.data.set("10-time", 123);

        await expect(savedCollectionFiles()).resolves.toEqual([]);
        expect(store.getItem).not.toHaveBeenCalledWith("hidden-files");
        expect(store.data.has("files-v2:legacy-ignored")).toBe(true);
        expect(store.data.has("hidden-collection-ids")).toBe(false);
        expect(store.data.has("10-time")).toBe(false);
    });

    test("keeps the previous manifest when publishing a new one fails", async () => {
        await saveCollectionFiles([file(1, 10)]);
        const previousManifest = store.data.get("files-v2:manifest");
        store.setItem.mockImplementation((key, value) => {
            if (key == "files-v2:manifest") throw new Error("write failed");
            store.data.set(key, value);
            return Promise.resolve(value);
        });

        await expect(saveCollectionFiles([file(2, 10)])).rejects.toThrow(
            "write failed",
        );
        expect(store.data.get("files-v2:manifest")).toEqual(previousManifest);
        await expect(savedCollectionFiles()).resolves.toEqual([file(1, 10)]);
    });

    test("keeps the previous manifest when a chunk write fails", async () => {
        await saveCollectionFiles([file(1, 10)]);
        const previousManifest = store.data.get("files-v2:manifest");
        store.setItem.mockImplementation((key, value) => {
            if (key.startsWith("files-v2:") && key != "files-v2:manifest")
                throw new Error("chunk write failed");
            store.data.set(key, value);
            return Promise.resolve(value);
        });

        await expect(saveCollectionFiles([file(2, 10)])).rejects.toThrow(
            "chunk write failed",
        );
        expect(store.data.get("files-v2:manifest")).toEqual(previousManifest);
        await expect(savedCollectionFiles()).resolves.toEqual([file(1, 10)]);
    });

    test("does not trust the previous V2 sync generation", async () => {
        store.data.set("files-v2:sync:v1:complete", true);

        await expect(hasCompletedV2RemoteFileSync()).resolves.toBe(false);
    });

    test("invalidates completion when the manifest is missing", async () => {
        store.data.set("files-v2:sync:v2:complete", true);

        await expect(hasCompletedV2RemoteFileSync()).resolves.toBe(false);
        expect(store.data.has("files-v2:sync:v2:complete")).toBe(false);
    });

    test("invalidates completion when a declared chunk is missing", async () => {
        store.data.set("files-v2:sync:v2:complete", true);
        store.data.set("files-v2:manifest", {
            version: 2,
            collections: { "10": { generation: "g1", chunkCount: 1 } },
        });

        await expect(hasCompletedV2RemoteFileSync()).resolves.toBe(false);
        expect(store.data.has("files-v2:sync:v2:complete")).toBe(false);
    });

    test("invalidates completion when a declared chunk is malformed", async () => {
        store.data.set("files-v2:sync:v2:complete", true);
        store.data.set("files-v2:manifest", {
            version: 2,
            collections: { "10": { generation: "g1", chunkCount: 1 } },
        });
        store.data.set("files-v2:g1:collection:10:chunk:0", { invalid: true });

        await expect(hasCompletedV2RemoteFileSync()).resolves.toBe(false);
        expect(store.data.has("files-v2:sync:v2:complete")).toBe(false);
    });

    test("accepts a complete empty V2 manifest", async () => {
        store.data.set("files-v2:sync:v2:complete", true);
        store.data.set("files-v2:manifest", { version: 2, collections: {} });

        await expect(hasCompletedV2RemoteFileSync()).resolves.toBe(true);
    });

    test("uses V2-specific sync cursors", async () => {
        await saveCollectionLastSyncTime({ id: 10 } as Collection, 123);

        expect(store.data.get("files-v2:sync:v2:collection:10")).toBe(123);
        expect(store.data.has("10-time")).toBe(false);
    });

    test("keeps old generation until active reader releases it", async () => {
        await saveCollectionFiles([file(1, 10)]);
        const oldManifest = store.data.get("files-v2:manifest") as {
            collections: Record<string, { generation: string }>;
        };
        const oldGeneration = oldManifest.collections["10"]!.generation;
        const oldChunk = `files-v2:${oldGeneration}:collection:10:chunk:0`;
        let releaseChunk!: (value: EnteFile[]) => void;
        const oldChunkRead = new Promise<EnteFile[]>((resolve) => {
            releaseChunk = resolve;
        });
        let resolveChunkReadStarted!: () => void;
        const chunkReadStarted = new Promise<void>((resolve) => {
            resolveChunkReadStarted = resolve;
        });
        store.getItem.mockImplementation((key) => {
            if (key == oldChunk) {
                resolveChunkReadStarted();
                return oldChunkRead;
            }
            return Promise.resolve(store.data.get(key));
        });

        const iterator = savedCollectionFileChunks();
        const firstChunk = iterator.next();
        await chunkReadStarted;

        await saveCollectionFiles([file(2, 10)]);
        expect(store.data.has(oldChunk)).toBe(true);

        releaseChunk([file(1, 10)]);
        await expect(firstChunk).resolves.toEqual({
            done: false,
            value: [file(1, 10)],
        });
        await iterator.return();
        expect(store.data.has(oldChunk)).toBe(false);
    });

    test("removes old chunks only after publishing a replacement", async () => {
        await saveCollectionFiles([file(1, 10)]);
        const oldManifest = store.data.get("files-v2:manifest") as {
            collections: Record<string, { generation: string }>;
        };
        const oldGeneration = oldManifest.collections["10"]!.generation;
        const oldChunk = `files-v2:${oldGeneration}:collection:10:chunk:0`;

        await saveCollectionFiles([file(2, 10)]);
        const newManifest = store.data.get("files-v2:manifest") as {
            collections: Record<string, { generation: string }>;
        };
        expect(newManifest.collections["10"]?.generation).not.toBe(
            oldGeneration,
        );
        expect(store.data.has(oldChunk)).toBe(false);
        await expect(savedCollectionFiles()).resolves.toEqual([file(2, 10)]);
    });
});
