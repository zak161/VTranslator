import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";

env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 4;

const videoInput = document.getElementById("videoInput");
const videoPlayer = document.getElementById("videoPlayer");
const generateBtn = document.getElementById("generateBtn");
const downloadBtn = document.getElementById("downloadBtn");
const sourceLanguage = document.getElementById("sourceLanguage");
const targetLanguage = document.getElementById("targetLanguage");
const subtitleOverlay = document.getElementById("subtitleOverlay");
const statusText = document.getElementById("status");
const progressBar = document.getElementById("progressBar");
const canvas = document.getElementById("canvas");

let videoFile = null;
let videoURL = null;
let subtitles = [];
let transcriber = null;
let translator = null;
let finalVideoBlob = null;

const whisperLanguageMap = {
  auto: null,
  arabic: "arabic",
  english: "english",
  french: "french",
  spanish: "spanish",
  chinese: "chinese"
};

const nllbLanguageMap = {
  arabic: "arb_Arab",
  english: "eng_Latn",
  french: "fra_Latn",
  spanish: "spa_Latn",
  chinese: "zho_Hans"
};

videoInput.addEventListener("change", () => {
  videoFile = videoInput.files[0];

  if (!videoFile) {
    updateStatus("لم يتم اختيار أي فيديو.");
    return;
  }

  if (videoURL) {
    URL.revokeObjectURL(videoURL);
  }

  videoURL = URL.createObjectURL(videoFile);
  videoPlayer.src = videoURL;
  videoPlayer.load();

  subtitles = [];
  finalVideoBlob = null;
  subtitleOverlay.textContent = "";

  generateBtn.disabled = false;
  downloadBtn.disabled = true;

  updateStatus("تم رفع الفيديو بنجاح. اضغط على زر ترجمة الفيديو.");
  setProgress(0);
});

generateBtn.addEventListener("click", async () => {
  if (!videoFile) {
    alert("يرجى رفع فيديو أولًا.");
    return;
  }

  try {
    generateBtn.disabled = true;
    downloadBtn.disabled = true;
    finalVideoBlob = null;
    subtitles = [];

    updateStatus("جارٍ استخراج الصوت من الفيديو...");
    setProgress(5);

    const audioData = await extractAudioByPlayingVideo(videoURL);

    updateStatus("جارٍ تحميل نموذج التعرف على الكلام. قد يستغرق الأمر وقتًا في المرة الأولى...");
    setProgress(20);

    if (!transcriber) {
      transcriber = await pipeline(
        "automatic-speech-recognition",
        "Xenova/whisper-small",
        {
          progress_callback: progress => {
            if (progress.status === "progress") {
              setProgress(20 + Math.round(progress.progress * 0.25));
            }
          }
        }
      );
    }

    const target = targetLanguage.value;
    const source = sourceLanguage.value;

    let whisperTask = "transcribe";

    if (target === "english") {
      whisperTask = "translate";
    }

    updateStatus("جارٍ التعرف على الكلام وإنشاء الترجمة...");
    setProgress(50);

    const options = {
      chunk_length_s: 20,
      stride_length_s: 4,
      return_timestamps: true,
      task: whisperTask
    };

    if (source !== "auto") {
      options.language = whisperLanguageMap[source];
    }

    const result = await transcriber(audioData, options);

    subtitles = convertWhisperChunksToSubtitles(result);

    if (subtitles.length === 0 && result.text) {
      subtitles = [
        {
          start: 0,
          end: videoPlayer.duration || 10,
          text: result.text.trim()
        }
      ];
    }

    if (target !== "english" && source !== target) {
      updateStatus("جارٍ ترجمة النصوص...");

      if (!translator) {
        translator = await pipeline(
          "translation",
          "Xenova/nllb-200-distilled-600M",
          {
            progress_callback: progress => {
              if (progress.status === "progress") {
                setProgress(65 + Math.round(progress.progress * 0.15));
              }
            }
          }
        );
      }

      subtitles = await translateSubtitles(subtitles, source, target);
    }

    updateStatus("جارٍ إدراج الترجمة داخل الفيديو...");
    setProgress(80);

    finalVideoBlob = await createVideoWithBurnedSubtitles();

    const finalURL = URL.createObjectURL(finalVideoBlob);

    videoPlayer.pause();
    videoPlayer.src = finalURL;
    videoPlayer.load();

    subtitleOverlay.textContent = "";
    downloadBtn.disabled = false;

    updateStatus("تم الانتهاء. الترجمة مدمجة داخل الفيديو.");
    setProgress(100);
  } catch (error) {
    console.error(error);
    updateStatus("تعذرت معالجة الفيديو. جرّب استخدام متصفح Chrome أو فيديو أقصر.");
    setProgress(0);
  } finally {
    generateBtn.disabled = false;
  }
});

downloadBtn.addEventListener("click", () => {
  if (!finalVideoBlob) {
    alert("يرجى ترجمة الفيديو أولًا.");
    return;
  }

  const url = URL.createObjectURL(finalVideoBlob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "video-with-ai-subtitles.webm";

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
});

videoPlayer.addEventListener("timeupdate", () => {
  if (finalVideoBlob) {
    subtitleOverlay.textContent = "";
    return;
  }

  const currentTime = videoPlayer.currentTime;
  const activeSubtitle = subtitles.find(
    item => currentTime >= item.start && currentTime <= item.end
  );

  subtitleOverlay.textContent = activeSubtitle ? activeSubtitle.text : "";
});

async function extractAudioByPlayingVideo(url) {
  const tempVideo = document.createElement("video");

  tempVideo.src = url;
  tempVideo.muted = true;
  tempVideo.playsInline = true;
  tempVideo.crossOrigin = "anonymous";

  await waitForTempVideoMetadata(tempVideo);

  const stream = tempVideo.captureStream
    ? tempVideo.captureStream()
    : tempVideo.mozCaptureStream();

  if (!stream) {
    throw new Error("المتصفح لا يدعم استخراج الصوت من الفيديو.");
  }

  const audioTracks = stream.getAudioTracks();

  if (audioTracks.length === 0) {
    throw new Error("لم يتم العثور على مسار صوتي في الفيديو.");
  }

  const audioStream = new MediaStream(audioTracks);

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  const recorder = new MediaRecorder(audioStream, { mimeType });
  const chunks = [];

  recorder.ondataavailable = event => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  const finished = new Promise(resolve => {
    recorder.onstop = resolve;
  });

  recorder.start();

  await tempVideo.play();

  await new Promise(resolve => {
    tempVideo.onended = resolve;
  });

  recorder.stop();
  await finished;

  const audioBlob = new Blob(chunks, { type: mimeType });
  const arrayBuffer = await audioBlob.arrayBuffer();

  const audioContext = new AudioContext();
  const decodedAudio = await audioContext.decodeAudioData(arrayBuffer);

  const resampled = await resampleTo16kMono(decodedAudio);

  return resampled;
}

async function resampleTo16kMono(audioBuffer) {
  const targetSampleRate = 16000;
  const duration = audioBuffer.duration;

  const offlineContext = new OfflineAudioContext(
    1,
    Math.ceil(duration * targetSampleRate),
    targetSampleRate
  );

  const source = offlineContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineContext.destination);
  source.start(0);

  const renderedBuffer = await offlineContext.startRendering();

  return renderedBuffer.getChannelData(0);
}

function convertWhisperChunksToSubtitles(result) {
  if (!result.chunks || !Array.isArray(result.chunks)) {
    return [];
  }

  return result.chunks
    .map(chunk => {
      let start = 0;
      let end = 0;

      if (Array.isArray(chunk.timestamp)) {
        start = chunk.timestamp[0] || 0;
        end = chunk.timestamp[1] || start + 3;
      }

      return {
        start,
        end,
        text: chunk.text.trim()
      };
    })
    .filter(item => item.text.length > 0);
}

async function translateSubtitles(items, source, target) {
  const translatedItems = [];

  let sourceCode = nllbLanguageMap[source];

  if (!sourceCode) {
    sourceCode = "arb_Arab";
  }

  const targetCode = nllbLanguageMap[target];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    updateStatus(`جارٍ ترجمة المقطع ${i + 1} من ${items.length}...`);
    setProgress(65 + Math.round((i / items.length) * 15));

    const output = await translator(item.text, {
      src_lang: sourceCode,
      tgt_lang: targetCode
    });

    translatedItems.push({
      start: item.start,
      end: item.end,
      text: output[0].translation_text
    });
  }

  return translatedItems;
}

async function createVideoWithBurnedSubtitles() {
  const ctx = canvas.getContext("2d");

  const hiddenVideo = document.createElement("video");
  hiddenVideo.src = videoURL;
  hiddenVideo.muted = false;
  hiddenVideo.volume = 1;
  hiddenVideo.playsInline = true;
  hiddenVideo.crossOrigin = "anonymous";
  hiddenVideo.style.position = "fixed";
  hiddenVideo.style.left = "-9999px";
  hiddenVideo.style.top = "-9999px";
  hiddenVideo.style.width = "1px";
  hiddenVideo.style.height = "1px";
  hiddenVideo.style.opacity = "0";

  document.body.appendChild(hiddenVideo);

  await waitForTempVideoMetadata(hiddenVideo);

  canvas.width = hiddenVideo.videoWidth;
  canvas.height = hiddenVideo.videoHeight;

  const canvasStream = canvas.captureStream(30);

  const audioContext = new AudioContext();
  await audioContext.resume();

  const audioSource = audioContext.createMediaElementSource(hiddenVideo);
  const audioDestination = audioContext.createMediaStreamDestination();

  audioSource.connect(audioDestination);

  audioDestination.stream.getAudioTracks().forEach(track => {
    canvasStream.addTrack(track);
  });

  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm";

  const recorder = new MediaRecorder(canvasStream, { mimeType });
  const chunks = [];

  recorder.ondataavailable = event => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  const finished = new Promise(resolve => {
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: "video/webm" });

      hiddenVideo.pause();
      hiddenVideo.removeAttribute("src");
      hiddenVideo.load();

      if (hiddenVideo.parentNode) {
        hiddenVideo.parentNode.removeChild(hiddenVideo);
      }

      await audioContext.close();

      resolve(blob);
    };
  });

  recorder.start();

  await hiddenVideo.play();

  drawHiddenVideoFrame(ctx, hiddenVideo);

  await new Promise(resolve => {
    hiddenVideo.onended = resolve;
  });

  recorder.stop();

  return finished;
}

function drawHiddenVideoFrame(ctx, hiddenVideo) {
  if (hiddenVideo.ended) {
    return;
  }

  ctx.drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);

  const currentTime = hiddenVideo.currentTime;
  const activeSubtitle = subtitles.find(
    item => currentTime >= item.start && currentTime <= item.end
  );

  if (activeSubtitle) {
    drawSubtitle(ctx, activeSubtitle.text);
  }

  const progress = 80 + Math.round((hiddenVideo.currentTime / hiddenVideo.duration) * 18);
  setProgress(Math.min(progress, 98));

  requestAnimationFrame(() => drawHiddenVideoFrame(ctx, hiddenVideo));
}

function drawSubtitle(ctx, text) {
  const isArabic = /[\u0600-\u06FF]/.test(text);

  const fontSize = Math.max(24, Math.floor(canvas.width / 25));
  const maxWidth = canvas.width * 0.85;

  ctx.font = `bold ${fontSize}px Amiri, Arial`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.direction = isArabic ? "rtl" : "ltr";

  const lines = wrapText(ctx, text, maxWidth);
  const lineHeight = fontSize + 12;

  const bottomPadding = Math.max(22, canvas.height * 0.045);
  const totalTextHeight = lines.length * lineHeight;
  const startY = canvas.height - bottomPadding - totalTextHeight + lineHeight / 2;

  const paddingX = 24;
  const paddingY = 10;

  let widestLine = 0;

  lines.forEach(line => {
    const lineWidth = ctx.measureText(line).width;
    if (lineWidth > widestLine) {
      widestLine = lineWidth;
    }
  });

  const boxWidth = Math.min(widestLine + paddingX * 2, canvas.width * 0.92);
  const boxHeight = totalTextHeight + paddingY * 2;
  const boxX = (canvas.width - boxWidth) / 2;
  const boxY = startY - lineHeight / 2 - paddingY;

  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  roundRect(ctx, boxX, boxY, boxWidth, boxHeight, 12);
  ctx.fill();

  ctx.fillStyle = "white";

  lines.forEach((line, index) => {
    const y = startY + index * lineHeight;
    ctx.fillText(line, canvas.width / 2, y);
  });
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let line = "";

  words.forEach(word => {
    const testLine = line + word + " ";
    const width = ctx.measureText(testLine).width;

    if (width > maxWidth && line !== "") {
      lines.push(line.trim());
      line = word + " ";
    } else {
      line = testLine;
    }
  });

  lines.push(line.trim());
  return lines;
}

function waitForTempVideoMetadata(video) {
  return new Promise(resolve => {
    if (video.readyState >= 1) {
      resolve();
    } else {
      video.onloadedmetadata = () => resolve();
    }
  });
}

function updateStatus(message) {
  statusText.textContent = message;
}

function setProgress(value) {
  progressBar.style.width = `${value}%`;
}