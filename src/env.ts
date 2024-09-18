import "dotenv/config";
import { hexToBytes } from "@noble/hashes/utils";

const SQLITE_DB = process.env.SQLITE_DB;
if (!SQLITE_DB) throw new Error("Missing SQLITE_DB");

const NOSTR_PRIVATE_KEY_VALUE = process.env.NOSTR_PRIVATE_KEY ? hexToBytes(process.env.NOSTR_PRIVATE_KEY) : undefined;
if (!NOSTR_PRIVATE_KEY_VALUE) throw new Error("Missing NOSTR_PRIVATE_KEY");
const NOSTR_PRIVATE_KEY = NOSTR_PRIVATE_KEY_VALUE;

// lnbits
const LNBITS_URL = process.env.LNBITS_URL;
const LNBITS_KEY = process.env.LNBITS_KEY;

// nostr
const NOSTR_RELAYS = process.env.NOSTR_RELAYS;
if (!NOSTR_RELAYS) throw new Error("Missing NOSTR_RELAYS");

export { NOSTR_PRIVATE_KEY, LNBITS_URL, LNBITS_KEY, NOSTR_RELAYS, SQLITE_DB };
