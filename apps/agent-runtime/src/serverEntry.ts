import { stderr, stdin, stdout } from "node:process";

import { RuntimeServer, runtimeSessionId } from "./server/runtimeServer.js";

const sessionId = runtimeSessionId();
const server = new RuntimeServer({
  input: stdin,
  output: stdout,
  errorOutput: stderr,
  ...(sessionId === undefined ? {} : { sessionId }),
});

void server.start().catch((error: unknown) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
