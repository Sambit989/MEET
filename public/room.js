const socket = io();

// Parse URL params
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get("room");
let roomPassword = urlParams.get("pwd") || "";
let displayName = urlParams.get("name") || "";
let isHost = urlParams.get("host") === "1";

if (!displayName) {
  displayName = prompt("Enter your name (optional):") || "Guest";
}

const roomLabel = document.getElementById("roomLabel");
roomLabel.textContent = roomId ? `Room: ${roomId}` : "";

const videoGrid = document.getElementById("videoGrid");
const toggleVideoBtn = document.getElementById("toggleVideo");
const toggleAudioBtn = document.getElementById("toggleAudio");
const leaveBtn = document.getElementById("leaveBtn");
const screenShareBtn = document.getElementById("screenShareBtn");
const whiteboardBtn = document.getElementById("whiteboardBtn");
const captionsBtn = document.getElementById("captionsBtn");
const noiseBtn = document.getElementById("noiseBtn");
const themeToggleRoom = document.getElementById("themeToggleRoom");
const captionsBar = document.getElementById("captionsBar");
const meetingTimerEl = document.getElementById("meetingTimer");
const networkStatusEl = document.getElementById("networkStatus");

const lobbyOverlay = document.getElementById("lobbyOverlay");
const lobbyMessage = document.getElementById("lobbyMessage");
const roomEndedOverlay = document.getElementById("roomEndedOverlay");

const participantsList = document.getElementById("participantsList");
const lobbyHostSection = document.getElementById("lobbyHostSection");
const lobbyList = document.getElementById("lobbyList");

const tabButtons = document.querySelectorAll(".tab-btn");
const peopleTab = document.getElementById("peopleTab");
const chatTab = document.getElementById("chatTab");
const aiTab = document.getElementById("aiTab");

const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");

const fileShareBtn = document.getElementById("fileShareBtn");
const fileInput = document.getElementById("fileInput");

const whiteboard = document.getElementById("whiteboard");
const translationLang = document.getElementById("translationLang");
const aiSummary = document.getElementById("aiSummary");
const aiActions = document.getElementById("aiActions");
const aiTranslation = document.getElementById("aiTranslation");

// State
let localStream;
let videoEnabled = true;
let audioEnabled = true;
let screenSharing = false;
let originalVideoTrack = null;
let meetingStartTime = null;
let meetingTimerInterval = null;

const peers = {}; // socketId -> SimplePeer
const myVideo = document.createElement("video");
myVideo.muted = true;
let mySocketId = null;

// Chat history (for future AI integration)
const chatHistory = [];

// Live captions (SpeechRecognition)
let recognition = null;
let captionsOn = false;

// Whiteboard state
let drawing = false;
let lastPos = null;

// Notifications beep
function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
    osc.stop(ctx.currentTime + 0.15);
  } catch (e) {
    // ignore
  }
}

// Theme toggle
themeToggleRoom.addEventListener("click", () => {
  document.body.classList.toggle("theme-dark");
  document.body.classList.toggle("theme-light");
});

// Tabs
tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    [peopleTab, chatTab, aiTab].forEach((tab) => tab.classList.add("hidden"));
    const targetId = btn.getAttribute("data-tab");
    document.getElementById(targetId).classList.remove("hidden");
  });
});

// Meeting timer
function startMeetingTimer() {
  meetingStartTime = Date.now();
  meetingTimerInterval = setInterval(() => {
    const diff = Math.floor((Date.now() - meetingStartTime) / 1000);
    const mins = String(Math.floor(diff / 60)).padStart(2, "0");
    const secs = String(diff % 60).padStart(2, "0");
    meetingTimerEl.textContent = `${mins}:${secs}`;
  }, 1000);
}

// Network status (simple)
function setNetworkStatus(status) {
  networkStatusEl.classList.remove("network-good", "network-medium", "network-bad");
  if (status === "good") {
    networkStatusEl.textContent = "Good";
    networkStatusEl.classList.add("network-good");
  } else if (status === "medium") {
    networkStatusEl.textContent = "OK";
    networkStatusEl.classList.add("network-medium");
  } else {
    networkStatusEl.textContent = "Poor";
    networkStatusEl.classList.add("network-bad");
  }
}

// Init media and join room
navigator.mediaDevices
  .getUserMedia({
    video: { width: 1280, height: 720 },
    audio: { echoCancellation: true, noiseSuppression: true },
  })
  .then((stream) => {
    localStream = stream;
    addVideoStream(myVideo, stream, displayName + " (You)");

    socket.emit("join-room", {
      roomId,
      username: displayName,
      password: roomPassword,
      isHost,
    });

    // Socket events binding
    socket.on("connect", () => {
      mySocketId = socket.id;
      setNetworkStatus("good");
    });

    socket.io.on("reconnect_attempt", () => {
      setNetworkStatus("medium");
    });

    socket.io.on("reconnect_failed", () => {
      setNetworkStatus("bad");
    });

    socket.on("join-error", (msg) => {
      alert(msg || "Could not join room.");
      window.location.href = "/";
    });

    socket.on("lobby-wait", (msg) => {
      lobbyMessage.textContent = msg;
      lobbyOverlay.classList.remove("hidden");
    });

    socket.on("joined-room", (data) => {
      isHost = data.isHost;
      lobbyOverlay.classList.add("hidden");
      if (!meetingTimerInterval) startMeetingTimer();
      if (isHost) {
        lobbyHostSection.classList.remove("hidden");
      }
    });

    socket.on("all-users", (users) => {
      users.forEach((userId) => {
        const peer = createPeer(userId, socket.id, stream);
        peers[userId] = peer;
      });
    });

    socket.on("user-joined", (payload) => {
      const peer = addPeer(payload.signal, payload.callerId, stream);
      peers[payload.callerId] = peer;
    });

    socket.on("receiving-returned-signal", (payload) => {
      const peer = peers[payload.id];
      if (peer) {
        peer.signal(payload.signal);
      }
    });

    socket.on("user-left", (id) => {
      if (peers[id]) {
        peers[id].destroy();
        delete peers[id];
      }
      const wrapper = document.getElementById("video-wrapper-" + id);
      if (wrapper) wrapper.remove();
      playBeep();
    });

    socket.on("room-ended", () => {
      roomEndedOverlay.classList.remove("hidden");
      if (meetingTimerInterval) clearInterval(meetingTimerInterval);
    });

    // Participants
    socket.on("participants-update", ({ users, hostId }) => {
      renderParticipants(users, hostId);
    });

    socket.on("lobby-update", ({ lobby }) => {
      renderLobby(lobby);
    });

    // Chat
    socket.on("chat-message", ({ from, message, time }) => {
      chatHistory.push({ from, message, time });
      appendChatMessage(from, message, time);
      if (from !== displayName) playBeep();
    });

    // File share
    socket.on("file-share", ({ from, fileName, fileDataUrl, mimeType }) => {
      appendFileMessage(from, fileName, fileDataUrl, mimeType);
      if (from !== displayName) playBeep();
    });

    // Whiteboard
    socket.on("whiteboard-draw", ({ line }) => {
      drawLine(line.x0, line.y0, line.x1, line.y1, false);
    });

    socket.on("whiteboard-clear", () => {
      clearWhiteboard(false);
    });

    // Captions
    socket.on("caption-update", ({ from, text }) => {
      showCaption(from + ": " + text);
      // For real translation, send to backend here
    });

    // Host controls
    socket.on("force-mute", ({ type }) => {
      if (!localStream) return;
      if (type === "audio") {
        localStream.getAudioTracks().forEach((t) => (t.enabled = false));
        audioEnabled = false;
        toggleAudioBtn.textContent = "🔇";
      } else if (type === "video") {
        localStream.getVideoTracks().forEach((t) => (t.enabled = false));
        videoEnabled = false;
        toggleVideoBtn.textContent = "🚫";
      }
    });

    socket.on("removed-by-host", () => {
      alert("You were removed by the host.");
      window.location.href = "/";
    });
  })
  .catch((err) => {
    console.error("Error accessing media devices:", err);
    alert("Could not access camera/microphone.");
    window.location.href = "/";
  });

// WebRTC helpers
function createPeer(userToSignal, callerId, stream) {
  const peer = new SimplePeer({
    initiator: true,
    trickle: false,
    stream,
  });

  peer.on("signal", (signal) => {
    socket.emit("sending-signal", {
      userToSignal,
      callerId,
      signal,
    });
  });

  peer.on("stream", (remoteStream) => {
    const video = document.createElement("video");
    const wrapperId = "video-wrapper-" + userToSignal;
    video.id = "video-" + userToSignal;
    addVideoStream(video, remoteStream, "Guest", wrapperId);
  });

  peer.on("connect", () => {
    setNetworkStatus("good");
  });

  peer.on("error", () => {
    setNetworkStatus("medium");
  });

  return peer;
}

function addPeer(incomingSignal, callerId, stream) {
  const peer = new SimplePeer({
    initiator: false,
    trickle: false,
    stream,
  });

  peer.on("signal", (signal) => {
    socket.emit("returning-signal", {
      signal,
      callerId,
    });
  });

  peer.on("stream", (remoteStream) => {
    const video = document.createElement("video");
    const wrapperId = "video-wrapper-" + callerId;
    video.id = "video-" + callerId;
    addVideoStream(video, remoteStream, "Guest", wrapperId);
  });

  peer.signal(incomingSignal);
  return peer;
}

// Add a video element to DOM
function addVideoStream(video, stream, labelText, wrapperId) {
  video.srcObject = stream;
  video.addEventListener("loadedmetadata", () => {
    video.play();
  });

  const wrapper = document.createElement("div");
  wrapper.className = "video-wrapper";
  wrapper.id = wrapperId || "video-wrapper-self";
  wrapper.appendChild(video);

  if (labelText) {
    const label = document.createElement("div");
    label.textContent = labelText;
    label.style.fontSize = "0.8rem";
    label.style.padding = "0.25rem 0.5rem";
    label.style.color = "var(--fg)";
    wrapper.appendChild(label);
  }

  videoGrid.appendChild(wrapper);
}

/* PARTICIPANTS & LOBBY */

function renderParticipants(users, hostId) {
  participantsList.innerHTML = "";
  Object.entries(users).forEach(([id, info]) => {
    const li = document.createElement("li");
    const left = document.createElement("div");
    left.textContent = info.name || "Guest";
    if (id === hostId) {
      const badge = document.createElement("span");
      badge.textContent = "Host";
      badge.className = "host-badge";
      left.appendChild(badge);
    }
    li.appendChild(left);

    if (isHost && id !== hostId) {
      const controls = document.createElement("div");

      const muteA = document.createElement("button");
      muteA.textContent = "Mute";
      muteA.className = "pill-btn";
      muteA.onclick = () =>
        socket.emit("host-mute-user", { roomId, userId: id, type: "audio" });

      const stopV = document.createElement("button");
      stopV.textContent = "Video";
      stopV.className = "pill-btn";
      stopV.onclick = () =>
        socket.emit("host-mute-user", { roomId, userId: id, type: "video" });

      const remove = document.createElement("button");
      remove.textContent = "Remove";
      remove.className = "pill-btn";
      remove.onclick = () =>
        socket.emit("remove-user", { roomId, userId: id });

      controls.appendChild(muteA);
      controls.appendChild(stopV);
      controls.appendChild(remove);
      li.appendChild(controls);
    }

    participantsList.appendChild(li);
  });
}

function renderLobby(lobby) {
  lobbyList.innerHTML = "";
  if (!isHost) return;
  const entries = Object.entries(lobby);
  if (!entries.length) {
    lobbyHostSection.classList.add("hidden");
    return;
  }
  lobbyHostSection.classList.remove("hidden");
  entries.forEach(([id, info]) => {
    const li = document.createElement("li");
    const nameSpan = document.createElement("span");
    nameSpan.textContent = info.name || "Guest";
    li.appendChild(nameSpan);

    const controls = document.createElement("div");
    const admit = document.createElement("button");
    admit.textContent = "Admit";
    admit.className = "pill-btn";
    admit.onclick = () => socket.emit("approve-user", { roomId, userId: id });

    const reject = document.createElement("button");
    reject.textContent = "Reject";
    reject.className = "pill-btn";
    reject.onclick = () => socket.emit("reject-user", { roomId, userId: id });

    controls.appendChild(admit);
    controls.appendChild(reject);
    li.appendChild(controls);

    lobbyList.appendChild(li);
  });
}

/* CHAT */

function appendChatMessage(from, message, time) {
  const div = document.createElement("div");
  div.className = "chat-message";
  const fromSpan = document.createElement("span");
  fromSpan.className = "from";
  fromSpan.textContent = from + ":";
  const msgSpan = document.createElement("span");
  msgSpan.textContent = " " + message;
  div.appendChild(fromSpan);
  div.appendChild(msgSpan);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendFileMessage(from, fileName, fileDataUrl, mimeType) {
  const div = document.createElement("div");
  div.className = "chat-message";
  const fromSpan = document.createElement("span");
  fromSpan.className = "from";
  fromSpan.textContent = from + ":";
  const link = document.createElement("a");
  link.href = fileDataUrl;
  link.download = fileName;
  link.textContent = " Download " + fileName;
  div.appendChild(fromSpan);
  div.appendChild(link);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

chatSendBtn.addEventListener("click", () => {
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit("chat-message", { roomId, message: text });
  chatInput.value = "";
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") chatSendBtn.click();
});

/* FILE SHARING */

fileShareBtn.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;

  if (file.size > 5 * 1024 * 1024) {
    alert("File is too large (max 5 MB for demo).");
    fileInput.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const fileDataUrl = reader.result;
    socket.emit("file-share", {
      roomId,
      fileName: file.name,
      fileDataUrl,
      mimeType: file.type,
    });
  };
  reader.readAsDataURL(file);
  fileInput.value = "";
});

/* CONTROLS: AUDIO / VIDEO / SCREEN / NOISE */

toggleVideoBtn.addEventListener("click", () => {
  if (!localStream) return;
  videoEnabled = !videoEnabled;
  localStream.getVideoTracks().forEach((track) => (track.enabled = videoEnabled));
  toggleVideoBtn.textContent = videoEnabled ? "🎥" : "🚫";
});

toggleAudioBtn.addEventListener("click", () => {
  if (!localStream) return;
  audioEnabled = !audioEnabled;
  localStream.getAudioTracks().forEach((track) => (track.enabled = audioEnabled));
  toggleAudioBtn.textContent = audioEnabled ? "🎙" : "🔇";
});

screenShareBtn.addEventListener("click", async () => {
  if (!localStream) return;
  if (!screenSharing) {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      const screenTrack = screenStream.getVideoTracks()[0];
      originalVideoTrack = localStream.getVideoTracks()[0];

      // Replace track in local stream
      localStream.removeTrack(originalVideoTrack);
      localStream.addTrack(screenTrack);

      // Replace in peers
      Object.values(peers).forEach((peer) => {
        const sender = peer._pc
          .getSenders()
          .find((s) => s.track && s.track.kind === "video");
        if (sender) sender.replaceTrack(screenTrack);
      });

      screenTrack.onended = () => {
        stopScreenShare();
      };

      screenSharing = true;
      screenShareBtn.textContent = "🖥*";
    } catch (err) {
      console.error("Screen share error:", err);
    }
  } else {
    stopScreenShare();
  }
});

function stopScreenShare() {
  if (!originalVideoTrack || !localStream) return;
  const screenTrack = localStream.getVideoTracks()[0];
  if (screenTrack) screenTrack.stop();
  localStream.removeTrack(screenTrack);
  localStream.addTrack(originalVideoTrack);

  Object.values(peers).forEach((peer) => {
    const sender = peer._pc
      .getSenders()
      .find((s) => s.track && s.track.kind === "video");
    if (sender) sender.replaceTrack(originalVideoTrack);
  });

  screenSharing = false;
  screenShareBtn.textContent = "🖥";
}

noiseBtn.addEventListener("click", () => {
  alert(
    "Noise suppression is requested via getUserMedia constraints. For advanced noise removal, integrate a dedicated audio processing library."
  );
});

/* LEAVE */

leaveBtn.addEventListener("click", () => {
  Object.values(peers).forEach((peer) => peer.destroy());
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  if (meetingTimerInterval) clearInterval(meetingTimerInterval);

  // Example: send chatHistory to backend AI for summary here
  console.log("Meeting ended. Chat history for AI:", chatHistory);

  window.location.href = "/";
});

/* WHITEBOARD */

let wbCtx = whiteboard.getContext("2d");

function resizeWhiteboard() {
  whiteboard.width = whiteboard.clientWidth;
  whiteboard.height = whiteboard.clientHeight;
}
window.addEventListener("resize", resizeWhiteboard);
resizeWhiteboard();

function getPointerPos(evt) {
  const rect = whiteboard.getBoundingClientRect();
  const x = ((evt.clientX || evt.touches[0].clientX) - rect.left);
  const y = ((evt.clientY || evt.touches[0].clientY) - rect.top);
  return { x, y };
}

function drawLine(x0, y0, x1, y1, emit = true) {
  wbCtx.beginPath();
  wbCtx.moveTo(x0, y0);
  wbCtx.lineTo(x1, y1);
  wbCtx.strokeStyle = "#f97316";
  wbCtx.lineWidth = 2;
  wbCtx.stroke();
  wbCtx.closePath();

  if (!emit) return;
  socket.emit("whiteboard-draw", {
    roomId,
    line: { x0, y0, x1, y1 },
  });
}

function clearWhiteboard(emit = true) {
  wbCtx.clearRect(0, 0, whiteboard.width, whiteboard.height);
  if (emit) socket.emit("whiteboard-clear", { roomId });
}

whiteboard.addEventListener("mousedown", (e) => {
  drawing = true;
  lastPos = getPointerPos(e);
});

whiteboard.addEventListener("mousemove", (e) => {
  if (!drawing) return;
  const pos = getPointerPos(e);
  drawLine(lastPos.x, lastPos.y, pos.x, pos.y, true);
  lastPos = pos;
});

whiteboard.addEventListener("mouseup", () => (drawing = false));
whiteboard.addEventListener("mouseleave", () => (drawing = false));

whiteboard.addEventListener("touchstart", (e) => {
  drawing = true;
  lastPos = getPointerPos(e);
});

whiteboard.addEventListener("touchmove", (e) => {
  if (!drawing) return;
  const pos = getPointerPos(e);
  drawLine(lastPos.x, lastPos.y, pos.x, pos.y, true);
  lastPos = pos;
});

whiteboard.addEventListener("touchend", () => (drawing = false));

whiteboardBtn.addEventListener("click", () => {
  const visible = !whiteboard.classList.contains("hidden");
  if (visible) {
    whiteboard.classList.add("hidden");
  } else {
    resizeWhiteboard();
    whiteboard.classList.remove("hidden");
  }
});

/* CAPTIONS (browser SpeechRecognition, basic demo) */

captionsBtn.addEventListener("click", () => {
  if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
    alert("Speech Recognition not supported in this browser.");
    return;
  }

  if (!recognition) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      if (transcript.trim()) {
        socket.emit("caption-update", { roomId, text: transcript });
        showCaption("You: " + transcript);
      }
    };

    recognition.onerror = (e) => {
      console.error("Speech recognition error:", e);
    };
  }

  if (!captionsOn) {
    recognition.start();
    captionsOn = true;
    captionsBar.classList.remove("hidden");
    captionsBtn.textContent = "CC*";
  } else {
    recognition.stop();
    captionsOn = false;
    captionsBtn.textContent = "CC";
  }
});

let captionTimeout = null;
function showCaption(text) {
  captionsBar.textContent = text;
  captionsBar.classList.remove("hidden");
  clearTimeout(captionTimeout);
  captionTimeout = setTimeout(() => {
    captionsBar.classList.add("hidden");
  }, 4000);
}

/* AI placeholders */

translationLang.addEventListener("change", () => {
  const val = translationLang.value;
  if (val === "none") {
    aiTranslation.textContent =
      "(Sample) Translated captions will appear here when integrated.";
  } else {
    aiTranslation.textContent =
      "Translation target set to: " +
      val +
      ". Use a backend translation API to update this.";
  }
});
