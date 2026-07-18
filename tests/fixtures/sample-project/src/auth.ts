export class UserService {
  public authenticate(token: string): boolean {
    return token === "sample-token";
  }
}

export function authenticate(token: string): boolean {
  return new UserService().authenticate(token);
}
