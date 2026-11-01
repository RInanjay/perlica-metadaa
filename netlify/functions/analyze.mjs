const crypto = require("node:crypto");

const TIKWM_API = "https://www.tikwm.com/api/";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function safeEqual(a, b) {
  if (!a || !b) return false;

  const first = Buffer.from(a);
  const second = Buffer.from(b);

  if (first.length !== second.length) return false;

  return crypto.timingSafeEqual(first, second);
}

function validTikTokUrl(value) {
  try {
    const url = new URL(value);

    return [
      "tiktok.com",
      "www.tiktok.com",
      "m.tiktok.com",
      "vm.tiktok.com",
      "vt.tiktok.com"
    ].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function getNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatDate(timestamp) {
  if (!timestamp) return null;

  const date = new Date(Number(timestamp) * 1000);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return null;

  const total = Number(seconds);

  if (!Number.isFinite(total)) return null;

  const minutes = Math.floor(total / 60);
  const remaining = Math.floor(total % 60);

  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

async function getTikTokData(url) {
  const form = new URLSearchParams();

  form.append("url", url);
  form.append("hd", "1");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(TIKWM_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      },
      body: form.toString(),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`TikWM HTTP ${response.status}`);
    }

    const result = await response.json();

    if (Number(result.code) !== 0 || !result.data) {
      throw new Error(
        result.msg || "Gagal mengambil data TikTok dari TikWM."
      );
    }

    return result.data;
  } finally {
    clearTimeout(timeout);
  }
}

async function getVideoMetadata(mediaUrl) {
  const serviceUrl = process.env.METADATA_API_URL;
  const serviceKey = process.env.METADATA_API_KEY;

  if (!serviceUrl || !serviceKey) {
    throw new Error("Metadata service belum dikonfigurasi.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);

  try {
    const response = await fetch(
      `${serviceUrl.replace(/\/+$/, "")}/analyze`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": serviceKey
        },
        body: JSON.stringify({ mediaUrl }),
        signal: controller.signal
      }
    );

    const result = await response.json();

    if (!response.ok || !result.status) {
      throw new Error(
        result.message || "Gagal membaca metadata video."
      );
    }

    return result.metadata;
  } finally {
    clearTimeout(timeout);
  }
}

export default async (request) => {
  if (request.method !== "POST") {
    return json({
      status: false,
      message: "Gunakan metode POST."
    }, 405);
  }

  const apiKey = process.env.API_KEY;
  const suppliedKey = request.headers.get("x-api-key");

  if (!apiKey) {
    return json({
      status: false,
      message: "API_KEY belum dikonfigurasi di Netlify."
    }, 500);
  }

  if (!safeEqual(apiKey, suppliedKey)) {
    return json({
      status: false,
      message: "Unauthorized. API key tidak valid."
    }, 401);
  }

  try {
    const body = await request.json();
    const videoUrl = body.url;

    if (!videoUrl || typeof videoUrl !== "string") {
      return json({
        status: false,
        message: "Masukkan URL TikTok."
      }, 400);
    }

    if (!validTikTokUrl(videoUrl)) {
      return json({
        status: false,
        message: "URL TikTok tidak valid."
      }, 400);
    }

    const data = await getTikTokData(videoUrl);

    const author = data.author || {};
    const music = data.music_info || {};

    const mediaUrl = data.hdplay || data.play || null;

    let metadata = null;
    let metadataError = null;

    if (mediaUrl) {
      try {
        metadata = await getVideoMetadata(mediaUrl);
      } catch (error) {
        metadataError = error.name === "AbortError"
          ? "Metadata service timeout."
          : error.message;
      }
    } else {
      metadataError = "URL video tidak disediakan TikWM.";
    }

    return json({
      status: true,
      creator: "Perlica",

      video: {
        id: data.id || null,
        title: data.title || null,
        createTime: formatDate(data.create_time),
        duration: getNumber(data.duration),
        durationText: formatDuration(data.duration),
        cover: data.cover || null,
        region: data.region || null,
        source: "TikWM"
      },

      author: {
        id: author.id || null,
        username: author.unique_id || null,
        nickname: author.nickname || null,
        avatar: author.avatar || null
      },

      music: {
        id: music.id || null,
        title: music.title || null,
        author: music.author || null
      },

      statistics: {
        views: getNumber(data.play_count),
        likes: getNumber(data.digg_count),
        comments: getNumber(data.comment_count),
        favorites: getNumber(data.collect_count),
        shares: getNumber(data.share_count),
        downloads: getNumber(data.download_count)
      },

      quality: {
        width: metadata?.width ?? null,
        height: metadata?.height ?? null,
        resolution: metadata?.resolution ?? null,
        fps: metadata?.fps ?? null,
        codec: metadata?.codec ?? null,
        format: metadata?.format ?? null,
        bitrate: metadata?.bitrate ?? null,
        size: metadata?.size ?? getNumber(data.size),
        hdSize: getNumber(data.hd_size),
        playUrlAvailable: Boolean(data.play),
        hdUrlAvailable: Boolean(data.hdplay),
        metadataSource: metadata ? "FFprobe" : null,
        metadataError
      }
    });
  } catch (error) {
    console.error("[PERLICA ANALYZE]", error);

    return json({
      status: false,
      message: error.name === "AbortError"
        ? "Permintaan timeout."
        : error.message || "Gagal menganalisis video."
    }, 500);
  }
};
