import { RemoteRepositoryHostBlockedError } from "./errors.js";

export function remoteUrlContainsCredentials(value: string): boolean {
  if (/^git@[^:]+:/i.test(value.trim())) return false;
  try {
    const url = new URL(value);
    return (
      url.password !== "" ||
      (url.username !== "" && !(url.protocol === "ssh:" && url.username === "git"))
    );
  } catch {
    return /https?:\/\/[^/@\s]+@/i.test(value);
  }
}

export function assertRemoteUrlSafe(value: string): void {
  if (remoteUrlContainsCredentials(value)) {
    throw new RemoteRepositoryHostBlockedError(
      "Remote URL zawiera poświadczenia i został zablokowany.",
    );
  }
}

export function sanitizeRemoteUrl(value: string): string {
  if (/^git@[^:]+:/i.test(value.trim())) return value.trim();
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") {
      url.username = "";
      url.password = "";
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@");
  }
}
