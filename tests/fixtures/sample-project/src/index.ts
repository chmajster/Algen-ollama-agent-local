import { authenticate } from "./auth.js";

export function main(token: string): boolean {
  return authenticate(token);
}
