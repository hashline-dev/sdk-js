// src/index.ts — public entrypoint for the Hashline SDK.

export { Client, MAX_BATCH_SIZE } from "./client.js";
export type { ClientOptions } from "./client.js";
export { APIError, HashlineError, NetworkError, ValidationError } from "./errors.js";
export type {
  Actor,
  BatchAck,
  BatchEventInput,
  EventAck,
  EventInput,
  EventType,
  ProblemJson,
} from "./types.js";
