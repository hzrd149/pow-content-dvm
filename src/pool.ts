import WebSocket from "ws";
import { SimplePool } from "nostr-tools";
import { NOSTR_RELAYS } from "./env.js";

// @ts-ignore
global.WebSocket = WebSocket;

export const pool = new SimplePool();
export const RELAYS = NOSTR_RELAYS?.split(",").map((r) => r.trim()) ?? [];
