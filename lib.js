import { createWorker } from "tesseract.js";

const KST_TZ = "Asia/Seoul";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function msToKstDate(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export async function getRosterUserIds(slack, channelId) {
  const memberIds = [];
  let cursor;
  do {
    const res = await slack.conversations.members({
      channel: channelId,
      cursor,
      limit: 200,
    });
    memberIds.push(...res.members);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const roster = [];
  for (const id of memberIds) {
    const info = await slack.users.info({ user: id });
    const u = info.user;
    if (!u.is_bot && !u.deleted && id !== "USLACKBOT") {
      roster.push({ id, name: u.profile.display_name || u.real_name || u.name });
    }
  }
  return roster;
}

const KOREAN_TIMESTAMP_REGEX =
  /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일[\s\S]{0,15}?(오전|오후)\s*(\d{1,2}):(\d{2})/;
const ISO_TIMESTAMP_REGEX =
  /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\D{1,8}(\d{1,2}):(\d{2})(?::(\d{2}))?/;

function parseTimestampText(text) {
  const kMatch = text.match(KOREAN_TIMESTAMP_REGEX);
  if (kMatch) {
    const [, y, mo, d, ampm, hRaw, mi] = kMatch;
    let h = parseInt(hRaw, 10);
    if (ampm === "오후" && h !== 12) h += 12;
    if (ampm === "오전" && h === 12) h = 0;
    return { y: +y, mo: +mo, d: +d, h, mi: +mi, s: 0 };
  }

  const iMatch = text.match(ISO_TIMESTAMP_REGEX);
  if (iMatch) {
    const [, y, mo, d, h, mi, s] = iMatch;
    return { y: +y, mo: +mo, d: +d, h: +h, mi: +mi, s: +(s || 0) };
  }

  return null;
}

let workerPromise = null;
async function getOcrWorker() {
  workerPromise ??= createWorker(["eng", "kor"]);
  return workerPromise;
}

export async function closeOcrWorker() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}

async function getPhotoTimeMs(file, token, fallbackTs) {
  try {
    const url = file.url_private_download || file.url_private;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      const worker = await getOcrWorker();
      const {
        data: { text },
      } = await worker.recognize(buf);

      const match = parseTimestampText(text);
      if (match) {
        const { y, mo, d, h, mi, s } = match;
        const ms = Date.UTC(y, mo - 1, d, h, mi, s) - KST_OFFSET_MS;
        if (!isNaN(ms)) {
          return { time: ms, source: "ocr" };
        }
      }
    }
  } catch (e) {
  }
  return { time: parseFloat(fallbackTs) * 1000, source: "upload" };
}

export async function fetchPhotoEvents(slack, token, channelId, oldest, latest) {
  const events = [];
  let cursor;
  do {
    const res = await slack.conversations.history({
      channel: channelId,
      oldest,
      latest,
      cursor,
      limit: 200,
    });
    for (const m of res.messages) {
      if (!m.user) continue;
      const imageFiles = (m.files || []).filter((f) => (f.mimetype || "").startsWith("image/"));
      for (const f of imageFiles) {
        const { time, source } = await getPhotoTimeMs(f, token, m.ts);
        events.push({ user: m.user, time, source });
      }
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return events;
}

export function computeValidDays(events, minMinutes = 30) {
  const byUserDate = {};

  for (const e of events) {
    const date = msToKstDate(e.time);
    byUserDate[e.user] ??= {};
    byUserDate[e.user][date] ??= [];
    byUserDate[e.user][date].push(e);
  }

  const validDaysByUser = {};
  const singleDays = [];

  for (const [user, dates] of Object.entries(byUserDate)) {
    validDaysByUser[user] = 0;
    for (const [date, list] of Object.entries(dates)) {
      list.sort((a, b) => a.time - b.time);
      if (list.length === 1) {
        singleDays.push({ user, date });
        continue;
      }
      const start = list[0].time;
      const end = list[list.length - 1].time; // Use the last photo time to get full duration
      const diffMinutes = (end - start) / 60000;
      if (diffMinutes >= minMinutes) {
        validDaysByUser[user] += 1;
      } else {
        // If photos exist but time difference is less than 30 mins, treat as insufficient time day
        singleDays.push({ user, date, reason: `시간 미달 (${Math.round(diffMinutes)}분)` });
      }
    }
  }

  return { validDaysByUser, singleDays };
}