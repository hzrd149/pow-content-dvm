import "dotenv/config";

const SQLITE_DB = process.env.SQLITE_DB;
if (!SQLITE_DB) throw new Error("Missing SQLITE_DB");

const NOSTR_PRIVATE_KEY = process.env.NOSTR_PRIVATE_KEY;
if (!NOSTR_PRIVATE_KEY) throw new Error("Missing NOSTR_PRIVATE_KEY");

// lnbits
const LNBITS_URL = process.env.LNBITS_URL;
const LNBITS_KEY = process.env.LNBITS_KEY;

// nostr
const NOSTR_RELAYS = process.env.NOSTR_RELAYS;
if (!NOSTR_RELAYS) throw new Error("Missing NOSTR_RELAYS");

export { NOSTR_PRIVATE_KEY, LNBITS_URL, LNBITS_KEY, NOSTR_RELAYS, SQLITE_DB };
