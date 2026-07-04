import { createWorker } from "tesseract.js";

const KST_TZ = "Asia/Seoul";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 밀리초 타임스탬프 -> KST 기준 "YYYY-MM-DD" 문자열
export function msToKstDate(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

// 채널의 전체 멤버(사람) 목록 조회 - 봇 계정은 제외
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

// 사진에 찍힌 "타임스탬프" 문자를 OCR로 읽어서 날짜/시간을 뽑아내는 정규식들
// 지원 형식 예:
//   1) 2026년 7월 4일 (토) / 오후 4:27      <- 타임스탬프 카메라 앱 (기본으로 이 형식을 가정)
//   2) 2026-07-04 16:29:02 / 2026.07.04 16:29
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

// 사진 파일 하나에서 OCR로 타임스탬프를 읽음. 실패하면 업로드(메시지) 시각으로 대체
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
        // 사진에 찍힌 시간은 이미 한국 현지 시각이라고 가정하고, 그 기준으로 실제 UTC ms를 역산
        const ms = Date.UTC(y, mo - 1, d, h, mi, s) - KST_OFFSET_MS;
        if (!isNaN(ms)) {
          return { time: ms, source: "ocr" };
        }
      }
    }
  } catch (e) {
    // OCR 실패 -> 아래 fallback 사용
  }
  return { time: parseFloat(fallbackTs) * 1000, source: "upload" };
}

// 지정 기간(oldest~latest, Slack ts 문자열) 동안 채널에 올라온 모든 사진의 "실제 시각" 목록을 가져옴
// 한 메시지에 사진이 여러 장 첨부되어 있어도 각각 개별 이벤트로 처리함
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

// 사람별/날짜별로 그룹핑 후 "시작~끝" 30분 이상인 날을 판별
// 사진이 1장뿐인 날은 별도로 singleDays 목록에 담아서 반환 (참고용)
export function computeValidDays(events, minMinutes = 30) {
  const byUserDate = {}; // { userId: { date: [{time, source}, ...] } }

  for (const e of events) {
    const date = msToKstDate(e.time);
    byUserDate[e.user] ??= {};
    byUserDate[e.user][date] ??= [];
    byUserDate[e.user][date].push(e);
  }

  const validDaysByUser = {}; // { userId: count }
  const singleDays = []; // [{ user, date }]

  for (const [user, dates] of Object.entries(byUserDate)) {
    validDaysByUser[user] = 0;
    for (const [date, list] of Object.entries(dates)) {
      list.sort((a, b) => a.time - b.time);
      if (list.length === 1) {
        singleDays.push({ user, date });
        continue;
      }
      const start = list[0].time;
      const end = list[1].time; // 3장 이상 올라와도 시간상 가장 이른 2개만 사용
      const diffMinutes = (end - start) / 60000;
      if (diffMinutes >= minMinutes) {
        validDaysByUser[user] += 1;
      }
    }
  }

  return { validDaysByUser, singleDays };
}
