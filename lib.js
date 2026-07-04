import { createWorker } from "tesseract.js";
import sharp from "sharp";

const KST_TZ = "Asia/Seoul";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DEFAULT_YEAR = parseInt(process.env.TEST_YEAR || "2026", 10);

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
      roster.push({
        id,
        name: u.profile.display_name || u.real_name || u.name,
      });
    }
  }

  return roster;
}

const DATE_TIME_REGEX =
  /(\d{1,2})\s*월\s*(\d{1,2})\s*일?[\s\S]{0,25}?(오전|오후)\s*(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2}))?/;

const DATE_TIME_NOCOLON_REGEX =
  /(\d{1,2})\s*월\s*(\d{1,2})\s*일?[\s\S]{0,25}?(오전|오후)\s*(\d{3,4})(?!\d)/;

function splitNoColonTime(digits) {
  if (digits.length === 3) {
    return { h: +digits.slice(0, 1), mi: +digits.slice(1) };
  }
  return { h: +digits.slice(0, 2), mi: +digits.slice(2) };
}

function normalizeOcrText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function applyAmPm(hRaw, ampm) {
  let h = parseInt(hRaw, 10);

  if (ampm === "오후" && h !== 12) h += 12;
  if (ampm === "오전" && h === 12) h = 0;

  return h;
}

function parseTimestampText(text) {
  const normalized = normalizeOcrText(text);

  const m = normalized.match(DATE_TIME_REGEX);
  if (m) {
    const [, mo, d, ampm, hRaw, mi, s] = m;
    return {
      y: DEFAULT_YEAR,
      mo: +mo,
      d: +d,
      h: applyAmPm(hRaw, ampm),
      mi: +mi,
      s: +(s || 0),
    };
  }

  const nc = normalized.match(DATE_TIME_NOCOLON_REGEX);
  if (nc) {
    const [, mo, d, ampm, digits] = nc;
    const { h: hRaw, mi } = splitNoColonTime(digits);
    return {
      y: DEFAULT_YEAR,
      mo: +mo,
      d: +d,
      h: applyAmPm(String(hRaw), ampm),
      mi,
      s: 0,
    };
  }

  return null;
}

let workerPromise = null;

async function getOcrWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker(["eng", "kor"]);
      await worker.setParameters({
        tessedit_char_whitelist:
          "0123456789년월일시분초오전후요화수목금토():./ -",
        tessedit_pageseg_mode: "6",
      });
      return worker;
    })();
  }
  return workerPromise;
}

export async function closeOcrWorker() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}

const NORMAL_BANDS = [
  [0.82, 1],
  [0.75, 1],
  [0.68, 1],
  [0.6, 1],
  [0.5, 1],
  [0.4, 1],
  [0.3, 1],
];
const TALL_BANDS = [
  [0.55, 0.85],
  [0.45, 0.8],
  [0.35, 0.7],
  [0.6, 0.9],
  [0.25, 0.6],
];

function getCandidateBands(width, height) {
  const ratio = height / width;
  if (ratio > 1.5) {
    return [...TALL_BANDS, ...NORMAL_BANDS];
  }
  return NORMAL_BANDS;
}

async function ocrCropRegion(worker, buf, width, height, [topFrac, bottomFrac]) {
  const cropTop = Math.floor(height * topFrac);
  const cropBottom = Math.floor(height * bottomFrac);
  const cropHeight = Math.max(cropBottom - cropTop, 1);

  const processed = await sharp(buf)
    .extract({ left: 0, top: cropTop, width, height: cropHeight })
    .resize({ width: width * 2 })
    .grayscale()
    .normalize()
    .png()
    .toBuffer();

  const {
    data: { text },
  } = await worker.recognize(processed);
  return text;
}

async function getPhotoTimeMs(file, token, fallbackTs) {
  const uploadTime = parseFloat(fallbackTs) * 1000;

  try {
    const url = file.url_private_download || file.url_private;

    if (!url) {
      return {
        time: uploadTime,
        source: "upload",
        reason: "no_file_download_url",
        fileName: file.name || file.title || "",
        uploadTime,
      };
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      return {
        time: uploadTime,
        source: "upload",
        reason: `download_failed_${res.status}`,
        fileName: file.name || file.title || "",
        uploadTime,
      };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const worker = await getOcrWorker();

    const meta = await sharp(buf).metadata();
    const width = meta.width || 1000;
    const height = meta.height || 1000;
    const bands = getCandidateBands(width, height);

    let text = "";
    let match = null;
    const attempts = [];
    for (const band of bands) {
      try {
        text = await ocrCropRegion(worker, buf, width, height, band);
        attempts.push({ band, text: normalizeOcrText(text).slice(0, 200) });
        match = parseTimestampText(text);
        if (match) break;
      } catch (e) {
        attempts.push({ band, text: `(오류: ${e.message})` });
      }
    }

    if (!match) {
      try {
        const fullImg = await sharp(buf)
          .grayscale()
          .normalize()
          .resize({ width: 1600, withoutEnlargement: false })
          .png()
          .toBuffer();
        const result2 = await worker.recognize(fullImg);
        const match2 = parseTimestampText(result2.data.text);
        if (match2) {
          match = match2;
          text = result2.data.text;
        } else if (!text) {
          text = result2.data.text;
        }
      } catch (e) {
        // 실패 시 아래에서 upload 시각으로 대체
      }
    }

    if (!match) {
      try {
        await worker.setParameters({ tessedit_char_whitelist: "" });
        const best = bands[0];
        const retryText = await ocrCropRegion(worker, buf, width, height, best);
        const match3 = parseTimestampText(retryText);
        if (match3) {
          match = match3;
          text = retryText;
        }
      } catch (e) {
        // 실패하면 아래에서 upload 시각으로 대체
      } finally {
        await worker.setParameters({
          tessedit_char_whitelist:
            "0123456789년월일시분초오전후요화수목금토():./ -",
        });
      }
    }

    if (match) {
      const { y, mo, d, h, mi, s } = match;
      const ms = Date.UTC(y, mo - 1, d, h, mi, s) - KST_OFFSET_MS;

      if (!Number.isNaN(ms)) {
        return {
          time: ms,
          source: "ocr",
          reason: "ocr_success",
          fileName: file.name || file.title || "",
          uploadTime,
          ocrText: normalizeOcrText(text).slice(0, 300),
        };
      }
    }

    return {
      time: uploadTime,
      source: "upload",
      reason: "ocr_no_timestamp_match",
      fileName: file.name || file.title || "",
      uploadTime,
      ocrText: normalizeOcrText(text).slice(0, 300),
      attempts,
    };
  } catch (e) {
    return {
      time: uploadTime,
      source: "upload",
      reason: `error_${e.message}`,
      fileName: file.name || file.title || "",
      uploadTime,
    };
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

      const imageFiles = (m.files || []).filter((f) =>
        (f.mimetype || "").startsWith("image/")
      );

      for (const f of imageFiles) {
        const result = await getPhotoTimeMs(f, token, m.ts);

        events.push({
          user: m.user,
          time: result.time,
          source: result.source,
          reason: result.reason,
          fileName: result.fileName,
          uploadTime: result.uploadTime,
          ocrText: result.ocrText,
          attempts: result.attempts,
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
        singleDays.push({
          user,
          date,
          reason: "사진 1장만 확인됨",
        });
        continue;
      }

      const start = list[0].time;
      const end = list[list.length - 1].time;
      const diffMinutes = (end - start) / 60000;

      if (diffMinutes >= minMinutes) {
        validDaysByUser[user] += 1;
      } else {
        singleDays.push({
          user,
          date,
          reason: `시간 미달 (${Math.round(diffMinutes)}분)`,
        });
      }
    }
  }

  return { validDaysByUser, singleDays };
}
