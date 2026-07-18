import {
  RemoteRepositoryAmbiguousError,
  RemoteRepositoryHostBlockedError,
  RemoteRepositoryNotFoundError,
} from "./errors.js";
import type { RepositoryReference, RemoteUrlType } from "./remoteRepositoryTypes.js";

export interface RemoteDescriptor {
  name: string;
  url: string;
}

export interface RepositoryParserOptions {
  expectedHost?: string;
  allowEnterprise?: boolean;
  provider?: "github";
}

const OWNER = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/;
const REPOSITORY = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

function parseRemoteUrl(remoteUrl: string): {
  host: string;
  owner: string;
  repository: string;
  type: RemoteUrlType;
} {
  const value = remoteUrl.trim();
  const scp = /^git@([^:/\s]+):([^/\s]+)\/([^/\s]+?)$/i.exec(value);
  if (scp !== null) {
    return {
      host: scp[1]?.toLowerCase() ?? "",
      owner: scp[2] ?? "",
      repository: (scp[3] ?? "").replace(/\.git$/i, ""),
      type: "ssh",
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteRepositoryNotFoundError("Remote ma nieobsługiwany format.");
  }
  if (
    url.password !== "" ||
    (url.username !== "" && !(url.protocol === "ssh:" && url.username === "git"))
  ) {
    throw new RemoteRepositoryHostBlockedError("Remote URL zawiera poświadczenia.");
  }
  if (url.protocol !== "https:" && url.protocol !== "ssh:") {
    throw new RemoteRepositoryHostBlockedError("Remote musi używać HTTPS albo SSH.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new RemoteRepositoryHostBlockedError("Remote URL zawiera podejrzane komponenty.");
  }
  const path = url.pathname.replace(/^\//, "").replace(/\.git$/i, "");
  const parts = path.split("/");
  if (parts.length !== 2) {
    throw new RemoteRepositoryNotFoundError("Remote musi wskazywać dokładnie owner/repository.");
  }
  return {
    host: url.hostname.toLowerCase(),
    owner: parts[0] ?? "",
    repository: parts[1] ?? "",
    type: url.protocol === "ssh:" ? "ssh" : "https",
  };
}

export function parseRepositoryReference(
  remote: RemoteDescriptor,
  options: RepositoryParserOptions = {},
): RepositoryReference {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(remote.name)) {
    throw new RemoteRepositoryNotFoundError("Nazwa remote jest niepoprawna.");
  }
  const parsed = parseRemoteUrl(remote.url);
  const expectedHost = (options.expectedHost ?? "github.com").toLowerCase();
  if (parsed.host !== expectedHost) {
    throw new RemoteRepositoryHostBlockedError(
      `Host remote ${parsed.host} nie zgadza się z konfiguracją.`,
    );
  }
  if (expectedHost !== "github.com" && options.allowEnterprise !== true) {
    throw new RemoteRepositoryHostBlockedError("GitHub Enterprise jest wyłączony.");
  }
  if (!OWNER.test(parsed.owner)) {
    throw new RemoteRepositoryNotFoundError("Właściciel repozytorium ma niepoprawną nazwę.");
  }
  if (!REPOSITORY.test(parsed.repository)) {
    throw new RemoteRepositoryNotFoundError("Repozytorium ma niepoprawną nazwę.");
  }
  return {
    provider: options.provider ?? "github",
    host: parsed.host,
    owner: parsed.owner,
    repository: parsed.repository,
    remoteName: remote.name,
    remoteUrlType: parsed.type,
  };
}

export function resolveRepositoryReference(
  remotes: readonly RemoteDescriptor[],
  options: RepositoryParserOptions & { selectedRemote?: string } = {},
): RepositoryReference {
  if (remotes.length === 0)
    throw new RemoteRepositoryNotFoundError("Lokalne repozytorium nie ma remote.");
  const selected =
    options.selectedRemote === undefined
      ? remotes
      : remotes.filter((remote) => remote.name === options.selectedRemote);
  if (selected.length === 0)
    throw new RemoteRepositoryNotFoundError("Nie znaleziono wybranego remote.");
  const references = selected.map((remote) => parseRepositoryReference(remote, options));
  const targets = new Set(
    references.map((reference) =>
      `${reference.host}/${reference.owner}/${reference.repository}`.toLowerCase(),
    ),
  );
  if (targets.size > 1 || (references.length > 1 && options.selectedRemote === undefined)) {
    throw new RemoteRepositoryAmbiguousError("Kilka remote wymaga jawnego wyboru użytkownika.");
  }
  const reference = references[0];
  if (reference === undefined) throw new RemoteRepositoryNotFoundError();
  return reference;
}
