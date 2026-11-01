import { timingSafeEqual } from "node:crypto";

const API_URL = "https://www.tikwm.com/api/";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function checkApiKey(request) {
  const secret = process.env.API_KEY;

  if (!secret) return false;

  const supplied = request.headers.get("x-api-key") || "";

  const a = Buffer.from(secret);
  const b = Buffer.from(supplied);

  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

function isTikTokUrl(value) {
  try {
    const url = new URL(value);

    const allowedHosts = [
      "tiktok.com",
      "www.tiktok.com",
      "vm.tiktok.com",
      "vt.tiktok.com"
    ];

    return allowedHosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function formatDate(timestamp) {
  if (!timestamp) return null;

  const date = new Date(Number(timestamp) * 1000);

  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString();
}

function formatDuration(seconds) {
  if (seconds === undefined || seconds === null) {
    return null;
  }

  const total = Number(seconds);

  if (!Number.isFinite(total)) return null;

  const minutes = Math.floor(total / 60);
  const remaining = Math.floor(total % 60);

  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function getNumber(value) {
  if (value === undefined || value === null) return null;

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

export default async (request) => {
  if (request.method !== "POST") {
    return json({
      status: false,
      message: "Method not allowed. Use POST."
    }, 405);
  }

  if (!checkApiKey(request)) {
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

    if (!isTikTokUrl(videoUrl)) {
      return json({
        status: false,
        message: "URL TikTok tidak valid."
      }, 400);
    }

    const form = new URLSearchParams();
    form.append("url", videoUrl);
    form.append("hd", "1");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    let response;

    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0"
        },
        body: form.toString(),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return json({
        status: false,
        message: "TikWM sedang tidak merespons.",
        httpStatus: response.status
      }, 502);
    }

    const result = await response.json();

    if (result.code !== 0 || !result.data) {
      return json({
        status: false,
        message: result.msg || "Gagal mengambil data TikTok."
      }, 502);
    }

    const data = result.data;
    const author = data.author || {};
    const music = data.music_info || {};

    const videoMeta = data.video_meta || data.videoMeta || {};

    const output = {
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
        width: getNumber(videoMeta.width || data.width),
        height: getNumber(videoMeta.height || data.height),
        fps: getNumber(videoMeta.fps || data.fps),
        bitrate: getNumber(videoMeta.bitrate || data.bitrate),
        codec: videoMeta.codec || data.codec || null,
        size: getNumber(data.size),
        hdSize: getNumber(data.hd_size),
        playUrlAvailable: Boolean(data.play),
        hdUrlAvailable: Boolean(data.hdplay)
      }
    };

    return json(output);

  } catch (error) {
    console.error("ANALYZE ERROR:", error);

    if (error.name === "AbortError") {
      return json({
        status: false,
        message: "Permintaan ke TikWM timeout."
      }, 504);
    }

    return json({
      status: false,
      message: "Terjadi kesalahan saat menganalisis video."
    }, 500);
  }
};