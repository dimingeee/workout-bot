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

const VISION_SYSTEM_PROMPT = `너는 사진 속에 찍혀 있는 "타임스탬프 카메라" 오버레이 텍스트를 읽는 도구야.
사진에는 보통 "2026년 7월 1일 (수)" 같은 날짜와 "오후 10:26" 같은 시간이 흰색 굵은 글씨로 찍혀 있어.
사진을 보고 그 날짜와 시간을 정확히 읽어서, 다른 설명 없이 아래 JSON 형식으로만 답해.

타임스탬프를 찾았으면:
{"found": true, "year": 2026, "month": 7, "day": 1, "hour24": 22, "minute": 26}

타임스탬프를 못 찾았으면:
{"found": false}

- hour24는 24시간제 기준이야 (오후 10:26 -> hour24: 22, 오전 12:00 -> hour24: 0, 오후 12:00 -> hour24: 12)
- JSON 객체 하나만 답하고, 마크다운 코드블록이나 다른 설명은 절대 붙이지 마.`;

async function extractTimestampViaVision(imageBuffer, mimetype, apiKey) {
  const base64 = imageBuffer.toString("base64");
  const mediaType = mimetype || "image/png";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: VISION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
            },
            { type: "text", text: "이 사진의 타임스탬프를 읽어줘." },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`anthropic_api_${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((c) => c.type === "text");
  if (!textBlock) throw new Error("no_text_in_response");

  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

async function getPhotoTimeMs(file, slackToken, anthropicApiKey, fallbackTs) {
  const uploadTime = parseFloat(fallbackTs) * 1000;
  const fileName = file.name || file.title || "";

  try {
    const url = file.url_private_download || file.url_private;
    if (!url) {
      return {
        time: uploadTime,
        source: "upload",
        reason: "no_file_download_url",
        fileName,
        uploadTime,
      };
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${slackToken}` },
    });
    if (!res.ok) {
      return {
        time: uploadTime,
        source: "upload",
        reason: `download_failed_${res.status}`,
        fileName,
        uploadTime,
      };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const parsed = await extractTimestampViaVision(buf, file.mimetype, anthropicApiKey);

    if (parsed && parsed.found) {
      const ms =
        Date.UTC(parsed.year, parsed.month - 1, parsed.day, parsed.hour24, parsed.minute, 0) -
        KST_OFFSET_MS;

      if (!Number.isNaN(ms)) {
        return {
          time: ms,
          source: "vision",
          reason: "vision_success",
          fileName,
          uploadTime,
        };
      }
    }

    return {
      time: uploadTime,
      source: "upload",
      reason: "vision_no_timestamp",
      fileName,
      uploadTime,
    };
  } catch (e) {
    return {
      time: uploadTime,
      source: "upload",
      reason: `error_${e.message}`,
      fileName,
      uploadTime,
    };
  }
}

export async function fetchPhotoEvents(
  slack,
  slackToken,
  anthropicApiKey,
  channelId,
  oldest,
  latest
) {
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
        const result = await getPhotoTimeMs(f, slackToken, anthropicApiKey, m.ts);

        events.push({
          user: m.user,
          time: result.time,
          source: result.source,
          reason: result.reason,
          fileName: result.fileName,
          uploadTime: result.uploadTime,
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
