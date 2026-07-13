(() => {
  "use strict";

  const PRODUCTION_API = "https://fatcatsuite-whiskr.onrender.com";
  const API_BASE = window.WHISKR_API_URL || (location.protocol === "file:" ? PRODUCTION_API : location.origin);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const anonymousClientId = localStorage.getItem("whiskr_client_id") || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  localStorage.setItem("whiskr_client_id", anonymousClientId);
  let savedVideoIds = [];
  try { savedVideoIds = JSON.parse(localStorage.getItem("whiskr_saved") || "[]"); } catch { savedVideoIds = []; }

  const state = {
    mode: "long",
    feeds: { long: [], short: [] },
    loaded: { long: false, short: false },
    loading: { long: false, short: false },
    query: "",
    currentVideo: null,
    commentsVideo: null,
    nickname: localStorage.getItem("whiskr_nickname") || "",
    pendingComment: null,
    saved: new Set(Array.isArray(savedVideoIds) ? savedVideoIds : []),
    shortTab: "for-you",
    drawerTrigger: null,
    thumbnailFrames: [],
    selectedThumbnail: null,
    selectedThumbnailSource: null,
    thumbnailGenerationToken: 0,
    muted: localStorage.getItem("whiskr_muted") !== "false",
    shortObserver: null,
    viewed: new Set()
  };

  const els = {
    longView: $("#longView"), shortsView: $("#shortsView"), watchView: $("#watchView"),
    videoGrid: $("#videoGrid"), shortsFeed: $("#shortsFeed"), longStatus: $("#longStatus"),
    modeButtons: $$("[data-mode-target]"), searchInput: $("#searchInput"), searchForm: $("#searchForm"),
    nicknameDialog: $("#nicknameDialog"), nicknameForm: $("#nicknameForm"), nicknameError: $("#nicknameError"),
    uploadDialog: $("#uploadDialog"), uploadForm: $("#uploadForm"), uploadError: $("#uploadError"),
    thumbnailGenerator: $("#thumbnailGenerator"), thumbnailOptions: $("#thumbnailOptions"),
    commentsDrawer: $("#commentsDrawer"), drawerBackdrop: $("#drawerBackdrop"),
    drawerCommentsList: $("#drawerCommentsList"), drawerCommentCount: $("#drawerCommentCount"),
    watchPlayer: $("#watchPlayer"), watchTitle: $("#watchTitle"), watchCreator: $("#watchCreator"),
    watchAvatar: $("#watchAvatar"), watchHandle: $("#watchHandle"), watchDescription: $("#watchDescription"),
    watchLikeButton: $("#watchLikeButton"), watchCommentCount: $("#watchCommentCount"),
    watchCommentsList: $("#watchCommentsList"), relatedVideos: $("#relatedVideos"),
    toastRegion: $("#toastRegion")
  };

  function icon(name) {
    return `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  function escapeHTML(value = "") {
    return String(value).replace(/[&<>'"]/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[character]);
  }

  function initials(value = "W") {
    return String(value).trim().split(/\s+/).slice(0, 2).map(part => part[0] || "").join("").toUpperCase() || "W";
  }

  function formatCount(value = 0) {
    const count = Number(value) || 0;
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1).replace(".0", "")}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1).replace(".0", "")}K`;
    return String(count);
  }

  function formatDuration(seconds) {
    const duration = Math.max(0, Math.floor(Number(seconds) || 0));
    if (!duration) return "";
    const hours = Math.floor(duration / 3600);
    const minutes = Math.floor((duration % 3600) / 60);
    const secs = duration % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${minutes}:${String(secs).padStart(2, "0")}`;
  }

  function relativeTime(timestamp) {
    if (!timestamp || Number(timestamp) < 946_684_800_000) return "Recently";
    const elapsed = Math.max(0, Date.now() - Number(timestamp));
    const units = [[31_536_000_000, "year"], [2_592_000_000, "month"], [604_800_000, "week"], [86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"]];
    for (const [size, label] of units) {
      if (elapsed >= size) {
        const value = Math.floor(elapsed / size);
        return `${value} ${label}${value === 1 ? "" : "s"} ago`;
      }
    }
    return "Just now";
  }

  function videoUrl(id) { return `${API_BASE}/${encodeURIComponent(id)}/video`; }
  function thumbnailUrl(id) { return `${API_BASE}/${encodeURIComponent(id)}/thumbnail`; }

  async function api(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = { ...(options.headers || {}) };
    let body = options.body;
    if (method !== "GET" && method !== "HEAD" && body == null) body = { clientId: anonymousClientId };
    if (body && !(body instanceof FormData) && typeof body !== "string") {
      body = { ...body, clientId: anonymousClientId };
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    if (method === "GET" || method === "HEAD") {
      path += `${path.includes("?") ? "&" : "?"}clientId=${encodeURIComponent(anonymousClientId)}`;
    }
    const response = await fetch(`${API_BASE}${path}`, { ...options, method, headers, body });
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function normalizeVideo(raw) {
    const creator = raw.creator || {};
    const stats = raw.stats || {};
    const type = raw.type || raw.kind || "long";
    return {
      id: String(raw.id),
      title: raw.title || "Untitled video",
      description: raw.description || "",
      type: type === "short" ? "short" : "long",
      uploadedAt: raw.uploadedAt || 0,
      duration: raw.duration || 0,
      creator: {
        id: creator.id || raw.authorId || "whiskr",
        username: creator.username || raw.username || "whiskr.creator",
        displayName: creator.displayName || raw.creatorName || "Whiskr Creator"
      },
      stats: {
        likes: Number(stats.likes ?? raw.likeCount ?? 0),
        comments: Number(stats.comments ?? raw.commentCount ?? 0),
        views: Number(stats.views ?? raw.viewCount ?? 0)
      },
      liked: Boolean(raw.liked)
    };
  }

  function findVideo(id) {
    return [...state.feeds.long, ...state.feeds.short].find(video => video.id === id) || null;
  }

  function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    els.toastRegion.appendChild(toast);
    setTimeout(() => toast.remove(), 3300);
  }

  function showSkeletons() {
    els.longStatus.innerHTML = "";
    els.videoGrid.innerHTML = Array.from({ length: 8 }, () => `
      <article class="skeleton-card">
        <div class="thumbnail"></div>
        <div class="card-body"><div class="avatar"></div><div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div></div>
      </article>`).join("");
  }

  async function loadFeed(type, { refresh = false } = {}) {
    if (state.loading[type] || (state.loaded[type] && !refresh)) return state.feeds[type];
    state.loading[type] = true;
    if (type === "long") showSkeletons();
    else els.shortsFeed.innerHTML = `<div class="shorts-empty"><div class="empty-state"><p>Loading Shorts…</p></div></div>`;

    try {
      const data = await api(`/feed?type=${type}&limit=50`);
      const videos = (data.feed || []).map(normalizeVideo).filter(video => video.type === type);
      state.feeds[type] = videos;
      state.loaded[type] = true;
      if (type === "long") renderLongFeed();
      else renderShortsFeed();
      return videos;
    } catch (error) {
      if (type === "long") {
        els.videoGrid.innerHTML = "";
        els.longStatus.innerHTML = emptyState("refresh", "Couldn’t load videos", error.message, "Try again", "refresh");
      } else {
        els.shortsFeed.innerHTML = `<div class="shorts-empty">${emptyState("refresh", "Couldn’t load Shorts", error.message, "Try again", "refresh-shorts")}</div>`;
      }
      return [];
    } finally {
      state.loading[type] = false;
    }
  }

  function emptyState(iconName, title, copy, buttonLabel = "", action = "") {
    return `<div class="empty-state"><div class="empty-icon">${icon(iconName)}</div><h2>${escapeHTML(title)}</h2><p>${escapeHTML(copy)}</p>${buttonLabel ? `<button type="button" data-empty-action="${action}">${escapeHTML(buttonLabel)}</button>` : ""}</div>`;
  }

  function filteredLongVideos() {
    const query = state.query.trim().toLowerCase();
    if (!query || query === "recently uploaded") return state.feeds.long;
    return state.feeds.long.filter(video => `${video.title} ${video.description} ${video.creator.displayName} ${video.creator.username}`.toLowerCase().includes(query));
  }

  function renderLongFeed() {
    const videos = filteredLongVideos();
    els.longStatus.innerHTML = "";
    if (!videos.length) {
      els.videoGrid.innerHTML = "";
      els.longStatus.innerHTML = state.feeds.long.length
        ? emptyState("search", "No matches", `Nothing in your feed matches “${state.query}”.`, "Clear search", "clear-search")
        : emptyState("upload", "Your stage is ready", "Upload the first long-form video and it’ll appear here.", "Upload a video", "upload");
      return;
    }

    els.videoGrid.innerHTML = videos.map((video, index) => {
      const duration = formatDuration(video.duration);
      return `<article class="video-card" data-video-id="${escapeHTML(video.id)}" tabindex="0" style="animation-delay:${Math.min(index * 35, 280)}ms">
        <div class="thumbnail">
          <img src="${thumbnailUrl(video.id)}" alt="" loading="lazy">
          ${duration ? `<span class="duration">${duration}</span>` : ""}
          <div class="hover-play"><span>${icon("play")}</span></div>
        </div>
        <div class="card-body">
          <div class="avatar">${escapeHTML(initials(video.creator.displayName))}</div>
          <div><h2 class="card-title">${escapeHTML(video.title)}</h2><span class="card-creator">${escapeHTML(video.creator.displayName)}</span><span class="card-stats">${formatCount(video.stats.views)} views · ${relativeTime(video.uploadedAt)}</span></div>
          <button class="card-menu" type="button" aria-label="More options">${icon("more")}</button>
        </div>
      </article>`;
    }).join("");
  }

  function renderShortsFeed() {
    cleanupShortObserver();
    if (!state.feeds.short.length) {
      els.shortsFeed.innerHTML = `<div class="shorts-empty">${emptyState("shorts", "Shorts start here", "Upload a vertical clip to create a separate swipeable Shorts feed.", "Upload a Short", "upload-short")}</div>`;
      return;
    }
    const videos = state.shortTab === "latest"
      ? [...state.feeds.short].sort((a, b) => b.uploadedAt - a.uploadedAt)
      : state.feeds.short;
    els.shortsFeed.innerHTML = videos.map(video => `
      <article class="short-slide" data-video-id="${escapeHTML(video.id)}">
        <div class="short-stage">
          <video class="short-video" src="${videoUrl(video.id)}" poster="${thumbnailUrl(video.id)}" preload="metadata" loop playsinline ${state.muted ? "muted" : ""}></video>
          <img class="short-poster" src="${thumbnailUrl(video.id)}" alt="">
          <button class="short-center-control" type="button" aria-label="Play video">${icon("play")}</button>
          <div class="short-top-controls"><button type="button" data-short-action="mute" aria-label="${state.muted ? "Unmute" : "Mute"}">${icon(state.muted ? "muted" : "volume")}</button></div>
          <div class="short-info">
          <div class="short-creator"><span>@${escapeHTML(video.creator.username)}</span></div>
            <p class="short-caption">${escapeHTML(video.title)}${video.description ? ` · ${escapeHTML(video.description)}` : ""}</p>
            <div class="short-sound"><span class="sound-disc"></span><span>original sound · ${escapeHTML(video.creator.displayName)}</span></div>
          </div>
          <div class="short-progress"><span></span></div>
        </div>
        <div class="short-actions">
          <div class="short-action" aria-label="Creator"><span class="action-icon action-avatar avatar">${escapeHTML(initials(video.creator.displayName))}</span></div>
          <button class="short-action ${video.liked ? "liked" : ""}" type="button" data-short-action="like" aria-label="Like video" aria-pressed="${video.liked}"><span class="action-icon">${icon("heart")}</span><span data-count>${formatCount(video.stats.likes)}</span></button>
          <button class="short-action" type="button" data-short-action="comments" aria-label="Open comments"><span class="action-icon">${icon("comment")}</span><span data-count>${formatCount(video.stats.comments)}</span></button>
          <button class="short-action ${state.saved.has(video.id) ? "liked" : ""}" type="button" data-short-action="bookmark" aria-label="Save video" aria-pressed="${state.saved.has(video.id)}"><span class="action-icon">${icon("bookmark")}</span><span>Save</span></button>
          <button class="short-action" type="button" data-short-action="share" aria-label="Share video"><span class="action-icon">${icon("share")}</span><span>Share</span></button>
        </div>
      </article>`).join("");
    setupShorts();
  }

  function cleanupShortObserver() {
    state.shortObserver?.disconnect();
    state.shortObserver = null;
    $$(".short-video").forEach(video => video.pause());
  }

  function setupShorts() {
    $$(".short-slide", els.shortsFeed).forEach(slide => {
      const video = $(".short-video", slide);
      const stage = $(".short-stage", slide);
      const center = $(".short-center-control", slide);
      const progress = $(".short-progress span", slide);
      center.classList.add("visible");
      video.addEventListener("playing", () => { stage.classList.add("playing"); center.classList.remove("visible"); center.tabIndex = -1; center.setAttribute("aria-label", "Pause video"); });
      video.addEventListener("pause", () => { center.classList.add("visible"); center.tabIndex = 0; center.setAttribute("aria-label", "Play video"); });
      video.addEventListener("timeupdate", () => { progress.style.width = video.duration ? `${video.currentTime / video.duration * 100}%` : "0"; });
      center.addEventListener("click", () => video.play().catch(() => {}));
      stage.addEventListener("click", event => {
        if (event.target.closest("button")) return;
        if (video.paused) video.play().catch(() => {}); else video.pause();
      });
      stage.addEventListener("dblclick", event => {
        const model = findVideo(slide.dataset.videoId);
        if (!model) return;
        burstHeart(stage, event);
        if (!model.liked) toggleLike(model, $("[data-short-action='like']", slide));
      });
    });

    state.shortObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const slide = entry.target;
        const video = $(".short-video", slide);
        if (entry.isIntersecting && entry.intersectionRatio >= .72 && state.mode === "short") {
          $$(".short-video", els.shortsFeed).forEach(other => { if (other !== video) other.pause(); });
          video.muted = state.muted;
          video.play().catch(() => {});
          recordView(slide.dataset.videoId);
        } else video.pause();
      });
    }, { root: els.shortsFeed, threshold: [.2, .72, .95] });
    $$(".short-slide", els.shortsFeed).forEach(slide => state.shortObserver.observe(slide));
  }

  function burstHeart(stage, event) {
    const burst = document.createElement("span");
    burst.className = "heart-burst";
    burst.innerHTML = icon("heart");
    if (event) {
      const bounds = stage.getBoundingClientRect();
      burst.style.left = `${event.clientX - bounds.left}px`;
      burst.style.top = `${event.clientY - bounds.top}px`;
    }
    stage.appendChild(burst);
    setTimeout(() => burst.remove(), 760);
  }

  async function recordView(id) {
    if (state.viewed.has(id)) return;
    state.viewed.add(id);
    try {
      const data = await api(`/videos/${encodeURIComponent(id)}/view`, { method: "POST" });
      const video = findVideo(id);
      if (video && Number.isFinite(Number(data.viewCount))) video.stats.views = Number(data.viewCount);
    } catch { /* Optional on legacy servers. */ }
  }

  function setMode(mode, { updateHash = true } = {}) {
    if (!['long', 'short'].includes(mode)) mode = 'long';
    state.mode = mode;
    document.body.dataset.mode = mode;
    els.modeButtons.forEach(button => button.classList.toggle("active", button.dataset.modeTarget === mode));
    $$('[data-nav]').forEach(link => link.classList.toggle("active", link.dataset.nav === mode));
    els.longView.classList.toggle("active", mode === "long");
    els.shortsView.classList.toggle("active", mode === "short");
    els.watchView.classList.remove("active");
    els.watchPlayer.pause();
    if (mode !== "short") cleanupShortObserver();
    if (updateHash && location.hash !== `#/${mode === "short" ? "shorts" : "long"}`) location.hash = `#/${mode === "short" ? "shorts" : "long"}`;
    loadFeed(mode).then(() => { if (mode === "short" && state.feeds.short.length && !state.shortObserver) setupShorts(); });
    if (mode === "long") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    if (parts[0] === "watch" && parts[1]) {
      await showWatch(decodeURIComponent(parts[1]));
    } else setMode(parts[0] === "shorts" ? "short" : "long", { updateHash: !parts.length });
  }

  async function showWatch(id) {
    cleanupShortObserver();
    let video = findVideo(id);
    if (!video) {
      await Promise.all([loadFeed("long"), loadFeed("short")]);
      video = findVideo(id);
    }
    if (!video) {
      showToast("That video isn’t available.");
      location.hash = "#/long";
      return;
    }
    state.currentVideo = video;
    state.mode = "long";
    document.body.dataset.mode = "long";
    els.longView.classList.remove("active");
    els.shortsView.classList.remove("active");
    els.watchView.classList.add("active");
    els.modeButtons.forEach(button => button.classList.toggle("active", button.dataset.modeTarget === "long"));
    els.watchPlayer.src = videoUrl(video.id);
    els.watchPlayer.poster = thumbnailUrl(video.id);
    els.watchTitle.textContent = video.title;
    els.watchCreator.textContent = video.creator.displayName;
    els.watchAvatar.textContent = initials(video.creator.displayName);
    els.watchHandle.textContent = `@${video.creator.username}`;
    updateWatchLike();
    els.watchDescription.innerHTML = `<strong>${formatCount(video.stats.views)} views · ${relativeTime(video.uploadedAt)}</strong>${escapeHTML(video.description || "Thanks for watching on Whiskr.")}`;
    renderRelated(video.id);
    els.watchCommentsList.innerHTML = `<div class="comments-placeholder">Loading comments…</div>`;
    els.watchCommentCount.textContent = formatCount(video.stats.comments);
    loadComments(video.id, els.watchCommentsList);
    recordView(video.id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderRelated(currentId) {
    const related = state.feeds.long.filter(video => video.id !== currentId).slice(0, 10);
    els.relatedVideos.innerHTML = related.length ? related.map(video => `<article class="related-card" data-video-id="${escapeHTML(video.id)}" tabindex="0"><div class="thumbnail"><img src="${thumbnailUrl(video.id)}" alt="" loading="lazy"></div><div><h3>${escapeHTML(video.title)}</h3><span>${escapeHTML(video.creator.displayName)}</span><span>${formatCount(video.stats.views)} views · ${relativeTime(video.uploadedAt)}</span></div></article>`).join("") : `<p class="comments-placeholder">More recommendations will appear here.</p>`;
  }

  function updateWatchLike() {
    const video = state.currentVideo;
    if (!video) return;
    els.watchLikeButton.classList.toggle("liked", video.liked);
    els.watchLikeButton.setAttribute("aria-pressed", String(video.liked));
    $("span", els.watchLikeButton).textContent = video.stats.likes ? formatCount(video.stats.likes) : "Like";
  }

  async function toggleLike(video, button) {
    const previous = video.liked;
    video.liked = !previous;
    video.stats.likes = Math.max(0, video.stats.likes + (video.liked ? 1 : -1));
    syncLikeUI(video);
    try {
      const data = await api(`/videos/${encodeURIComponent(video.id)}/like`, { method: "POST", body: { liked: video.liked } });
      video.liked = data.liked ?? video.liked;
      video.stats.likes = Number(data.likeCount ?? data.likes ?? video.stats.likes);
      syncLikeUI(video);
    } catch (error) {
      video.liked = previous;
      video.stats.likes = Math.max(0, video.stats.likes + (previous ? 1 : -1));
      syncLikeUI(video);
      showToast(error.message);
    }
  }

  function syncLikeUI(video) {
    $$(`[data-video-id="${CSS.escape(video.id)}"] [data-short-action="like"]`).forEach(button => {
      button.classList.toggle("liked", video.liked);
      button.setAttribute("aria-pressed", String(video.liked));
      const count = $("[data-count]", button);
      if (count) count.textContent = formatCount(video.stats.likes);
    });
    if (state.currentVideo?.id === video.id) updateWatchLike();
  }

  async function shareVideo(video) {
    const url = `${location.origin}${location.pathname}#/watch/${encodeURIComponent(video.id)}`;
    try {
      if (navigator.share) await navigator.share({ title: video.title, text: `Watch ${video.title} on Whiskr`, url });
      else { await navigator.clipboard.writeText(url); showToast("Link copied to clipboard"); }
    } catch (error) {
      if (error.name !== "AbortError") showToast("Couldn’t share this video.");
    }
  }

  async function loadComments(videoId, target) {
    try {
      const data = await api(`/videos/${encodeURIComponent(videoId)}/comments`);
      renderComments(data.comments || [], target);
    } catch (error) {
      target.innerHTML = `<div class="comments-placeholder">${escapeHTML(error.status === 404 ? "Comments will be available after the server update." : error.message)}</div>`;
    }
  }

  function renderComments(comments, target) {
    if (!comments.length) { target.innerHTML = `<div class="comments-placeholder">No comments yet. Start the conversation.</div>`; return; }
    target.innerHTML = comments.map(comment => {
      const user = comment.user || comment.author || {};
      const name = user.displayName || user.username || "Whiskr user";
      return `<article class="comment-item"><div class="avatar">${escapeHTML(initials(name))}</div><div class="comment-body"><strong>${escapeHTML(name)}</strong><time>${relativeTime(comment.createdAt)}</time><p>${escapeHTML(comment.text || comment.body || "")}</p></div></article>`;
    }).join("");
  }

  async function openComments(video) {
    state.commentsVideo = video;
    state.drawerTrigger = document.activeElement;
    els.drawerCommentCount.textContent = formatCount(video.stats.comments);
    els.drawerCommentsList.innerHTML = `<div class="comments-placeholder">Loading comments…</div>`;
    document.body.classList.add("drawer-open");
    $(".app-shell").inert = true;
    els.commentsDrawer.setAttribute("aria-hidden", "false");
    setTimeout(() => $("#closeComments").focus(), 40);
    await loadComments(video.id, els.drawerCommentsList);
  }

  function closeComments() {
    document.body.classList.remove("drawer-open");
    $(".app-shell").inert = false;
    els.commentsDrawer.setAttribute("aria-hidden", "true");
    state.drawerTrigger?.focus?.();
    state.drawerTrigger = null;
  }

  async function submitComment(event, context) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.comment;
    const text = input.value.trim();
    const video = context === "drawer" ? state.commentsVideo : state.currentVideo;
    if (!text || !video) return;
    if (!state.nickname) {
      state.pendingComment = { form, context };
      els.nicknameError.textContent = "";
      if (!els.nicknameDialog.open) els.nicknameDialog.showModal();
      document.body.classList.add("dialog-open");
      setTimeout(() => els.nicknameForm.elements.nickname.focus(), 50);
      return;
    }
    await postComment(form, context, video, text);
  }

  async function postComment(form, context, video, text) {
    const input = form.elements.comment;
    const button = $("button[type='submit']", form);
    button.disabled = true;
    try {
      const data = await api(`/videos/${encodeURIComponent(video.id)}/comments`, { method: "POST", body: { text, nickname: state.nickname } });
      input.value = "";
      video.stats.comments = Number(data.commentCount ?? data.count ?? video.stats.comments + 1);
      const target = context === "drawer" ? els.drawerCommentsList : els.watchCommentsList;
      if (data.comment) {
        const existing = target.innerHTML.includes("comments-placeholder") ? [] : (data.comments || []);
        if (existing.length) renderComments(existing, target);
        else {
          const current = data.comment;
          const user = current.user || current.author || { displayName: state.nickname, username: state.nickname };
          const element = document.createElement("article");
          element.className = "comment-item";
          element.innerHTML = `<div class="avatar">${escapeHTML(initials(user.displayName || user.username))}</div><div class="comment-body"><strong>${escapeHTML(user.displayName || user.username)}</strong><time>Just now</time><p>${escapeHTML(current.text || text)}</p></div>`;
          if (target.innerHTML.includes("comments-placeholder")) target.innerHTML = "";
          target.prepend(element);
        }
      } else await loadComments(video.id, target);
      syncCommentCounts(video);
    } catch (error) { showToast(error.message); }
    finally { button.disabled = false; }
  }

  function syncCommentCounts(video) {
    $$(`[data-video-id="${CSS.escape(video.id)}"] [data-short-action="comments"] [data-count]`).forEach(element => { element.textContent = formatCount(video.stats.comments); });
    if (state.currentVideo?.id === video.id) els.watchCommentCount.textContent = formatCount(video.stats.comments);
    if (state.commentsVideo?.id === video.id) els.drawerCommentCount.textContent = formatCount(video.stats.comments);
  }

  async function submitNickname(event) {
    event.preventDefault();
    const nickname = String(els.nicknameForm.elements.nickname.value || "").trim();
    if (nickname.length < 2 || nickname.length > 24) {
      els.nicknameError.textContent = "Use a nickname between 2 and 24 characters.";
      return;
    }
    state.nickname = nickname;
    localStorage.setItem("whiskr_nickname", nickname);
    $$('[data-current-avatar]').forEach(element => { element.textContent = initials(nickname); });
    els.nicknameDialog.close();
    document.body.classList.remove("dialog-open");
    const pending = state.pendingComment;
    state.pendingComment = null;
    if (pending) {
      const input = pending.form.elements.comment;
      const video = pending.context === "drawer" ? state.commentsVideo : state.currentVideo;
      const text = input.value.trim();
      if (video && text) await postComment(pending.form, pending.context, video, text);
    }
  }

  function clearThumbnailFrames({ hide = true } = {}) {
    state.thumbnailFrames.forEach(frame => URL.revokeObjectURL(frame.previewUrl));
    state.thumbnailFrames = [];
    state.selectedThumbnail = null;
    state.selectedThumbnailSource = null;
    els.thumbnailOptions.innerHTML = "";
    els.thumbnailGenerator.classList.toggle("hidden", hide);
    els.thumbnailGenerator.removeAttribute("data-orientation");
    $("#customThumbnailDrop").classList.remove("custom-selected");
  }

  function selectGeneratedThumbnail(index) {
    const frame = state.thumbnailFrames[index];
    if (!frame) return;
    state.selectedThumbnail = frame.blob;
    state.selectedThumbnailSource = "generated";
    const customInput = els.uploadForm.elements.thumbnail;
    customInput.value = "";
    $('[data-file-name="thumbnail"]', els.uploadForm).textContent = "Use an image instead";
    $("#customThumbnailDrop").classList.remove("custom-selected");
    $$(".thumbnail-option", els.thumbnailOptions).forEach((button, buttonIndex) => {
      const selected = buttonIndex === index;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-checked", String(selected));
    });
  }

  function renderThumbnailFrames() {
    els.thumbnailOptions.innerHTML = state.thumbnailFrames.map((frame, index) => `
      <button class="thumbnail-option" type="button" role="radio" aria-checked="false" aria-label="Use thumbnail ${index + 1} at ${formatDuration(frame.time)}" data-thumbnail-index="${index}">
        <img src="${frame.previewUrl}" alt="Thumbnail option ${index + 1}">
        <span class="thumbnail-check" aria-hidden="true">✓</span>
        <time>${formatDuration(frame.time)}</time>
      </button>`).join("");
    $$(".thumbnail-option", els.thumbnailOptions).forEach(button => button.addEventListener("click", () => selectGeneratedThumbnail(Number(button.dataset.thumbnailIndex))));
  }

  function seekVideo(video, time) {
    return new Promise((resolve, reject) => {
      const onSeeked = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("Couldn’t read this moment in the video.")); };
      const cleanup = () => { video.removeEventListener("seeked", onSeeked); video.removeEventListener("error", onError); };
      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.currentTime = Math.max(0, Math.min(time, Math.max(0, video.duration - .05)));
    });
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Couldn’t create this thumbnail.")), "image/jpeg", .88));
  }

  async function generateThumbnailChoices(file) {
    if (!file?.size) return;
    const token = ++state.thumbnailGenerationToken;
    state.thumbnailFrames.forEach(frame => URL.revokeObjectURL(frame.previewUrl));
    state.thumbnailFrames = [];
    state.selectedThumbnail = null;
    state.selectedThumbnailSource = null;
    els.thumbnailGenerator.classList.remove("hidden");
    els.thumbnailOptions.innerHTML = '<div class="thumbnail-loading"></div><div class="thumbnail-loading"></div><div class="thumbnail-loading"></div>';
    $("#regenerateThumbnails").disabled = true;
    $("#customThumbnailDrop").classList.remove("custom-selected");
    const sourceUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = sourceUrl;
    try {
      await new Promise((resolve, reject) => {
        video.addEventListener("loadedmetadata", resolve, { once: true });
        video.addEventListener("error", () => reject(new Error("This video couldn’t be previewed.")), { once: true });
        video.load();
      });
      if (token !== state.thumbnailGenerationToken) return;
      if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) throw new Error("This video doesn’t contain previewable frames.");
      els.thumbnailGenerator.dataset.orientation = video.videoHeight > video.videoWidth ? "portrait" : "landscape";
      const ranges = [[.08, .30], [.36, .63], [.70, .94]];
      const times = ranges.map(([start, end]) => Math.max(.01, video.duration * (start + Math.random() * (end - start))));
      const frames = [];
      for (const time of times) {
        await seekVideo(video, time);
        if (token !== state.thumbnailGenerationToken) return;
        const maxDimension = 720;
        const scale = Math.min(maxDimension / video.videoWidth, maxDimension / video.videoHeight);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        const blob = await canvasToBlob(canvas);
        frames.push({ blob, time, previewUrl: URL.createObjectURL(blob) });
      }
      if (token !== state.thumbnailGenerationToken) { frames.forEach(frame => URL.revokeObjectURL(frame.previewUrl)); return; }
      state.thumbnailFrames = frames;
      renderThumbnailFrames();
      selectGeneratedThumbnail(0);
    } catch (error) {
      if (token === state.thumbnailGenerationToken) {
        els.thumbnailOptions.innerHTML = `<p class="thumbnail-error">${escapeHTML(error.message)} Choose a custom image instead.</p>`;
        els.uploadError.textContent = error.message;
      }
    } finally {
      URL.revokeObjectURL(sourceUrl);
      if (token === state.thumbnailGenerationToken) $("#regenerateThumbnails").disabled = false;
    }
  }

  function openUpload(type) {
    els.uploadError.textContent = "";
    els.uploadForm.reset();
    state.thumbnailGenerationToken += 1;
    clearThumbnailFrames();
    const progress = $("#uploadProgress");
    progress.classList.add("hidden");
    $("span", progress).style.width = "0";
    $("p", progress).textContent = "Preparing your upload…";
    $$("[data-file-name]", els.uploadForm).forEach(element => { element.textContent = "No file selected"; });
    if (type) {
      const radio = $(`input[name="type"][value="${type}"]`, els.uploadForm);
      if (radio) radio.checked = true;
    }
    if (!els.uploadDialog.open) els.uploadDialog.showModal();
    document.body.classList.add("dialog-open");
  }

  function readFileAsDataURI(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Couldn’t read this file."));
      reader.readAsDataURL(file);
    });
  }

  async function waitForUpload(jobId, onProgress) {
    for (let attempt = 0; attempt < 900; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const job = await api(`/upload/status/${encodeURIComponent(jobId)}`);
      onProgress?.(job, attempt);
      if (job.status === "complete") return job.result;
      if (job.status === "error") throw new Error(job.error || "The upload could not be processed.");
    }
    throw new Error("The upload is still processing. Refresh the feed in a moment.");
  }

  async function submitUpload(event) {
    event.preventDefault();
    const formData = new FormData(els.uploadForm);
    const video = formData.get("video");
    const thumbnail = state.selectedThumbnail || formData.get("thumbnail");
    const type = formData.get("type") === "short" ? "short" : "long";
    if (!video?.size) { els.uploadError.textContent = "Choose an MP4 video first."; return; }
    if (!thumbnail?.size) { els.uploadError.textContent = "Choose one of the generated thumbnails or upload a custom image."; return; }
    if (video.size > 500 * 1024 * 1024) { els.uploadError.textContent = "Please choose a video under 500 MB."; return; }
    const submit = $(".primary-submit", els.uploadForm);
    const progress = $("#uploadProgress");
    const progressBar = $("span", progress);
    const progressCopy = $("p", progress);
    submit.disabled = true;
    progress.classList.remove("hidden");
    els.uploadError.textContent = "";
    try {
      progressBar.style.width = "24%";
      progressCopy.textContent = "Preparing your files…";
      const [videoData, thumbnailData] = await Promise.all([readFileAsDataURI(video), readFileAsDataURI(thumbnail)]);
      progressBar.style.width = "62%";
      progressCopy.textContent = "Publishing to Whiskr…";
      const queuedUpload = await api("/upload", { method: "POST", body: {
        videoData, thumbnailData,
        title: String(formData.get("title") || "").trim(),
        description: String(formData.get("description") || "").trim(),
        type
      }});
      if (queuedUpload.jobId) {
        progressCopy.textContent = "Processing your video…";
        await waitForUpload(queuedUpload.jobId, (job, attempt) => {
          progressBar.style.width = `${Math.min(94, 64 + attempt * .35)}%`;
          if (job.status === "queued") progressCopy.textContent = "Your upload is queued…";
          if (job.status === "processing") progressCopy.textContent = typeof job.progress === "string" ? job.progress : "Processing your video…";
        });
      }
      progressBar.style.width = "100%";
      progressCopy.textContent = "Published!";
      state.loaded[type] = false;
      await loadFeed(type, { refresh: true });
      setTimeout(() => {
        els.uploadDialog.close();
        document.body.classList.remove("dialog-open");
        setMode(type);
        showToast(type === "short" ? "Your Short is live." : "Your video is live.");
      }, 450);
    } catch (error) { els.uploadError.textContent = error.message; }
    finally { submit.disabled = false; }
  }

  function moveShort(direction) {
    const slides = $$(".short-slide", els.shortsFeed);
    if (!slides.length) return;
    const feedBounds = els.shortsFeed.getBoundingClientRect();
    let index = slides.findIndex(slide => {
      const bounds = slide.getBoundingClientRect();
      return Math.abs(bounds.top - feedBounds.top) < feedBounds.height * .35;
    });
    if (index < 0) index = 0;
    slides[Math.max(0, Math.min(slides.length - 1, index + direction))].scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handleShortAction(button, slide) {
    const video = findVideo(slide.dataset.videoId);
    if (!video) return;
    switch (button.dataset.shortAction) {
      case "like": toggleLike(video, button); break;
      case "comments": openComments(video); break;
      case "share": shareVideo(video); break;
      case "bookmark":
        if (state.saved.has(video.id)) state.saved.delete(video.id); else state.saved.add(video.id);
        localStorage.setItem("whiskr_saved", JSON.stringify([...state.saved]));
        button.classList.toggle("liked", state.saved.has(video.id));
        button.setAttribute("aria-pressed", String(state.saved.has(video.id)));
        showToast(state.saved.has(video.id) ? "Saved on this device" : "Removed from saved videos");
        break;
      case "mute":
        state.muted = !state.muted;
        localStorage.setItem("whiskr_muted", String(state.muted));
        $$(".short-video").forEach(item => { item.muted = state.muted; });
        $$("[data-short-action='mute']").forEach(item => { item.innerHTML = icon(state.muted ? "muted" : "volume"); item.setAttribute("aria-label", state.muted ? "Unmute" : "Mute"); });
        break;
    }
  }

  function bindEvents() {
    window.addEventListener("hashchange", route);
    els.modeButtons.forEach(button => button.addEventListener("click", () => setMode(button.dataset.modeTarget)));
    $("#menuButton").addEventListener("click", () => {
      document.body.classList.toggle("sidebar-collapsed");
      localStorage.setItem("whiskr_sidebar_collapsed", document.body.classList.contains("sidebar-collapsed") ? "1" : "0");
    });
    els.searchForm.addEventListener("submit", event => { event.preventDefault(); state.query = els.searchInput.value; if (state.mode !== "long") setMode("long"); else renderLongFeed(); });
    els.searchInput.addEventListener("input", () => { if (!els.searchInput.value && state.query) { state.query = ""; renderLongFeed(); } });
    $("#categoryStrip").addEventListener("click", event => {
      const button = event.target.closest("[data-query]");
      if (!button) return;
      $$(".category").forEach(item => item.classList.toggle("active", item === button));
      state.query = button.dataset.query;
      els.searchInput.value = state.query && state.query !== "Recently uploaded" ? state.query : "";
      renderLongFeed();
    });
    $$(".topic-chip").forEach(button => button.addEventListener("click", () => { state.query = button.dataset.query; els.searchInput.value = state.query; setMode("long"); renderLongFeed(); }));
    $("[data-scroll-explore]").addEventListener("click", () => $("#categoryStrip").scrollIntoView({ behavior: "smooth" }));
    $("#refreshFeedButton").addEventListener("click", () => loadFeed("long", { refresh: true }));

    els.videoGrid.addEventListener("click", event => {
      if (event.target.closest(".card-menu")) { showToast("More options are coming soon."); return; }
      const card = event.target.closest(".video-card");
      if (card) location.hash = `#/watch/${encodeURIComponent(card.dataset.videoId)}`;
    });
    els.videoGrid.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key) && event.target.matches(".video-card")) { event.preventDefault(); event.target.click(); } });
    els.relatedVideos.addEventListener("click", event => { const card = event.target.closest(".related-card"); if (card) location.hash = `#/watch/${encodeURIComponent(card.dataset.videoId)}`; });
    els.relatedVideos.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key) && event.target.matches(".related-card")) event.target.click(); });
    $("#backButton").addEventListener("click", () => history.length > 1 ? history.back() : (location.hash = "#/long"));
    els.watchLikeButton.addEventListener("click", () => state.currentVideo && toggleLike(state.currentVideo, els.watchLikeButton));
    $("#watchShareButton").addEventListener("click", () => state.currentVideo && shareVideo(state.currentVideo));

    els.shortsFeed.addEventListener("click", event => { const button = event.target.closest("[data-short-action]"); const slide = event.target.closest(".short-slide"); if (button && slide) { event.stopPropagation(); handleShortAction(button, slide); } });
    $$("[data-short-tab]").forEach(button => button.addEventListener("click", () => {
      state.shortTab = button.dataset.shortTab;
      $$("[data-short-tab]").forEach(item => { const active = item === button; item.classList.toggle("active", active); item.setAttribute("aria-selected", String(active)); item.tabIndex = active ? 0 : -1; });
      renderShortsFeed();
      els.shortsFeed.scrollTop = 0;
    }));
    $(".shorts-tabs").addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const tabs = $$("[data-short-tab]");
      const next = tabs[(tabs.indexOf(document.activeElement) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      next.click();
      next.focus();
    });
    $("#previousShort").addEventListener("click", () => moveShort(-1));
    $("#nextShort").addEventListener("click", () => moveShort(1));
    document.addEventListener("keydown", event => {
      if (document.body.classList.contains("drawer-open")) {
        if (event.key === "Escape") { event.preventDefault(); closeComments(); return; }
        if (event.key === "Tab") {
          const focusable = $$("button:not([disabled]), input:not([disabled])", els.commentsDrawer).filter(element => element.offsetParent !== null);
          if (focusable.length) {
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }
        return;
      }
      if (state.mode !== "short" || document.body.classList.contains("drawer-open") || $("dialog[open]")) return;
      if (["ArrowDown", "PageDown"].includes(event.key)) { event.preventDefault(); moveShort(1); }
      if (["ArrowUp", "PageUp"].includes(event.key)) { event.preventDefault(); moveShort(-1); }
      if (event.key === " ") { event.preventDefault(); const video = $$(".short-video").find(item => !item.paused); if (video) video.pause(); else $(".short-video")?.play().catch(() => {}); }
    });

    $("#closeComments").addEventListener("click", closeComments);
    els.drawerBackdrop.addEventListener("click", closeComments);
    $("#drawerCommentForm").addEventListener("submit", event => submitComment(event, "drawer"));
    $("#watchCommentForm").addEventListener("submit", event => submitComment(event, "watch"));
    els.nicknameForm.addEventListener("submit", submitNickname);

    $("#openUploadButton").addEventListener("click", () => openUpload());
    $$('[data-open-upload]').forEach(button => button.addEventListener("click", () => openUpload()));
    $("[data-mobile-explore]").addEventListener("click", () => { setMode("long"); setTimeout(() => $("#categoryStrip").scrollIntoView({ behavior: "smooth" }), 50); });
    $("[data-mobile-refresh]").addEventListener("click", () => loadFeed(state.mode, { refresh: true }));
    els.uploadForm.addEventListener("submit", submitUpload);
    $$('input[type="file"]', els.uploadForm).forEach(input => input.addEventListener("change", () => { const target = $(`[data-file-name="${input.name}"]`, els.uploadForm); if (target) target.textContent = input.files[0]?.name || "No file selected"; }));
    $$("[data-close-dialog]").forEach(button => button.addEventListener("click", () => { const dialog = button.closest("dialog"); dialog.close(); document.body.classList.remove("dialog-open"); }));
    $$("dialog").forEach(dialog => {
      dialog.addEventListener("click", event => { if (event.target === dialog) { dialog.close(); document.body.classList.remove("dialog-open"); } });
      dialog.addEventListener("close", () => document.body.classList.remove("dialog-open"));
    });

    document.addEventListener("click", event => {
      const action = event.target.closest("[data-empty-action]")?.dataset.emptyAction;
      if (!action) return;
      if (action === "refresh") loadFeed("long", { refresh: true });
      if (action === "refresh-shorts") loadFeed("short", { refresh: true });
      if (action === "clear-search") { state.query = ""; els.searchInput.value = ""; renderLongFeed(); }
      if (action === "upload") openUpload("long");
      if (action === "upload-short") openUpload("short");
    });
  }

  async function init() {
    if (localStorage.getItem("whiskr_sidebar_collapsed") === "1" && innerWidth > 1040) document.body.classList.add("sidebar-collapsed");
    if (state.nickname) $$('[data-current-avatar]').forEach(element => { element.textContent = initials(state.nickname); });
    bindEvents();
    await route();
  }

  init();
})();
