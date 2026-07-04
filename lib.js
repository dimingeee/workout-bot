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

const KOREAN_TIMESTAMP_REGEX =
  /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일[\s\S]{0,30}?(오전|오후)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/;

const ISO_TIMESTAMP_REGEX =
  /(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})[일.]?\D{0,20}(오전|오후)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/;

const NO_YEAR_TIMESTAMP_REGEX =
  /(?:^|[^\d])(\d{1,2})\s*[.\-/월]\s*(\d{1,2})[일.]?\D{0,20}(오전|오후)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/;

function normalizeOcrText(text) {
  return text
    .replace(/[|]/g, "1")
    .replace(/[Oo]/g, "0")
    .replace(/\s+/g, " ")
    .trim();
}

function applyAmPm(hRaw, ampm) {
  let h = parseInt(hRaw, 10);

  if (ampm === "오후" && h !== 12) h += 12;
  if (ampm === "오전" && h === 12) h = 0;

  return h;
}

function toTimestampParts(match, hasYear) {
  if (hasYear) {
    const [, y, mo, d, ampm, hRaw, mi, s] = match;

    return {
      y: +y,
      mo: +mo,
      d: +d,
      h: applyAmPm(hRaw, ampm),
      mi: +mi,
      s: +(s || 0),
    };
  }

  const [, mo, d, ampm, hRaw, mi, s] = match;

  return {
    y: DEFAULT_YEAR,
    mo: +mo,
    d: +d,
    h: applyAmPm(hRaw, ampm),
    mi: +mi,
    s: +(s || 0),
  };
}

function parseTimestampText(text) {
  const normalized = normalizeOcrText(text);

  const kMatch = normalized.match(KOREAN_TIMESTAMP_REGEX);
  if (kMatch) return toTimestampParts(kMatch, true);

  const iMatch = normalized.match(ISO_TIMESTAMP_REGEX);
  if (iMatch) return toTimestampParts(iMatch, true);

  const nMatch = normalized.match(NO_YEAR_TIMESTAMP_REGEX);
  if (nMatch) return toTimestampParts(nMatch, false);

  return null;
}

let workerPromise = null;

async function getOcrWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker(["eng", "kor"]);
      // 타임스탬프에 나올 수 있는 글자만 허용해서 오인식을 줄임
      await worker.setParameters({
        tessedit_char_whitelist:
          "0123456789년월일시분초오전후요화수목금토():./ -",
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

// 타임스탬프 카메라 앱은 보통 사진 하단(왼쪽 또는 오른쪽)에 텍스트를 찍음.
// 배경 사진 노이즈 때문에 OCR이 실패하는 걸 줄이기 위해, 하단 영역만 잘라내고
// 확대 + 흑백 변환 + 대비 강화 + 이진화까지 해서 OCR 정확도를 높임.
async function preprocessForOcr(buf) {
  const image = sharp(buf);
  const meta = await image.metadata();
  const width = meta.width || 1000;
  const height = meta.height || 1000;

  const cropTop = Math.floor(height * 0.62); // 하단 38% 영역만 사용
  const cropHeight = height - cropTop;
  const cropWidth = Math.floor(width * 0.9);

  return sharp(buf)
    .extract({ left: 0, top: cropTop, width: cropWidth, height: cropHeight })
    .resize({ width: cropWidth * 2 }) // 2배 확대
    .grayscale()
    .normalize() // 명암 대비 강화
    .threshold(150) // 이진화 (밝은 글씨 vs 어두운 배경 분리)
    .png()
    .toBuffer();
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

    let ocrInput = buf;
    try {
      ocrInput = await preprocessForOcr(buf);
    } catch (e) {
      // 전처리 실패 시 원본 이미지로 OCR 시도
    }

    const {
      data: { text },
    } = await worker.recognize(ocrInput);

    const match = parseTimestampText(text);

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
