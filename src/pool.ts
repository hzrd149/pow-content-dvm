import WebSocket from "ws";
import { SimplePool } from "nostr-tools";
import { NOSTR_RELAYS } from "./env.js";

// @ts-ignore
global.WebSocket = WebSocket;

export const pool = new SimplePool();
export const RELAYS = NOSTR_RELAYS?.split(",") ?? [];

export function ensureConnection() {
  return Promise.all(
    RELAYS.map((url) => {
      return pool.ensureRelay(url);
    }),
  );
}
