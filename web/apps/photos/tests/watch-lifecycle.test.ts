import type { FolderWatch } from "ente-base/types/ipc";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    updateSyncedFiles: vi.fn(),
    updateIgnoredFiles: vi.fn(),
}));

vi.mock("../src/services/upload-manager", () => ({
    uploadManager: { cancelRunningUpload: vi.fn() },
}));
vi.mock("ente-new/photos/services/ml", () => ({
    setMLClusterUpdatesDeferred: vi.fn(),
}));
vi.mock("ente-new/photos/services/collection", () => ({
    removeFromOwnCollection: vi.fn(() => undefined),
}));
vi.mock("ente-new/photos/services/file", () => ({
    computeAllCollectionFilesFromSaved: vi.fn(() => [
        { id: 1, collectionID: 2 },
    ]),
}));

const watch: FolderWatch = {
    folderPath: "/watched",
    collectionMapping: "parent",
    isAccessible: true,
    syncedFiles: [],
    ignoredFiles: [],
};

const onRemoveDir = vi.fn();
const electron = {
    logToDisk: vi.fn(),
    fs: { findFiles: vi.fn(() => []) },
    watch: {
        get: vi.fn(() => [watch]),
        updateSyncedFiles: mocks.updateSyncedFiles,
        updateIgnoredFiles: mocks.updateIgnoredFiles,
        onAddFile: vi.fn(),
        onRemoveFile: vi.fn(),
        onRemoveDir,
    },
};

vi.stubGlobal("electron", electron);

const { default: watcher } = await import("../src/services/watch");

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    mocks.updateSyncedFiles.mockReset();
    mocks.updateIgnoredFiles.mockReset();
    onRemoveDir.mockReset();
    watch.syncedFiles = [];
    watch.ignoredFiles = [];
});

describe("folder watch lifecycle", () => {
    test("retains upload bookkeeping when persistence fails", async () => {
        vi.useFakeTimers();
        mocks.updateSyncedFiles
            .mockRejectedValueOnce(new Error("persist failed"))
            .mockResolvedValue(undefined);

        const upload = vi.fn();
        const onPull = vi.fn();
        watcher.init(upload, onPull);
        await vi.advanceTimersByTimeAsync(0);
        watcher.pushEvent({
            action: "upload",
            collectionName: "watched",
            folderPath: watch.folderPath,
            filePath: "/watched/photo.jpg",
        });
        await vi.advanceTimersByTimeAsync(1000);

        expect(upload).toHaveBeenCalledWith("watched", ["/watched/photo.jpg"]);

        const file = { id: 1, collectionID: 2 };
        const item = {
            uploadItem: "/watched/photo.jpg",
            pathPrefix: undefined,
            localID: 1,
            collectionID: 2,
        };
        watcher.onFileUpload(item, { type: "uploaded", file } as never);

        await expect(watcher.allFileUploadsDone([item])).rejects.toThrow(
            "persist failed",
        );

        if (watcher.isUploadRunning()) await watcher.allFileUploadsDone([item]);
        expect(watcher.isUploadRunning()).toBe(false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(upload).toHaveBeenCalledWith("watched", ["/watched/photo.jpg"]);
        expect(mocks.updateSyncedFiles).toHaveBeenCalledOnce();
        for (let i = 0; i < 4; i++) await Promise.resolve();
    });

    test("clears active trash state when persistence fails", async () => {
        vi.useFakeTimers();
        mocks.updateSyncedFiles
            .mockRejectedValueOnce(new Error("persist failed"))
            .mockResolvedValue(undefined);

        const upload = vi.fn();
        watcher.init(upload, vi.fn());
        await vi.advanceTimersByTimeAsync(0);
        watch.syncedFiles = [
            { path: "/watched/old.jpg", uploadedFileID: 1, collectionID: 2 },
        ];
        watcher.pushEvent({
            action: "trash",
            collectionName: "watched",
            folderPath: watch.folderPath,
            filePath: "/watched/old.jpg",
        });
        await vi.advanceTimersByTimeAsync(1000);

        watcher.pushEvent({
            action: "upload",
            collectionName: "watched",
            folderPath: watch.folderPath,
            filePath: "/watched/new.jpg",
        });
        await vi.advanceTimersByTimeAsync(1000);

        expect(upload).toHaveBeenCalledWith("watched", ["/watched/new.jpg"]);
        const item = {
            uploadItem: "/watched/new.jpg",
            pathPrefix: undefined,
            localID: 1,
            collectionID: 2,
        };
        watcher.onFileUpload(item, {
            type: "uploaded",
            file: { id: 1, collectionID: 2 },
        } as never);
        await watcher.allFileUploadsDone([item]);
        await vi.advanceTimersByTimeAsync(1000);
        for (let i = 0; i < 4; i++) await Promise.resolve();
    });

    test("rescans retryable item failures after batch completion", async () => {
        vi.useFakeTimers();
        const rescan = vi.spyOn(watcher, "rescanAfterFailedUpload");
        const upload = vi.fn();
        watcher.init(upload, vi.fn());
        await vi.advanceTimersByTimeAsync(0);
        watcher.pushEvent({
            action: "upload",
            collectionName: "watched",
            folderPath: watch.folderPath,
            filePath: "/watched/retry.jpg",
        });
        await vi.advanceTimersByTimeAsync(1000);

        const item = {
            uploadItem: "/watched/retry.jpg",
            pathPrefix: undefined,
            localID: 1,
            collectionID: 2,
        };
        watcher.onFileUpload(item, { type: "failed" });
        await watcher.allFileUploadsDone([item]);
        await vi.advanceTimersByTimeAsync(1000);
        for (let i = 0; i < 4; i++) await Promise.resolve();

        expect(rescan).toHaveBeenCalledOnce();
        rescan.mockRestore();
    });

    test("reruns pull requested while completion pull is running", async () => {
        vi.useFakeTimers();
        let resolveFirstPull!: () => void;
        let resolveSecondPull!: () => void;
        let resolveSecondPullStarted!: () => void;
        const secondPullStarted = new Promise<void>((resolve) => {
            resolveSecondPullStarted = resolve;
        });
        let pullCount = 0;
        const onPull = vi.fn(() => {
            pullCount++;
            if (pullCount == 1)
                return new Promise<void>((resolve) => {
                    resolveFirstPull = resolve;
                });
            resolveSecondPullStarted();
            return new Promise<void>((resolve) => {
                resolveSecondPull = resolve;
            });
        });
        const upload = vi.fn();
        watcher.init(upload, onPull);
        await vi.advanceTimersByTimeAsync(0);

        const firstItem = {
            uploadItem: "/watched/first.jpg",
            pathPrefix: undefined,
            localID: 1,
            collectionID: 2,
        };
        watcher.pushEvent({
            action: "upload",
            collectionName: "watched",
            folderPath: watch.folderPath,
            filePath: firstItem.uploadItem,
        });
        await vi.advanceTimersByTimeAsync(1000);
        watcher.onFileUpload(firstItem, {
            type: "uploaded",
            file: { id: 1, collectionID: 2 },
        } as never);
        await watcher.allFileUploadsDone([firstItem]);
        await Promise.resolve();
        expect(onPull).toHaveBeenCalledOnce();

        const secondItem = {
            ...firstItem,
            uploadItem: "/watched/second.jpg",
            localID: 2,
        };
        watcher.pushEvent({
            action: "upload",
            collectionName: "watched",
            folderPath: watch.folderPath,
            filePath: secondItem.uploadItem,
        });
        await vi.advanceTimersByTimeAsync(1000);
        watcher.onFileUpload(secondItem, {
            type: "uploaded",
            file: { id: 2, collectionID: 2 },
        } as never);
        await watcher.allFileUploadsDone([secondItem]);
        expect(onPull).toHaveBeenCalledOnce();

        resolveFirstPull();
        await secondPullStarted;
        expect(onPull).toHaveBeenCalledTimes(2);

        resolveSecondPull();
        await vi.runAllTimersAsync();
        for (let i = 0; i < 4; i++) await Promise.resolve();
    });

    test("drains root deletion state and triggers one pull", async () => {
        const upload = vi.fn();
        const onPull = vi.fn();
        watcher.init(upload, onPull);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 1100));

        expect(onRemoveDir).toHaveBeenCalled();
        const removeDir = onRemoveDir.mock.calls.at(-1)?.[0] as (
            path: string,
            folderWatch: FolderWatch,
        ) => void;
        removeDir(watch.folderPath, watch);
        watcher.pushEvent({
            action: "trash",
            collectionName: "watched",
            folderPath: watch.folderPath,
            filePath: "/watched/photo.jpg",
        });
        await new Promise((resolve) => setTimeout(resolve, 1100));

        expect(onPull).toHaveBeenCalledOnce();
    });
});
