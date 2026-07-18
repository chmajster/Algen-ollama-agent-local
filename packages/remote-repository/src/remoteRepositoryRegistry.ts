import { RemoteProviderUnsupportedError } from "./errors.js";
import type { RemoteRepositoryProvider } from "./remoteRepositoryProvider.js";
import type { RemoteProviderName } from "./remoteRepositoryTypes.js";

export class RemoteRepositoryRegistry {
  private readonly providers = new Map<RemoteProviderName, RemoteRepositoryProvider>();

  public register(provider: RemoteRepositoryProvider): void {
    this.providers.set(provider.name, provider);
  }

  public get(name: RemoteProviderName): RemoteRepositoryProvider {
    const provider = this.providers.get(name);
    if (provider === undefined)
      throw new RemoteProviderUnsupportedError(`Dostawca ${name} nie jest zarejestrowany.`);
    return provider;
  }

  public has(name: RemoteProviderName): boolean {
    return this.providers.has(name);
  }
}
