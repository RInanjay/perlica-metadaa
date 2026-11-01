
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");

const app = express();
const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

const MAX_FILE_SIZE = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 120000;
const PROBE_TIMEOUT = 30000;

const ALLOWED_HOSTS = [
  "tikwm.com",
  "tiktokcdn.com",
  "tiktokv.com",
  "byteoversea.com",
  "ibytedtos.com",
  "muscdn.com",
  "tiktok.com"
];

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "*/*"
};

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

function isAllowedHost(hostname) {
  const host = hostname.toLowerCase();

  return ALLOWED_HOSTS.some(domain =>
    host === domain || host.endsWith("." + domain)
  );
}

function validateMediaUrl(value) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("URL video tidak valid.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Protocol URL tidak diizinkan.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("URL dengan kredensial tidak diizinkan.");
  }

  if (!isAllowedHost(parsed.hostname)) {
    throw new Error(
      `Domain media tidak diizinkan: ${parsed.hostname}`
    );
  }

  return parsed.href;
}

function getFPS(value) {
  if (!value || value === "0/0") return null;

  if (String(value).includes("/")) {
    const [numerator, denominator] = String(value)
      .split("/")
      .map(Number);

    if (denominator > 0) {
      return Number(
        (numerator / denominator).toFixed(3)
      );
    }
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
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

function formatBitrate(value) {
  if (!value) return null;

  return Number(
    (Number(value) / 1000000).toFixed(3)
  );
}

async function downloadVideo(url, destination) {
  let currentUrl = validateMediaUrl(url);
  let response;

  for (let attempt = 0; attempt <= 5; attempt++) {
    response = await axios.get(currentUrl, {
      responseType: "stream",
      timeout: DOWNLOAD_TIMEOUT,
      maxRedirects: 0,
      validateStatus: status =>
        status >= 200 && status < 400,
      headers: HEADERS
    });

    if (response.status >= 300 && response.status < 400) {
      response.data.destroy();

      const location = response.headers.location;

      if (!location) {
        throw new Error(
          "Redirect video tidak memiliki tujuan."
        );
      }

      currentUrl = validateMediaUrl(
        new URL(location, currentUrl).href
      );

      continue;
    }

    break;
  }

  if (!response || response.status !== 200) {
    response?.data?.destroy();

    throw new Error(
      "Gagal mengambil file video."
    );
  }

  const contentLength = Number(
    response.headers["content-length"] || 0
  );

  if (contentLength > MAX_FILE_SIZE) {
    response.data.destroy();

    throw new Error(
      "Ukuran video melebihi batas 200 MB."
    );
  }

  let downloadedSize = 0;

  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      downloadedSize += chunk.length;

      if (downloadedSize > MAX_FILE_SIZE) {
        return callback(
          new Error(
            "Ukuran video melebihi batas 200 MB."
          )
        );
      }

      callback(null, chunk);
    }
  });

  await pipeline(
    response.data,
    limiter,
    fs.createWriteStream(destination)
  );

  if (downloadedSize === 0) {
    throw new Error("File video kosong.");
  }

  return downloadedSize;
}

async function analyzeVideo(filePath, fileSize) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath
    ],
    {
      timeout: PROBE_TIMEOUT,
      maxBuffer: 5 * 1024 * 1024
    }
  );

  const result = JSON.parse(stdout);

  const streams = result.streams || [];

  const video = streams.find(
    stream => stream.codec_type === "video"
  );

  const audio = streams.find(
    stream => stream.codec_type === "audio"
  );

  if (!video) {
    throw new Error(
      "Video stream tidak ditemukan."
    );
  }

  const format = result.format || {};

  const width = Number(video.width || 0);
  const height = Number(video.height || 0);

  const fps = getFPS(
    video.avg_frame_rate || video.r_frame_rate
  );

  const duration = Number(
    format.duration || video.duration || 0
  );

  const videoBitrate = Number(
    video.bit_rate || 0
  );

  const audioBitrate = Number(
    audio?.bit_rate || 0
  );

  const totalBitrate = Number(
    format.bit_rate || 0
  );

  const estimatedBitrate = duration > 0
    ? Math.round(fileSize * 8 / duration)
    : null;

  const finalBitrate =
    totalBitrate || estimatedBitrate;

  return {
    success: true,

    video: {
      width,
      height,

      resolution: width && height
        ? `${width}x${height}`
        : null,

      quality: getQuality(width, height),

      fps,

      codec: video.codec_name || null,

      profile: video.profile || null,

      pixel_format: video.pix_fmt || null,

      bitrate_bps: videoBitrate || null,

      bitrate_mbps: formatBitrate(videoBitrate)
    },

    audio: {
      available: Boolean(audio),

      codec: audio?.codec_name || null,

      bitrate_bps: audioBitrate || null,

      bitrate_mbps: formatBitrate(audioBitrate),

      sample_rate: audio?.sample_rate
        ? Number(audio.sample_rate)
        : null,

      channels: audio?.channels || null
    },

    file: {
      size_bytes: fileSize,

      size_mb: Number(
        (fileSize / 1024 / 1024).toFixed(2)
      ),

      format: format.format_name || null,

      duration,

      duration_formatted: duration
        ? `${Math.floor(duration / 60)}:${String(
            Math.floor(duration % 60)
          ).padStart(2, "0")}`
        : null,

      bitrate_bps: finalBitrate,

      bitrate_mbps: formatBitrate(finalBitrate),

      bitrate_is_estimated: !totalBitrate
    },

    analyzed_at: new Date().toISOString()
  };
}

function authenticate(req, res, next) {
  if (!API_KEY) {
    return res.status(500).json({
      success: false,
      message: "API_KEY belum diatur."
    });
  }

  const key = req.headers["x-api-key"];

  if (!key || key !== API_KEY) {
    return res.status(401).json({
      success: false,
      message: "API key tidak valid."
    });
  }

  next();
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Perlica Metadata API",
    version: "1.0.0",
    status: "online",

    endpoints: {
      health: "GET /health",
      analyze: "POST /analyze"
    }
  });
});

app.get("/health", async (req, res) => {
  try {
    await execFileAsync("ffprobe", ["-version"]);

    res.json({
      success: true,
      status: "online",
      ffprobe: true
    });

  } catch {
    res.status(500).json({
      success: false,
      status: "error",
      ffprobe: false
    });
  }
});

app.post(
  "/analyze",
  authenticate,
  async (req, res) => {
    const url = req.body?.url;

    if (!url || typeof url !== "string") {
      return res.status(400).json({
        success: false,
        message: "Parameter url wajib diisi."
      });
    }

    let filePath;

    try {
      validateMediaUrl(url);

      filePath = path.join(
        os.tmpdir(),
        `perlica_${crypto.randomUUID()}.mp4`
      );

      const fileSize = await downloadVideo(
        url,
        filePath
      );

      const metadata = await analyzeVideo(
        filePath,
        fileSize
      );

      return res.json(metadata);

    } catch (error) {
      console.error(
        "[METADATA API]",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          error.message ||
          "Gagal menganalisis video."
      });

    } finally {
      if (filePath) {
        await fs.promises.unlink(filePath)
          .catch(() => {});
      }
    }
  }
);

app.use((error, req, res, next) => {
  console.error("[SERVER ERROR]", error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    message: "Terjadi kesalahan pada server."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[PERLICA API] Running on port ${PORT}`
  );
});
