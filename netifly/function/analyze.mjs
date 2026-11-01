
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffprobeStatic from "ffprobe-static";

const execFileAsync = promisify(execFile);

const TIKWM_API = "https://www.tikwm.com/api/";
const FFPROBE_PATH = ffprobeStatic.path;

const ALLOWED_MEDIA_HOSTS = [
  "tikwm.com",
  "tiktok.com",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokcdn-eu.com",
  "tiktokcdn-in.com",
  "tiktokv.com",
  "byteoversea.com",
  "ibytedtos.com",
  "muscdn.com"
];

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
  const supplied = request.headers.get("x-api-key") || "";

  if (!secret) return "MISSING";

  const a = Buffer.from(secret);
  const b = Buffer.from(supplied);

  if (a.length !== b.length) return "INVALID";

  return crypto.timingSafeEqual(a, b) ? "OK" : "INVALID";
}

function isTikTokUrl(value) {
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

function isAllowedMediaUrl(value) {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:") return false;

    const hostname = url.hostname.toLowerCase();

    return ALLOWED_MEDIA_HOSTS.some(domain =>
      hostname === domain || hostname.endsWith("." + domain)
    );
  } catch {
    return false;
  }
}

function getNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function parseFPS(value) {
  if (!value || value === "0/0") return null;

  if (String(value).includes("/")) {
    const [numerator, denominator] = String(value)
      .split("/")
      .map(Number);

    if (!denominator || denominator <= 0) return null;

    return Number((numerator / denominator).toFixed(2));
  }

  return getNumber(value);
}

function getQuality(width, height) {
  if (!width || !height) return null;

  const shortSide = Math.min(width, height);

  if (shortSide >= 2160) return "4K";
  if (shortSide >= 1440) return "1440p";
  if (shortSide >= 1080) return "1080p";
  if (shortSide >= 720) return "720p";
  if (shortSide >= 480) return "480p";

  return "SD";
}

function normalizeFormat(value) {
  if (!value) return null;

  const formats = String(value).split(",");

  if (formats.includes("mp4")) return "MP4";
  if (formats.includes("mov")) return "MOV";
  if (formats.includes("webm")) return "WEBM";

  return formats[0].toUpperCase();
}

function formatDate(timestamp) {
  if (!timestamp) return null;

  const date = new Date(Number(timestamp) * 1000);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

async function getTikTokData(url) {
  const form = new URLSearchParams();

  form.append("url", url);
  form.append("hd", "1");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

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
        result.msg || "Gagal mengambil data TikTok."
      );
    }

    return result.data;
  } finally {
    clearTimeout(timeout);
  }
}

async function getVideoMetadata(mediaUrl) {
  if (!FFPROBE_PATH) {
    throw new Error("Binary FFprobe tidak ditemukan.");
  }

  if (!isAllowedMediaUrl(mediaUrl)) {
    throw new Error("Host media tidak diizinkan.");
  }

  const args = [
    "-v", "error",
    "-rw_timeout", "15000000",
    "-user_agent", "Mozilla/5.0",
    "-headers",
    "Referer: https://www.tiktok.com/\r\nAccept: */*\r\n",
    "-show_entries",
    "stream=codec_type,codec_name,profile,width,height,avg_frame_rate,r_frame_rate,bit_rate:format=format_name,duration,size,bit_rate",
    "-of", "json",
    mediaUrl
  ];

  const result = await execFileAsync(
    FFPROBE_PATH,
    args,
    {
      timeout: 25000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }
  );

  const probe = JSON.parse(result.stdout);

  const streams = probe.streams || [];
  const video = streams.find(
    stream => stream.codec_type === "video"
  );

  const format = probe.format || {};

  if (!video) {
    throw new Error("Stream video tidak ditemukan oleh FFprobe.");
  }

  const width = getNumber(video.width);
  const height = getNumber(video.height);

  const fps = parseFPS(
    video.avg_frame_rate || video.r_frame_rate
  );

  const bitrate = getNumber(
    video.bit_rate || format.bit_rate
  );

  return {
    width,
    height,
    resolution: width && height
      ? `${width}x${height}`
      : null,
    quality: getQuality(width, height),
    fps,
    codec: video.codec_name || null,
    profile: video.profile || null,
    format: normalizeFormat(format.format_name),
    bitrate,
    size: getNumber(format.size),
    duration: getNumber(format.duration),
    metadataSource: "FFprobe",
    actualMetadataAvailable: true
  };
}

function getLandingPage() {
  const html = `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#101827">
  <title>Perlica TikTok Analytics API</title>
  <style>
    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 28px 16px;
      min-height: 100vh;
      background: #0b1220;
      color: #e5edf8;
      font-family: system-ui, -apple-system, sans-serif;
      display: grid;
      place-items: center;
    }

    main {
      width: 100%;
      max-width: 680px;
      padding: 28px;
      border: 1px solid #263449;
      border-radius: 20px;
      background: #111c2d;
      box-shadow: 0 20px 60px #0005;
    }

    .mark {
      display: inline-grid;
      place-items: center;
      width: 48px;
      height: 48px;
      border-radius: 14px;
      background: #203b50;
      color: #6ee7d8;
      font-size: 25px;
      font-weight: 800;
    }

    h1 {
      margin: 18px 0 8px;
      font-size: clamp(25px, 6vw, 36px);
    }

    p {
      color: #aab9cc;
      line-height: 1.65;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin: 14px 0;
      padding: 8px 12px;
      border-radius: 999px;
      background: #12382f;
      color: #86efac;
      font-size: 14px;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #4ade80;
    }

    section {
      margin-top: 22px;
      padding: 18px;
      border: 1px solid #29384d;
      border-radius: 14px;
      background: #0c1626;
    }

    h2 {
      margin: 0 0 12px;
      font-size: 16px;
    }

    code, pre {
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    }

    code {
      color: #8be9df;
      overflow-wrap: anywhere;
    }

    pre {
      margin: 10px 0 0;
      padding: 14px;
      overflow-x: auto;
      border-radius: 10px;
      background: #070d17;
      color: #cbd5e1;
      font-size: 12px;
      line-height: 1.6;
    }

    footer {
      margin-top: 22px;
      color: #718198;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <main>
    <div class="mark">P</div>

    <h1>Perlica TikTok Analytics</h1>

    <div class="status">
      <span class="dot"></span>
      API Function is online
    </div>

    <p>
      Endpoint Netlify berhasil dijangkau.
      Gunakan metode <b>POST</b> untuk menganalisis
      video TikTok. Halaman GET ini hanya untuk
      mengecek status layanan.
    </p>

    <section>
      <h2>Endpoint</h2>
      <code>POST /api/analyze</code>

      <pre>Content-Type: application/json
x-api-key: YOUR_API_KEY

{
  "url": "https://www.tiktok.com/@username/video/123456789"
}</pre>
    </section>

    <section>
      <h2>Response</h2>
      <p>
        Jika request valid, API mengembalikan data video,
        kreator, statistik, musik, dan metadata kualitas video.
      </p>
    </section>

    <footer>
      Perlica API · TikTok metadata service
    </footer>
  </main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export default async (request) => {
  if (request.method === "GET") {
    return getLandingPage();
  }

  if (request.method !== "POST") {
    return json({
      status: false,
      message: "Method not allowed. Use GET or POST."
    }, 405);
  }

  const auth = checkApiKey(request);

  if (auth === "MISSING") {
    return json({
      status: false,
      message: "API_KEY tidak ditemukan di Netlify."
    }, 500);
  }

  if (auth === "INVALID") {
    return json({
      status: false,
      message: "API key tidak valid."
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
        metadataError = error.message ||
          "FFprobe gagal membaca video.";

        console.error("[FFPROBE ERROR]", metadataError);
      }
    } else {
      metadataError = "URL video tidak diberikan oleh TikWM.";
    }

    const fallbackSize = getNumber(
      data.hd_size || data.size
    );

    return json({
      status: true,
      creator: "Perlica",

      video: {
        id: data.id || null,
        title: data.title || null,
        createTime: formatDate(data.create_time),
        duration: getNumber(data.duration),
        durationText: data.duration
          ? `${Math.floor(data.duration / 60)}:${String(Math.floor(data.duration % 60)).padStart(2, "0")}`
          : null,
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
        quality: metadata?.quality ?? null,
        fps: metadata?.fps ?? null,
        codec: metadata?.codec ?? null,
        profile: metadata?.profile ?? null,
        format: metadata?.format ?? null,
        bitrate: metadata?.bitrate ?? null,
        size: metadata?.size ?? fallbackSize,
        hdSize: getNumber(data.hd_size),
        duration: metadata?.duration ?? null,
        metadataSource: metadata?.metadataSource ?? null,
        actualMetadataAvailable: Boolean(metadata),
        metadataError,
        playUrlAvailable: Boolean(data.play),
        hdUrlAvailable: Boolean(data.hdplay)
      }
    });

  } catch (error) {
    console.error("[PERLICA ANALYZE]", error);

    return json({
      status: false,
      message: error.name === "AbortError"
        ? "Permintaan TikWM timeout."
        : error.message || "Gagal menganalisis video."
    }, 500);
  }
};
