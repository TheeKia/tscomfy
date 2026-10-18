import { join } from "node:path";

/**
 * Names of the committed protocol mocks in `mocks/protocol/`: what a ComfyUI server sends during
 * runs, for the client's fake server. Each holds runs: the prompt, the answer to `POST /prompt`,
 * the websocket events in order (binary frames as `{ binary, … }`), and the job record at the
 * end. `PROMPT_ID` stands for the prompt id the client chose.
 */
export const MOCK_PROTOCOL_NAMES = [
  "blocked",
  "cancel",
  "error",
  "partial",
  "pending",
  "rejected",
  "sampler",
  "success",
  "websocket",
] as const;

/** A name in {@link MOCK_PROTOCOL_NAMES}. */
export type MockProtocolName = (typeof MOCK_PROTOCOL_NAMES)[number];

/** Where the protocol mocks are. */
export const MOCK_PROTOCOL_DIR: string = join(import.meta.dir, "..", "mocks", "protocol");

/** Raw JSON text of one protocol mock. */
export function readMockProtocol(name: MockProtocolName): Promise<string> {
  return Bun.file(join(MOCK_PROTOCOL_DIR, `${name}.json`)).text();
}
