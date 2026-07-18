import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BinaryFileWriteError,
  ChangeValidator,
  FileAlreadyExistsError,
  InvalidFileNameError,
  ProtectedPathWriteError,
  SensitiveFileWriteError,
  SymlinkWriteBlockedError,
} from "../src/index.js";

describe("ChangeValidator", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "change-validator-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function validator(
    overrides: { sensitive?: boolean; symlink?: boolean; platform?: NodeJS.Platform } = {},
  ) {
    return ChangeValidator.create({
      workspaceRoot: root,
      allowSensitiveFileWrite: overrides.sensitive ?? false,
      allowSymlinkWrite: overrides.symlink ?? false,
      ...(overrides.platform === undefined ? {} : { platform: overrides.platform }),
    });
  }

  it("akceptuje zapis wewnątrz workspace", async () => {
    const result = await (await validator()).target("src/new.ts");
    expect(result.relativePath).toBe("src/new.ts");
    expect(result.absolutePath).toBe(resolve(root, "src/new.ts"));
  });

  it("blokuje traversal przez ..", async () => {
    await expect((await validator()).target("../outside.ts")).rejects.toBeInstanceOf(
      InvalidFileNameError,
    );
  });

  it("blokuje ścieżkę absolutną poza workspace", async () => {
    const outside = resolve(root, "..", "outside.ts");
    await expect((await validator()).target(outside)).rejects.toBeInstanceOf(
      ProtectedPathWriteError,
    );
  });

  it("blokuje katalog o podobnym prefiksie do workspace", async () => {
    await expect((await validator()).target(`${root}-other/file.ts`)).rejects.toBeInstanceOf(
      ProtectedPathWriteError,
    );
  });

  it("blokuje ścieżkę zawierającą symlink", async () => {
    const target = join(root, "target-dir");
    await mkdir(target);
    await symlink(target, join(root, "linked"), "junction");
    await expect((await validator()).target("linked/new.ts")).rejects.toBeInstanceOf(
      SymlinkWriteBlockedError,
    );
  });

  it.each([".git/config", "node_modules/a.js", "dist/a.js", ".agent/history/x"])(
    "blokuje chronioną ścieżkę %s",
    async (path) => {
      await expect((await validator()).target(path)).rejects.toBeInstanceOf(
        ProtectedPathWriteError,
      );
    },
  );

  it.each([".env", ".env.local", "private.pem", "id_rsa", "secrets.json"])(
    "blokuje plik wrażliwy %s",
    async (path) => {
      await expect((await validator()).target(path)).rejects.toBeInstanceOf(
        SensitiveFileWriteError,
      );
    },
  );

  it.each([".env.example", ".env.template", ".env.sample"])(
    "zezwala na bezpieczny szablon %s",
    async (path) => {
      await expect((await validator()).target(path)).resolves.toMatchObject({ relativePath: path });
    },
  );

  it("po jawnej konfiguracji zezwala na plik wrażliwy, ale nadal blokuje .git", async () => {
    const subject = await validator({ sensitive: true });
    await expect(subject.target(".env")).resolves.toMatchObject({ relativePath: ".env" });
    await expect(subject.target(".git/config")).rejects.toBeInstanceOf(ProtectedPathWriteError);
  });

  it("blokuje binarny plik", async () => {
    await writeFile(join(root, "src", "binary.bin"), Buffer.from([0, 1, 2, 3]));
    const subject = await validator();
    const path = await subject.existingFile("src/binary.bin");
    await expect(subject.assertTextFile(path)).rejects.toBeInstanceOf(BinaryFileWriteError);
  });

  it.each(["CON", "aux.txt", "COM9.log", "bad?.ts", "trailing. "])(
    "blokuje niedozwoloną nazwę Windows %s",
    async (path) => {
      await expect((await validator({ platform: "win32" })).target(path)).rejects.toBeInstanceOf(
        InvalidFileNameError,
      );
    },
  );

  it("blokuje pusty segment ścieżki", async () => {
    await expect((await validator()).target("src//new.ts")).rejects.toBeInstanceOf(
      InvalidFileNameError,
    );
  });

  it("rozróżnia plik istniejący i nowy", async () => {
    const subject = await validator();
    await expect(subject.existingFile("src/a.ts")).resolves.toMatchObject({
      relativePath: "src/a.ts",
    });
    await expect(subject.newFile("src/a.ts")).rejects.toBeInstanceOf(FileAlreadyExistsError);
    await expect(subject.newFile("src/new.ts")).resolves.toMatchObject({
      relativePath: "src/new.ts",
    });
  });
});
