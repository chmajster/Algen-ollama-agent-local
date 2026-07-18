import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ChangeValidator,
  CheckpointService,
  FileChangedSinceReadError,
  FileHashService,
  TransactionFailedError,
  TransactionManager,
  type PreparedTransactionOperation,
} from "../src/index.js";

describe("TransactionManager", () => {
  let root: string;
  let checkpoints: CheckpointService;
  const hashes = new FileHashService();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "transaction-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.txt"), "a-old\n");
    await writeFile(join(root, "src", "b.txt"), "b-old\n");
    const validator = await ChangeValidator.create({
      workspaceRoot: root,
      allowSensitiveFileWrite: false,
      allowSymlinkWrite: false,
    });
    checkpoints = new CheckpointService(
      { workspaceRoot: root, retention: 20, maxTotalBytes: 1_000_000 },
      validator,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function patch(
    path: "a.txt" | "b.txt",
    content: string,
  ): Promise<PreparedTransactionOperation> {
    const absolute = join(root, "src", path);
    return {
      operation: {
        id: `patch-${path}`,
        type: "apply_patch",
        path: `src/${path}`,
        expectedHash: await hashes.hashFile(absolute),
        patch: { replacements: [{ oldText: "old", newText: "new" }] },
        reason: "test",
        additions: 1,
        deletions: 1,
      },
      path: absolute,
      content: Buffer.from(content),
    };
  }

  function create(): PreparedTransactionOperation {
    return {
      operation: {
        id: "create",
        type: "create_file",
        path: "src/new.txt",
        content: "new\n",
        overwrite: false,
        reason: "test",
        additions: 1,
        deletions: 0,
      },
      path: join(root, "src", "new.txt"),
      content: Buffer.from("new\n"),
    };
  }

  it("stosuje wiele operacji jako jedną transakcję", async () => {
    const operations = [await patch("a.txt", "a-new\n"), create()];
    const checkpoint = await checkpoints.create("change", undefined, ["src/a.txt", "src/new.txt"]);
    await expect(
      new TransactionManager(checkpoints).apply(operations, checkpoint.manifest.id),
    ).resolves.toMatchObject({
      appliedOperations: 2,
    });
    await expect(readFile(join(root, "src", "a.txt"), "utf8")).resolves.toBe("a-new\n");
    await expect(readFile(join(root, "src", "new.txt"), "utf8")).resolves.toBe("new\n");
  });

  it("błąd pierwszej operacji nie powoduje częściowego zapisu", async () => {
    const operation = await patch("a.txt", "a-new\n");
    const checkpoint = await checkpoints.create("change", undefined, ["src/a.txt"]);
    const manager = new TransactionManager(checkpoints, undefined, {
      beforeOperation: async () => {
        throw new Error("injected");
      },
    });
    await expect(manager.apply([operation], checkpoint.manifest.id)).rejects.toThrow("injected");
    await expect(readFile(join(root, "src", "a.txt"), "utf8")).resolves.toBe("a-old\n");
  });

  it("błąd środkowej operacji wycofuje wcześniejsze zmiany i nowe pliki", async () => {
    const operations = [await patch("a.txt", "a-new\n"), create(), await patch("b.txt", "b-new\n")];
    const checkpoint = await checkpoints.create("change", undefined, [
      "src/a.txt",
      "src/new.txt",
      "src/b.txt",
    ]);
    const manager = new TransactionManager(checkpoints, undefined, {
      beforeOperation: async (index) => {
        if (index === 2) throw new Error("injected");
      },
    });
    await expect(manager.apply(operations, checkpoint.manifest.id)).rejects.toBeInstanceOf(
      TransactionFailedError,
    );
    await expect(readFile(join(root, "src", "a.txt"), "utf8")).resolves.toBe("a-old\n");
    await expect(readFile(join(root, "src", "b.txt"), "utf8")).resolves.toBe("b-old\n");
    await expect(readFile(join(root, "src", "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("wykrywa zmianę pliku bezpośrednio przed zapisem i zachowuje zewnętrzną treść", async () => {
    const operation = await patch("a.txt", "a-agent\n");
    const checkpoint = await checkpoints.create("change", undefined, ["src/a.txt"]);
    const manager = new TransactionManager(checkpoints, undefined, {
      beforeOperation: async () => writeFile(join(root, "src", "a.txt"), "external\n"),
    });
    await expect(manager.apply([operation], checkpoint.manifest.id)).rejects.toBeInstanceOf(
      FileChangedSinceReadError,
    );
    await expect(readFile(join(root, "src", "a.txt"), "utf8")).resolves.toBe("external\n");
  });

  it("po konflikcie późniejszego pliku wycofuje tylko dotknięte pliki", async () => {
    const operations = [await patch("a.txt", "a-agent\n"), await patch("b.txt", "b-agent\n")];
    const checkpoint = await checkpoints.create("change", undefined, ["src/a.txt", "src/b.txt"]);
    const manager = new TransactionManager(checkpoints, undefined, {
      beforeOperation: async (index) => {
        if (index === 1) await writeFile(join(root, "src", "b.txt"), "b-external\n");
      },
    });
    await expect(manager.apply(operations, checkpoint.manifest.id)).rejects.toBeInstanceOf(
      FileChangedSinceReadError,
    );
    await expect(readFile(join(root, "src", "a.txt"), "utf8")).resolves.toBe("a-old\n");
    await expect(readFile(join(root, "src", "b.txt"), "utf8")).resolves.toBe("b-external\n");
  });

  it("respektuje AbortSignal przed pierwszą operacją", async () => {
    const operation = await patch("a.txt", "a-new\n");
    const checkpoint = await checkpoints.create("change", undefined, ["src/a.txt"]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      new TransactionManager(checkpoints).apply(
        [operation],
        checkpoint.manifest.id,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(readFile(join(root, "src", "a.txt"), "utf8")).resolves.toBe("a-old\n");
  });
});
