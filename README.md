import { createWorker } from "tesseract.js";

const KST_TZ = "Asia/Seoul";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function getDefaultOcrYear() {
  const envYear = parseInt(process.env.OCR_DEFAULT_YEAR || "", 10);
  if (!Number.isNaN(envYear)) return envYear;

  return parseInt(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: KST_TZ,
      year: "numeric",
    }).format(new Date()),
    10
  );
}

export function msToKstDate(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export function msToKstDateTime(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
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

function applyAmPm(hour, ampm) {
  let h = parseInt(hour, 10);
  const marker = (ampm || "").toUpperCase();

  if ((marker === "오후" || marker === "PM") && h !== 12) h += 12;
  if ((marker === "오전" || marker === "AM") && h === 12) h = 0;

  return h;
}

function parseTimestampText(text) {
  const normalized = text
    .replace(/[：]/g, ":")
    .replace(/\s+/g, " ")
    .trim();

  // Examples:
  // 2026년 6월 22일 오전 10:30
  // 2026. 6. 22. 오후 1:05
  // 2026-06-22 10:30
  // 2026/06/22 PM 1:05
  const fullDateMatch = normalized.match(
    /(20\d{2})\D{0,6}(\d{1,2})\D{0,6}(\d{1,2})\D{0,30}(오전|오후|AM|PM)?\D{0,8}(\d{1,2}):(\d{2})(?::(\d{2}))?/i
  );

  if (fullDateMatch) {
    const [, y, mo, d, ampm, hRaw, mi, s] = fullDateMatch;
    return {
      y: +y,
      mo: +mo,
      d: +d,
      h: applyAmPm(hRaw, ampm),
      mi: +mi,
      s: +(s || 0),
    };
  }

  // Examples:
  // 6월 22일 오전 10:30
  // 6/22 10:30
  // 06.22 오후 1:05
  // OCR_DEFAULT_YEAR is used when the photo timestamp has no year.
  const noYearMatch = normalized.match(
    /(?:^|\D)(\d{1,2})\s*(?:월|[.\/-])\s*(\d{1,2})\s*(?:일)?\D{0,30}(오전|오후|AM|PM)?\D{0,8}(\d{1,2}):(\d{2})(?::(\d{2}))?/i
  );

  if (noYearMatch) {
    const [, mo, d, ampm, hRaw, mi, s] = noYearMatch;
    return {
      y: getDefaultOcrYear(),
      mo: +mo,
      d: +d,
      h: applyAmPm(hRaw, ampm),
      mi: +mi,
      s: +(s || 0),
    };
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
  const fallbackMs = parseFloat(fallbackTs) * 1000;

  try {
    const url = file.url_private_download || file.url_private;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (!res.ok) {
      return { time: fallbackMs, source: "upload", reason: `download failed: ${res.status}` };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const worker = await getOcrWorker();
    const {
      data: { text },
    } = await worker.recognize(buf);

    const match = parseTimestampText(text);
    if (match) {
      const { y, mo, d, h, mi, s } = match;
      const ms = Date.UTC(y, mo - 1, d, h, mi, s) - KST_OFFSET_MS;
      if (!Number.isNaN(ms)) {
        if (process.env.DEBUG_OCR === "1") {
          console.log("OCR OK", {
            file: file.name || file.id,
            parsedKst: msToKstDateTime(ms),
            text: text.replace(/\s+/g, " ").trim().slice(0, 180),
          });
        }
        return { time: ms, source: "ocr" };
      }
    }

    if (process.env.DEBUG_OCR === "1") {
      console.log("OCR FAILED - using Slack upload time", {
        file: file.name || file.id,
        uploadKst: msToKstDateTime(fallbackMs),
        text: text.replace(/\s+/g, " ").trim().slice(0, 180),
      });
    }
    return { time: fallbackMs, source: "upload", reason: "ocr timestamp not parsed" };
  } catch (e) {
    if (process.env.DEBUG_OCR === "1") {
      console.log("OCR ERROR - using Slack upload time", {
        file: file.name || file.id,
        uploadKst: msToKstDateTime(fallbackMs),
        error: e.message,
      });
    }
    return { time: fallbackMs, source: "upload", reason: e.message };
  }
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
        const photo = await getPhotoTimeMs(f, token, m.ts);
        events.push({
          user: m.user,
          time: photo.time,
          source: photo.source,
          reason: photo.reason,
          fileName: f.name || f.id,
          uploadTime: parseFloat(m.ts) * 1000,
        });
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
        singleDays.push({ user, date, reason: "사진 1장만 확인됨" });
        continue;
      }

      const start = list[0].time;
      const end = list[list.length - 1].time;
      const diffMinutes = (end - start) / 60000;

      if (diffMinutes >= minMinutes) {
        validDaysByUser[user] += 1;
      } else {
        singleDays.push({ user, date, reason: `시간 미달 (${Math.round(diffMinutes)}분)` });
      }
    }
  }

  return { validDaysByUser, singleDays };
}
