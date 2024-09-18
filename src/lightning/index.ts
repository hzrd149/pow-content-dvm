import { LNBITS_KEY, LNBITS_URL } from "../env.js";
import LNBitsBackend from "./lnbits/lnbits.js";

function createBackend() {
  if (LNBITS_URL && LNBITS_KEY) {
    return new LNBitsBackend(LNBITS_URL, LNBITS_KEY);
  }
}

const lightning = createBackend();
if (lightning) await lightning.setup();

export default lightning;
