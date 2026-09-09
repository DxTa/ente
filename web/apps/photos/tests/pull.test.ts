import { describe, expect, test, vi } from "vitest";

const {
    searchDataSync,
    videoProcessingSyncIfNeeded,
    mlSync,
    pullCollectionFileDiffs,
    pullCollections,
} = vi.hoisted(() => ({
    searchDataSync: vi.fn(() => undefined),
    videoProcessingSyncIfNeeded: vi.fn(() => undefined),
    mlSync: vi.fn(),
    pullCollectionFileDiffs: vi.fn(),
    pullCollections: vi.fn(),
}));

vi.mock("ente-base/log", () => ({
    default: { warn: vi.fn() },
    logToDisk: vi.fn(),
}));
vi.mock("ente-gallery/components/viewer/data-source", () => ({
    resetFileViewerDataSourceOnClose: vi.fn(),
}));
vi.mock("ente-gallery/services/video", () => ({
    videoProcessingSyncIfNeeded,
    videoPrunePermanentlyDeletedFileIDsIfNeeded: vi.fn(),
}));
vi.mock("ente-new/photos/services/collection", () => ({
    movePendingRemovalActionsToUncategorized: vi.fn(),
    pullCollectionFileDiffs,
    pullCollectionFiles: vi.fn(),
    pullCollections,
}));
vi.mock("ente-new/photos/services/ml", () => ({
    isMLSupported: false,
    mlSync,
    pullMLStatus: vi.fn(),
}));
vi.mock("ente-new/photos/services/search", () => ({ searchDataSync }));
vi.mock("ente-new/photos/services/settings", () => ({ pullSettings: vi.fn() }));
vi.mock("ente-new/photos/services/trash", () => ({ pullTrash: vi.fn() }));
vi.mock("../src/services/authenticated-session", () => ({
    ensureAuthenticatedSession: vi.fn(),
}));

import { postPullFiles, pullFiles } from "../src/services/pull";

describe("incremental remote file pull", () => {
    test("syncs file diffs for automatic pulls", async () => {
        const onCollectionFileChange = vi.fn();
        const onDidUpdateCollectionFiles = vi.fn();
        const collections = [{ id: 10 }] as never[];
        pullCollections.mockResolvedValue(collections);
        pullCollectionFileDiffs.mockResolvedValue(true);

        await pullFiles({
            onSetCollections: vi.fn(),
            onSetCollectionFiles: vi.fn(),
            onCollectionFileChange,
            onSetTrashedItems: vi.fn(),
            onDidUpdateCollectionFiles,
            collectionFileSyncMode: "bootstrap",
        });

        expect(pullCollectionFileDiffs).toHaveBeenCalledWith(
            collections,
            onCollectionFileChange,
            "bootstrap",
        );
        expect(onDidUpdateCollectionFiles).toHaveBeenCalledOnce();
    });
});

describe("folder-watch remote pull", () => {
    test("skips HLS backfill for watcher completion pulls", async () => {
        await postPullFiles("watcher-upload");

        expect(searchDataSync).toHaveBeenCalledOnce();
        expect(videoProcessingSyncIfNeeded).not.toHaveBeenCalled();
        expect(mlSync).toHaveBeenCalledWith("remote-pull:watcher-upload");
    });

    test("keeps HLS backfill for normal pulls", async () => {
        await postPullFiles("post-upload");

        expect(videoProcessingSyncIfNeeded).toHaveBeenCalledOnce();
        expect(mlSync).toHaveBeenCalledWith("remote-pull:post-upload");
    });

    test.each(["gallery-mount", "gallery-periodic", "desktop-focus"])(
        "skips automatic HLS backfill for %s",
        async (source) => {
            videoProcessingSyncIfNeeded.mockClear();
            mlSync.mockClear();

            await postPullFiles(source);

            expect(videoProcessingSyncIfNeeded).not.toHaveBeenCalled();
            expect(mlSync).not.toHaveBeenCalled();
        },
    );
});
