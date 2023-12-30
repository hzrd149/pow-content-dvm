import type { Event } from "nostr-tools";

export function getInputTag(e: Event) {
  return e.tags.find((t) => t[0] === "i");
}
export function getExpirationTag(e: Event) {
  return e.tags.find((t) => t[0] === "expiration");
}

export function getInput(e: Event) {
  const tag = getInputTag(e);
  if (!tag) return null;
  const [_, value, type, relay, marker] = tag;
  if (!value) throw new Error("Missing input value");
  if (!type) throw new Error("Missing input type");
  return { value, type, relay, marker };
}
export function getRelays(event: Event) {
  return event.tags.find((t) => t[0] === "relays")?.slice(1) ?? [];
}
export function getOutputType(event: Event): string | undefined {
  return event.tags.find((t) => t[0] === "output")?.[1];
}

export function getInputParams(e: Event, k: string) {
  return e.tags.filter((t) => t[0] === "param" && t[1] === k).map((t) => t[2]);
}

export function getInputParam(e: Event, k: string): string | undefined;
export function getInputParam(e: Event, k: string, required: true): string;
export function getInputParam(e: Event, k: string, required: false): string | undefined;
export function getInputParam(e: Event, k: string, required = false) {
  const value = getInputParams(e, k)[0];
  if (value === undefined && required) throw new Error(`Missing ${k} param`);
  return value;
}
