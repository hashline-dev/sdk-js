// src/types.ts — wire types for the Hashline audit ledger API (mirrors spec §3).

export type EventType =
  | "run_started"
  | "run_ended"
  | "prompt"
  | "completion"
  | "tool_call"
  | "tool_result"
  | "decision"
  | "human_approval_requested"
  | "human_approval_granted"
  | "human_approval_denied"
  | "error"
  | "annotation";

export type Actor = {
  type: "agent" | "human" | "system";
  id: string;
  principal?: string;
};

/**
 * Input to {@link Client.event}. `run_id` is required; the server auto-creates
 * the run on first event if it does not exist. `client_event_id`, when set,
 * makes the ingest idempotent within the run.
 */
export type EventInput = {
  run_id: string;
  type: EventType;
  actor: Actor;
  payload: unknown;
  client_ts?: number;
  client_event_id?: string;
};

/** Server acknowledgement for a single appended event. */
export type EventAck = {
  id: string;
  run_id: string;
  seq: number;
  hash: string;
};

/**
 * Input for a batch item — `run_id` is pinned once at the batch level, so
 * callers provide only the per-event fields here.
 */
export type BatchEventInput = Omit<EventInput, "run_id">;

/** Response from {@link Client.batch}. */
export type BatchAck = {
  run_id: string;
  events: EventAck[];
};

/**
 * RFC 7807 problem+json body as returned by the Hashline API (spec §5.1).
 * Extra fields may be present; we preserve them with an index signature.
 */
export type ProblemJson = {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
};
