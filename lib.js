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

// 연도는 OCR로 읽으면 "년"이 "1"로 잘못 인식되는 경우가 많아서 아예 시도하지 않고
// 고정값(기본 2026, TEST_YEAR 환경변수로 조정 가능)을 사용함.
// 월/일/오전·오후/시:분만 정확히 뽑아내는 데 집중.
// (오전|오후)를 선택사항이 아니라 필수로 만들어서, 앞의 잡다한 글자를 담당하는
// [\s\S]{0,25}? 가 "오전/오후" 글자 자체를 잡음으로 삼켜버리는 걸 방지함.
const DATE_TIME_REGEX =
  /(\d{1,2})\s*월\s*(\d{1,2})\s*일?[\s\S]{0,25}?(오전|오후)\s*(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2}))?/;

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
  if (!m) return null;

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

let workerPromise = null;

async function getOcrWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker(["eng", "kor"]);
      await worker.setParameters({
        tessedit_char_whitelist:
          "0123456789년월일시분초오전후요화수목금토():./ -",
        tessedit_pageseg_mode: "6", // 균일한 텍스트 블록 하나로 가정 (사진 속 잘라낸 텍스트에 적합)
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

// 일반 사진(가로세로 비율이 정사각형~약간 세로로 긴 정도)은 텍스트가 보통 하단에 있어서
// "하단 N%" 형태로 여러 범위를 시도함.
// 아이폰 스크린샷처럼 매우 세로로 긴 이미지(사진 미리보기 화면 전체를 캡처한 경우)는
// 위/아래에 UI 여백(상태바, 공유·복사·저장 버튼 등)이 많아서 실제 텍스트는 중간 어딘가에 있음 ->
// 중간 구간 위주로 별도 범위를 시도함.
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
    .resize({ width: width * 2 }) // 2배 확대
    .grayscale()
    .normalize() // 명암 대비 강화 (이진화/과도한 선명화는 글자를 오히려 손상시켜서 사용 안 함)
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

    // 여러 크롭 범위를 순서대로 시도 (사진마다 텍스트 위치가 다를 수 있어서)
    let text = "";
    let match = null;
    for (const band of bands) {
      try {
        text = await ocrCropRegion(worker, buf, width, height, band);
        match = parseTimestampText(text);
        if (match) break;
      } catch (e) {
        // 이 크롭 범위 실패 -> 다음 범위 시도
      }
    }

    // 모든 크롭 범위가 실패하면, 마지막으로 전체 이미지로 한 번 더 시도
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
        // 2차 시도도 실패하면 아래에서 upload 시각으로 대체
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
