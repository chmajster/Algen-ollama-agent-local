import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ChangeValidator,
  CheckpointLimitError,
  CheckpointNotFoundError,
  CheckpointService,
  FileHashService,
} from "../src/index.js";

describe("CheckpointService", () => {
  let root: string;
  let validator: ChangeValidator;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "checkpoints-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.txt"), "original\n");
    validator = await ChangeValidator.create({
      workspaceRoot: root,
      allowSensitiveFileWrite: false,
      allowSymlinkWrite: false,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function service(retention = 20, maxTotalBytes = 1_000_000): CheckpointService {
    return new CheckpointService({ workspaceRoot: root, retention, maxTotalBytes }, validator);
  }

  it("tworzy checkpoint obejmujący tylko wskazane pliki", async () => {
    const result = await service().create("change-1", "task", ["src/a.txt"]);
    expect(result.manifest).toMatchObject({ changeSetId: "change-1", task: "task" });
    expect(result.manifest.files).toHaveLength(1);
    expect((await service().list())[0]).toMatchObject({ filesCount: 1 });
  });

  it("zapisuje manifest i backup istniejącego pliku", async () => {
    const result = await service().create("change-1", undefined, ["src/a.txt"]);
    const entry = result.manifest.files[0];
    expect(entry).toMatchObject({ path: "src/a.txt", existed: true, sizeBytes: 9 });
    expect(entry?.sha256).toBe(await new FileHashService().hashFile(join(root, "src", "a.txt")));
    await expect(
      readFile(
        join(root, ".agent", "checkpoints", result.manifest.id, "files", "src", "a.txt"),
        "utf8",
      ),
    ).resolves.toBe("original\n");
  });

  it("zapisuje informację o wcześniej nieistniejącym pliku", async () => {
    const result = await service().create("change-1", undefined, ["src/new.txt"]);
    expect(result.manifest.files).toEqual([{ path: "src/new.txt", existed: false }]);
  });

  it("przywraca zawartość istniejącego pliku", async () => {
    const subject = service();
    const checkpoint = await subject.create("change-1", undefined, ["src/a.txt"]);
    await writeFile(join(root, "src", "a.txt"), "changed\n");
    await expect(subject.restore(checkpoint.manifest.id)).resolves.toBe(1);
    await expect(readFile(join(root, "src", "a.txt"), "utf8")).resolves.toBe("original\n");
  });

  it("usuwa plik, który nie istniał w momencie checkpointu", async () => {
    const subject = service();
    const checkpoint = await subject.create("change-1", undefined, ["src/new.txt"]);
    await writeFile(join(root, "src", "new.txt"), "created\n");
    await subject.restore(checkpoint.manifest.id);
    await expect(readFile(join(root, "src", "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("potrafi przywrócić wyłącznie wybrane pliki", async () => {
    await writeFile(join(root, "src", "b.txt"), "b-old\n");
    const subject = service();
    const checkpoint = await subject.create("change-1", undefined, ["src/a.txt", "src/b.txt"]);
    await writeFile(join(root, "src", "a.txt"), "a-new\n");
    await writeFile(join(root, "src", "b.txt"), "b-new\n");
    await subject.restore(checkpoint.manifest.id, ["src/a.txt"]);
    await expect(readFile(join(root, "src", "a.txt"), "utf8")).resolves.toBe("original\n");
    await expect(readFile(join(root, "src", "b.txt"), "utf8")).resolves.toBe("b-new\n");
  });

  it("odrzuca nieistniejący checkpoint", async () => {
    await expect(service().getManifest("20260101T000000Z-deadbeef")).rejects.toBeInstanceOf(
      CheckpointNotFoundError,
    );
  });

  it("egzekwuje limit rozmiaru checkpointu", async () => {
    await expect(
      service(20, 2).create("change-1", undefined, ["src/a.txt"]),
    ).rejects.toBeInstanceOf(CheckpointLimitError);
  });

  it("usuwa najstarsze checkpointy ponad limit retencji", async () => {
    const subject = service(1);
    const first = await subject.create("change-1", undefined, ["src/a.txt"]);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    const second = await subject.create("change-2", undefined, ["src/a.txt"]);
    const listed = await subject.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(second.manifest.id);
    await expect(subject.getManifest(first.manifest.id)).rejects.toBeInstanceOf(
      CheckpointNotFoundError,
    );
  });
});
