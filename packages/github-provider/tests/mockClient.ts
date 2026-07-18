import type { GitHubApiClient, GitHubApiResponse } from "../src/index.js";

type Handler = unknown | ((parameters: Record<string, unknown>) => unknown | Promise<unknown>);

export class MockGitHubClient implements GitHubApiClient {
  public readonly calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
  private readonly routes = new Map<string, Handler[]>();
  private readonly graphqlResults: Handler[] = [];

  public on(route: string, ...results: Handler[]): this {
    this.routes.set(route, results);
    return this;
  }

  public onGraphql(...results: Handler[]): this {
    this.graphqlResults.push(...results);
    return this;
  }

  public async request<T>(
    route: string,
    parameters: Record<string, unknown> = {},
  ): Promise<GitHubApiResponse<T>> {
    this.calls.push({ route, parameters });
    const handlers = this.routes.get(route);
    const handler = handlers?.shift();
    if (handler === undefined) throw new Error(`Unexpected route: ${route}`);
    const data = typeof handler === "function" ? await handler(parameters) : handler;
    return { data: data as T, status: 200, headers: {} };
  }

  public async graphql<T>(_query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const handler = this.graphqlResults.shift();
    if (handler === undefined) throw new Error("Unexpected GraphQL query");
    return (typeof handler === "function" ? await handler(variables) : handler) as T;
  }

  public getRequestCount(): number {
    return this.calls.length;
  }
}
