#!/usr/bin/env node
import dayjs from "dayjs";
import { RELAYS, pool } from "./pool.js";
import { NostrEvent, finalizeEvent, getPublicKey } from "nostr-tools";

import { NOSTR_PRIVATE_KEY } from "./env.js";
import { DMV_CONTENT_REQUEST_KIND, DMV_CONTENT_RESULT_KIND, DMV_STATUS_KIND } from "./const.js";
import { getExpirationTag, getInput, getInputParam, getInputTag, getRelays } from "./helpers/dvm.js";
import { logger } from "./debug.js";
import { unique } from "./helpers/array.js";
import db from "./db.js";
import lightning from "./lightning/index.js";
import { InvoiceStatus } from "./lightning/type.js";
import { Subscription } from "nostr-tools/abstract-relay";

const pubkey = getPublicKey(NOSTR_PRIVATE_KEY);

class PublicError extends Error {}
async function sendResponse(request: NostrEvent, event: NostrEvent) {
  pool.publish(unique([...getRelays(request), ...RELAYS]), event).map((p) => p.catch((e) => {}));
}
async function sendProcessing(request: NostrEvent, message?: string) {
  const event = finalizeEvent(
    {
      kind: DMV_STATUS_KIND,
      tags: [
        ["e", request.id],
        ["p", request.pubkey],
        ["status", "processing"],
        getExpirationTag(request) || ["expiration", String(dayjs().add(1, "hour").unix())],
      ],
      content: message || "",
      created_at: dayjs().unix(),
    },
    NOSTR_PRIVATE_KEY,
  );

  await sendResponse(request, event);
}
async function sendError(request: NostrEvent, error: Error) {
  const event = finalizeEvent(
    {
      kind: DMV_STATUS_KIND,
      tags: [
        ["e", request.id],
        ["p", request.pubkey],
        ["status", "error"],
        getExpirationTag(request) || ["expiration", String(dayjs().add(1, "hour").unix())],
      ],
      content: error.message,
      created_at: dayjs().unix(),
    },
    NOSTR_PRIVATE_KEY,
  );

  await sendResponse(request, event);
}
async function requestPayment(request: NostrEvent, msats: number) {
  const invoice = await lightning.createInvoice(msats);

  const status = finalizeEvent(
    {
      kind: DMV_STATUS_KIND,
      content: "Please pay the provided invoice",
      tags: [
        ["status", "payment-required"],
        ["amount", String(msats), invoice.paymentRequest],
        ["e", request.id],
        ["p", request.pubkey],
        getExpirationTag(request) || ["expiration", String(dayjs().add(1, "hour").unix())],
      ],
      created_at: dayjs().unix(),
    },
    NOSTR_PRIVATE_KEY,
  );

  await sendResponse(request, status);

  return invoice;
}

enum TimePeriod {
  day = "day",
  week = "week",
  month = "month",
  year = "year",
  all = "all",
}
type Job = {
  request: NostrEvent;
  timePeriod: TimePeriod;
  input?: Job;
  paymentRequest?: string;
  paymentHash?: string;
};

const pendingJobs = new Map<string, Job>();
const previousJobs = new Map<string, Job>();

async function buildJob(request: NostrEvent) {
  const input = getInput(request);
  const timePeriod = (getInputParam(request, "timePeriod") as TimePeriod) || TimePeriod.year;

  if (!Object.values(TimePeriod).includes(timePeriod)) throw new Error(`Known time period ${timePeriod}`);

  if (!request.tags.some((t) => t[0] === "p" && t[1] === pubkey)) throw new Error("Not addressed to me");

  if (input && input.type === "event") {
    const prevJob = previousJobs.get(input.value);
    if (!prevJob) throw new PublicError("Cant find old job");
    return { input: prevJob, request, timePeriod };
  }

  const job: Job = { request, timePeriod };
  return job;
}

function getMinDate(request: NostrEvent, timePeriod: TimePeriod) {
  if (timePeriod === TimePeriod.all) return 0;

  let startDate = dayjs.unix(request.created_at);
  switch (timePeriod) {
    case TimePeriod.day:
      return startDate.subtract(1, "day").unix();
    case TimePeriod.week:
      return startDate.subtract(1, "week").unix();
    case TimePeriod.month:
      return startDate.subtract(1, "month").unix();
    case TimePeriod.year:
      return startDate.subtract(1, "year").unix();
    default:
      throw new Error("timePeriod ");
  }
}
async function doWork(job: Job) {
  logger(`Starting work for ${job.request.id}`);

  let page = 0;

  // add 50 to the offset for each previous job
  let rootJob = job;
  while (rootJob.input) {
    page++;
    rootJob = rootJob.input;
  }

  let minDate = getMinDate(rootJob.request, rootJob.timePeriod);

  const rows = await db.all<{ content: string }[]>(
    "SELECT content FROM event WHERE kind=1 AND created_at > ? ORDER BY event_hash LIMIT 50 OFFSET ?",
    minDate,
    page * 50,
  );

  if (rows.length === 0) throw new PublicError("No events left");

  const events = rows.map((r) => JSON.parse(r.content) as NostrEvent);

  const result = finalizeEvent(
    {
      kind: DMV_CONTENT_RESULT_KIND,
      tags: [
        ["request", JSON.stringify(job.request)],
        ["e", job.request.id],
        ["p", job.request.pubkey],
        getInputTag(job.request),
        getExpirationTag(job.request) || ["expiration", String(dayjs().add(1, "hour").unix())],
      ].filter(Boolean),
      content: JSON.stringify(events.map((e) => ["e", e.id])),
      created_at: dayjs().unix(),
    },
    NOSTR_PRIVATE_KEY,
  );

  logger(`Returning page ${page} to ${job.request.id}`);
  await sendResponse(job.request, result);
}

async function handleJobEvent(event: NostrEvent) {
  if (event.kind === DMV_CONTENT_REQUEST_KIND && !pendingJobs.has(event.id) && !previousJobs.has(event.id)) {
    try {
      const job = await buildJob(event);
      try {
        logger(`Requesting payment for ${job.request.id}`);
        const invoice = await requestPayment(job.request, 10 * 1000);
        job.paymentHash = invoice.paymentHash;
        job.paymentRequest = invoice.paymentRequest;
        pendingJobs.set(job.request.id, job);
      } catch (e) {
        if (e instanceof Error) {
          logger(`Failed to request payment for ${event.id}`);
          console.log(e);
          await sendError(event, e);
        }
      }
    } catch (e) {
      if (e instanceof PublicError) await sendError(event, e);
      else if (e instanceof Error) logger(`Skipped request ${event.id} because`, e.message);
    }
  }
}

function checkInvoices() {
  for (let [id, job] of pendingJobs) {
    if (!job.paymentHash) pendingJobs.delete(id);
    logger(`Checking payment for ${id}`);

    lightning.getInvoiceStatus(job.paymentHash).then(async (status) => {
      if (status === InvoiceStatus.PAID) {
        // remove from queue
        pendingJobs.delete(id);

        try {
          await sendProcessing(job.request, "Building feed");
          await doWork(job);
          previousJobs.set(id, job);
        } catch (e) {
          if (e instanceof Error) {
            logger(`Failed to process ${id}`);
            console.log(e);
            await sendError(job.request, e);
          }
        }
      } else if (status === InvoiceStatus.EXPIRED) pendingJobs.delete(id);
    });
  }
}

setInterval(checkInvoices, 5 * 1000);

const subscriptions = new Map<string, Subscription>();
async function subscribeToRelays() {
  for (const url of RELAYS) {
    let sub = subscriptions.get(url);

    // open new subscription if closed or missing
    if (!sub || sub.closed) {
      logger(`Opening subscription to ${url}`);
      const relay = await pool.ensureRelay(url);

      sub = relay.subscribe([{ kinds: [DMV_CONTENT_REQUEST_KIND], since: dayjs().unix(), "#p": [pubkey] }], {
        onevent: handleJobEvent,
        onclose: () => {
          logger(`Subscription to ${url} closed`);
        },
      });

      subscriptions.set(url, sub);
    }
  }
}

logger("Publishing relay list");
await pool.publish(
  [...RELAYS, "wss://purplepag.es"],
  finalizeEvent(
    { kind: 10002, content: "", tags: RELAYS.map((r) => ["r", r]), created_at: dayjs().unix() },
    NOSTR_PRIVATE_KEY,
  ),
);

logger("Listening for jobs");
await subscribeToRelays();
setInterval(subscribeToRelays, 1000 * 30);

async function shutdown() {
  for (const [_, sub] of subscriptions) sub.close();

  process.exit();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.once("SIGUSR2", shutdown);
