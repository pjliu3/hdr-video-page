const state = {
  cases: [],
  activeIndex: 0,
  globalExposure: null,
};

const SITE_VERSION = "20260628-preview15";
const $ = (selector) => document.querySelector(selector);
const pairRegistry = new WeakMap();
const exposureDrivenVideos = [];

const lazyVideoObserver = "IntersectionObserver" in window
  ? new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const video = entry.target;
          loadVideo(video, video.dataset.autoplay !== "false");
          lazyVideoObserver.unobserve(video);
        });
      },
      { rootMargin: "360px 0px" }
    )
  : null;

function createVideo(src, className = "", options = {}) {
  const video = document.createElement("video");
  video.setAttribute("data-src", src);
  video.className = className;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "none";
  video.dataset.autoplay = options.autoplay === false ? "false" : "true";
  if (options.controls) video.controls = true;
  if (options.eager) {
    loadVideo(video, options.autoplay !== false);
  } else {
    observeLazyVideo(video);
  }
  return video;
}

function observeLazyVideo(video) {
  if (lazyVideoObserver) {
    lazyVideoObserver.observe(video);
  } else {
    loadVideo(video, video.dataset.autoplay !== "false");
  }
}

function loadVideo(video, shouldPlay = true) {
  if (!video.src && video.dataset.src) {
    video.src = video.dataset.src;
    video.preload = shouldPlay ? "auto" : "metadata";
    video.load();
  }
  if (shouldPlay) {
    video.play().catch(() => {});
  }
}

function whenMetadata(video) {
  if (video.readyState >= 1) return Promise.resolve();
  loadVideo(video, false);
  return new Promise((resolve) => {
    video.addEventListener("loadedmetadata", resolve, { once: true });
  });
}

function clampTime(video, time) {
  if (!Number.isFinite(time)) return 0;
  if (!Number.isFinite(video.duration) || video.duration <= 0) return Math.max(0, time);
  return Math.min(Math.max(0, time), Math.max(0, video.duration - 0.04));
}

function setCurrentTime(video, time, threshold = 0.08) {
  if (video.readyState < 1) return;
  const nextTime = clampTime(video, time);
  if (Math.abs(video.currentTime - nextTime) > threshold) {
    video.currentTime = nextTime;
  }
}

function linkVideoPair(primary, secondary) {
  const existingPair = pairRegistry.get(primary);
  if (existingPair && existingPair.videos.includes(secondary)) return existingPair;

  const pair = {
    videos: [primary, secondary],
    leader: primary,
    syncing: false,
    rafId: 0,
  };

  const withGuard = (callback) => {
    if (pair.syncing) return;
    pair.syncing = true;
    try {
      callback();
    } finally {
      pair.syncing = false;
    }
  };

  const alignTo = (source, threshold = 0.08) => {
    withGuard(() => {
      pair.leader = source;
      pair.videos.forEach((video) => {
        if (video !== source) {
          video.playbackRate = source.playbackRate;
          setCurrentTime(video, source.currentTime, threshold);
        }
      });
    });
  };

  const mirrorPlayState = (source) => {
    withGuard(() => {
      pair.leader = source;
      pair.videos.forEach((video) => {
        if (video === source) return;
        if (source.paused) {
          video.pause();
        } else {
          setCurrentTime(video, source.currentTime, 0.03);
          video.play().catch(() => {});
        }
      });
    });
  };

  const tick = () => {
    const leader = pair.leader || primary;
    if (!leader.paused) {
      alignTo(leader, 0.1);
    }
    pair.rafId = requestAnimationFrame(tick);
  };

  pair.videos.forEach((video) => {
    pairRegistry.set(video, pair);
    video.addEventListener("play", () => mirrorPlayState(video));
    video.addEventListener("pause", () => mirrorPlayState(video));
    video.addEventListener("seeking", () => alignTo(video, 0.02));
    video.addEventListener("seeked", () => alignTo(video, 0.02));
    video.addEventListener("ratechange", () => alignTo(video, 0.02));
    video.addEventListener("loadedmetadata", () => alignTo(pair.leader, 0));
  });

  pair.rafId = requestAnimationFrame(tick);
  return pair;
}

function restartVideoPair(primary, secondary) {
  Promise.all([whenMetadata(primary), whenMetadata(secondary)]).then(() => {
    setCurrentTime(primary, 0, 0);
    setCurrentTime(secondary, 0, 0);
    loadVideo(primary, true);
    loadVideo(secondary, true);
  });
}

function setVideoSource(video, src) {
  video.pause();
  video.removeAttribute("src");
  video.setAttribute("data-src", src);
  video.preload = "none";
  video.load();
  loadVideo(video, true);
}

function setLazyVideoSource(video, src, autoplay = true) {
  video.pause();
  video.removeAttribute("src");
  video.setAttribute("data-src", src);
  video.dataset.autoplay = autoplay ? "true" : "false";
  video.preload = "none";
  video.load();
  observeLazyVideo(video);
}

function setManagedVideoSource(video, src) {
  if (video.dataset.src === src) return;
  if (video.src) {
    setVideoSource(video, src);
    return;
  }
  video.setAttribute("data-src", src);
}

function registerExposureVideo(video, caseIndex) {
  video.dataset.exposureIndex = String(caseIndex);
  exposureDrivenVideos.push(video);
  return video;
}

function populateHero(cases) {
  const grid = $("#hero-grid");
  grid.innerHTML = "";
  cases.slice(0, 10).forEach((item, index) => {
    const tile = document.createElement("article");
    tile.className = "hero-tile";

    const video = registerExposureVideo(
      createVideo(selectedHdr(item, index), "", { eager: index < 2 }),
      index
    );
    const label = document.createElement("div");
    label.className = "tile-label";
    label.textContent = item.title;

    tile.append(video, label);
    grid.append(tile);
  });
}

function populateSelector(cases) {
  const select = $("#case-select");
  select.innerHTML = "";
  cases.forEach((item, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = item.title;
    select.append(option);
  });
  select.addEventListener("change", () => setActiveCase(Number(select.value)));
}

function setActiveCase(index) {
  state.activeIndex = index;
  const item = state.cases[index];
  const sdr = $("#compare-sdr");
  const hdr = $("#compare-hdr");
  syncExposureControl(exposureForCase(item, index));

  setVideoSource(sdr, selectedSdr(item, index));
  setVideoSource(hdr, selectedHdr(item, index));
  restartVideoPair(sdr, hdr);
  $("#case-select").value = String(index);
  $("#case-prompt").textContent = item.prompt;
  setBeforeAfter(item);
}

function exposureForCase(item, index = state.activeIndex) {
  return state.globalExposure || item.defaultHdrExposure || "0";
}

function selectedSdr(item, index = state.activeIndex) {
  const exposure = exposureForCase(item, index);
  if (item.sdrVariants && item.sdrVariants[exposure]) {
    return item.sdrVariants[exposure];
  }
  return item.sdr;
}

function selectedHdr(item, index = state.activeIndex) {
  const exposure = exposureForCase(item, index);
  if (item.hdrVariants && item.hdrVariants[exposure]) {
    return item.hdrVariants[exposure];
  }
  return item.hdr;
}

function formatExposure(value) {
  const exposure = Number(value);
  const text = Number.isInteger(exposure) ? String(exposure) : exposure.toFixed(1);
  return exposure > 0 ? `+${text}` : text;
}

function syncExposureControl(value) {
  const slider = $("#exposure-slider");
  if (slider) slider.value = value;
  $("#ev-value").textContent = formatExposure(value);
}

function setHdrExposure(value) {
  state.globalExposure = String(value);
  syncExposureControl(state.globalExposure);
  if (!state.cases.length) return;

  const item = state.cases[state.activeIndex];
  const sdr = $("#compare-sdr");
  const hdr = $("#compare-hdr");
  setVideoSource(sdr, selectedSdr(item));
  setVideoSource(hdr, selectedHdr(item));
  restartVideoPair(sdr, hdr);
  setBeforeAfter(item);
  updateExposureDrivenPreviews();
}

function populateGallery(cases) {
  const grid = $("#gallery-grid");
  grid.innerHTML = "";

  cases.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "result-card";

    const video = registerExposureVideo(createVideo(selectedHdr(item, index)), index);
    const body = document.createElement("div");
    body.className = "result-body";
    body.innerHTML = `
      <p>${item.tag}</p>
      <h3>${item.title}</h3>
    `;

    card.append(video, body);
    card.addEventListener("click", () => {
      setActiveCase(index);
      $("#interactive-comparison").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    grid.append(card);
  });
}

function setBeforeAfter(item) {
  const before = $("#before-video");
  const after = $("#after-video");
  setLazyVideoSource(before, selectedSdr(item));
  setLazyVideoSource(after, selectedHdr(item));
}

function updateExposureDrivenPreviews() {
  exposureDrivenVideos.forEach((video) => {
    const index = Number(video.dataset.exposureIndex);
    const item = state.cases[index];
    if (!item) return;
    setManagedVideoSource(video, selectedHdr(item, index));
  });
}

function setupBeforeAfter() {
  const stage = $(".before-after-stage");
  const slider = $("#before-after-slider");
  slider.addEventListener("input", () => {
    stage.style.setProperty("--clip", `${slider.value}%`);
  });
}

function setupPageReveals() {
  const sections = Array.from(document.querySelectorAll(".page-section"));
  if (!sections.length) return;

  document.documentElement.classList.add("reveal-enabled");
  sections[0].classList.add("is-visible");

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion || !("IntersectionObserver" in window)) {
    sections.forEach((section) => section.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
        }
      });
    },
    { threshold: 0.28, rootMargin: "-8% 0px -18%" }
  );

  sections.forEach((section) => observer.observe(section));
}

async function init() {
  const response = await fetch(`cases.json?v=${SITE_VERSION}`, { cache: "no-store" });
  state.cases = await response.json();

  populateHero(state.cases);
  populateSelector(state.cases);
  populateGallery(state.cases);
  setupBeforeAfter();
  setupPageReveals();
  linkVideoPair($("#compare-sdr"), $("#compare-hdr"));
  linkVideoPair($("#before-video"), $("#after-video"));
  $("#exposure-slider").addEventListener("input", (event) => setHdrExposure(event.target.value));
  setActiveCase(0);
}

init().catch((error) => {
  document.body.classList.add("load-error");
  console.error(error);
});
