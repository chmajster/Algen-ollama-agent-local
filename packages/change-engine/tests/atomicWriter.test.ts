import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AtomicWriteError, AtomicWriter } from "../src/index.js";

describe("AtomicWriter", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "atomic-writer-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("zastępuje plik przez unikalny plik tymczasowy w tym samym katalogu", async () => {
    const path = join(root, "a.txt");
    await writeFile(path, "old");
    let observedTemporary = "";
    const writer = new AtomicWriter({
      beforeCommit: async (temporary, destination) => {
        observedTemporary = temporary;
        expect(destination).toBe(path);
        await expect(readFile(temporary, "utf8")).resolves.toBe("new");
        await expect(readFile(path, "utf8")).resolves.toBe("old");
      },
    });
    await writer.replaceFile(path, Buffer.from("new"));
    expect(observedTemporary).toMatch(/\.a\.txt\.agent-tmp-/u);
    await expect(readFile(path, "utf8")).resolves.toBe("new");
  });

  it("sprząta plik tymczasowy po sukcesie", async () => {
    const path = join(root, "a.txt");
    await writeFile(path, "old");
    await new AtomicWriter().replaceFile(path, Buffer.from("new"));
    expect((await readdir(root)).filter((entry) => entry.includes("agent-tmp"))).toEqual([]);
  });

  it("sprząta plik tymczasowy i zachowuje cel po błędzie", async () => {
    const path = join(root, "a.txt");
    await writeFile(path, "old");
    const writer = new AtomicWriter({
      beforeCommit: async () => {
        throw new Error("injected");
      },
    });
    await expect(writer.replaceFile(path, Buffer.from("new"))).rejects.toBeInstanceOf(
      AtomicWriteError,
    );
    await expect(readFile(path, "utf8")).resolves.toBe("old");
    expect((await readdir(root)).filter((entry) => entry.includes("agent-tmp"))).toEqual([]);
  });

  it("zachowuje uprawnienia zastępowanego pliku", async () => {
    const path = join(root, "script.sh");
    await writeFile(path, "old");
    await chmod(path, 0o754);
    const before = (await stat(path)).mode & 0o777;
    await new AtomicWriter().replaceFile(path, Buffer.from("new"));
    expect((await stat(path)).mode & 0o777).toBe(before);
  });

  it("tworzy katalog nadrzędny i nowy plik", async () => {
    const path = join(root, "nested", "a.txt");
    await new AtomicWriter().createFile(path, Buffer.from("new"));
    await expect(readFile(path, "utf8")).resolves.toBe("new");
  });

  it("nie nadpisuje istniejącego pliku podczas create", async () => {
    const path = join(root, "a.txt");
    await writeFile(path, "old");
    await expect(new AtomicWriter().createFile(path, Buffer.from("new"))).rejects.toBeInstanceOf(
      AtomicWriteError,
    );
    await expect(readFile(path, "utf8")).resolves.toBe("old");
  });

  it("usuwa osierocone pliki tymczasowe o kontrolowanej nazwie", async () => {
    await writeFile(join(root, ".a.agent-tmp-12345678-1234-1234-1234-123456789abc"), "x");
    await writeFile(join(root, "ordinary.txt"), "x");
    await expect(new AtomicWriter().cleanupTemporaryFiles(root)).resolves.toBe(1);
    expect(await readdir(root)).toEqual(["ordinary.txt"]);
  });

  it("sprząta osierocone pliki po starcie także w katalogach zagnieżdżonych", async () => {
    const nested = join(root, "src", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, ".a.ts.agent-tmp-12345678-1234-1234-1234-123456789abc"), "x");
    await expect(new AtomicWriter().cleanupWorkspaceTemporaryFiles(root)).resolves.toBe(1);
    expect(await readdir(nested)).toEqual([]);
  });
});
