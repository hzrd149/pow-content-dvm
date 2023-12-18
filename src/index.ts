#!/usr/bin/env node
import dayjs from "dayjs";
import { DMV_CONTENT_REQUEST_KIND, DMV_CONTENT_RESULT_KIND, DMV_STATUS_KIND } from "./const.js";
import { RELAYS, ensureConnection, pool } from "./pool.js";
import { Event, finishEvent, getPublicKey } from "nostr-tools";
import { getInput, getInputParam, getInputTag, getRelays } from "./helpers/dvm.js";
import { appDebug } from "./debug.js";
import { NOSTR_PRIVATE_KEY } from "./env.js";
import { unique } from "./helpers/array.js";
import db from "./db.js";
import lightning from "./lightning/index.js";
import { InvoiceStatus } from "./lightning/type.js";

const pubkey = getPublicKey(NOSTR_PRIVATE_KEY);

class PublicError extends Error {}
async function sendResponse(request: Event<5300>, event: Event) {
  pool.publish(unique([...getRelays(request), ...RELAYS]), event).map((p) => p.catch((e) => {}));
}
async function sendError(request: Event<5300>, error: PublicError) {
  const event = finishEvent(
    {
      kind: DMV_STATUS_KIND,
      tags: [
        ["e", request.id],
        ["p", request.pubkey],
        ["status", "error"],
      ],
      content: error.message,
      created_at: dayjs().unix(),
    },
    NOSTR_PRIVATE_KEY,
  );

  await sendResponse(request, event);
}
async function requestPayment(request: Event<5300>, msats: number) {
  const invoice = await lightning.createInvoice(msats);

  const status = finishEvent(
    {
      kind: DMV_STATUS_KIND,
      content: "Please pay the provided invoice",
      tags: [
        ["status", "payment-required"],
        ["amount", String(msats), invoice.paymentRequest],
        ["e", request.id],
        ["p", request.pubkey],
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
  request: Event<5300>;
  timePeriod: TimePeriod;
  input?: Job;
  paymentRequest?: string;
  paymentHash?: string;
};

const pendingJobs = new Map<string, Job>();
const previousJobs = new Map<string, Job>();

async function buildJob(request: Event<5300>): Promise<Job> {
  const input = getInput(request);
  const timePeriod = (getInputParam(request, "timePeriod") as TimePeriod) || TimePeriod.year;

  if (!Object.values(TimePeriod).includes(timePeriod)) throw new Error(`Known time period ${timePeriod}`);

  if (!request.tags.some((t) => t[0] === "p" && t[1] === pubkey)) throw new Error("Not addressed to me");

  if (input && input.type === "event") {
    const prevJob = previousJobs.get(input.value);
    if (!prevJob) throw new PublicError("Cant find old job");
    return { input: prevJob, request, timePeriod };
  }

  return { request, timePeriod };
}

function getMinDate(request: Event, timePeriod: TimePeriod) {
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
  appDebug(`Starting work for ${job.request.id}`);

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

  const events = rows.map((r) => JSON.parse(r.content) as Event<1>);

  const result = finishEvent(
    {
      kind: DMV_CONTENT_RESULT_KIND,
      tags: [
        ["request", JSON.stringify(job.request)],
        ["e", job.request.id],
        ["p", job.request.pubkey],
        getInputTag(job.request),
      ].filter(Boolean),
      content: JSON.stringify(events.map((e) => ["e", e.id])),
      created_at: dayjs().unix(),
    },
    NOSTR_PRIVATE_KEY,
  );

  appDebug(`Returning page ${page} to ${job.request.id}`);
  await sendResponse(job.request, result);
}

appDebug("Publishing relay list");
await pool.publish(
  [...RELAYS, "wss://purplepag.es"],
  finishEvent(
    { kind: 10002, content: "", tags: RELAYS.map((r) => ["r", r]), created_at: dayjs().unix() },
    NOSTR_PRIVATE_KEY,
  ),
);

const jobsSub = pool.sub(RELAYS, [{ kinds: [DMV_CONTENT_REQUEST_KIND], since: dayjs().unix(), "#p": [pubkey] }]);
jobsSub.on("event", async (event) => {
  if (event.kind === DMV_CONTENT_REQUEST_KIND && !pendingJobs.has(event.id) && !previousJobs.has(event.id)) {
    try {
      const job = await buildJob(event);
      try {
        appDebug(`Requesting payment for ${job.request.id}`);
        const invoice = await requestPayment(job.request, 10 * 1000);
        job.paymentHash = invoice.paymentHash;
        job.paymentRequest = invoice.paymentRequest;
        pendingJobs.set(job.request.id, job);
      } catch (e) {
        console.log(e);
        if (e instanceof Error) {
          appDebug(`Failed to request payment for ${event.id}`);
          console.log(e);
        }
      }
    } catch (e) {
      if (e instanceof PublicError) await sendError(event, e);
      else if (e instanceof Error) appDebug(`Skipped request ${event.id} because`, e.message);
    }
  }
});

function checkInvoices() {
  for (let [id, job] of pendingJobs) {
    if (!job.paymentHash) pendingJobs.delete(id);
    appDebug(`Checking payment for ${id}`);

    lightning.getInvoiceStatus(job.paymentHash).then(async (status) => {
      if (status === InvoiceStatus.PAID) {
        // remove from queue
        pendingJobs.delete(id);

        try {
          await doWork(job);
          previousJobs.set(id, job);
        } catch (e) {
          if (e instanceof PublicError) await sendError(job.request, e);
          else if (e instanceof Error) {
            appDebug(`Failed to process ${id}`);
            console.log(e);
          }
        }
      } else if (status === InvoiceStatus.EXPIRED) pendingJobs.delete(id);
    });
  }
}
setInterval(checkInvoices, 5 * 1000);

setInterval(ensureConnection, 1000 * 30);

async function shutdown() {
  process.exit();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.once("SIGUSR2", shutdown);
