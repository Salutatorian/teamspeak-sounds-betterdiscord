/**
 * @name TeamSpeakSounds
 * @author OpenAI
 * @version 1.3.4
 * @description Replaces Discord voice sounds and monitors microphone level for a speaking-while-muted reminder.
 */

const CLIPS = {
    mute: {
        label: "Microphone muted (you mute)",
        url: "https://www.myinstants.com/media/sounds/microphone-muted-teamspeak.mp3",
        volume: 2
    },
    unmute: {
        label: "Microphone activated (you unmute)",
        url: "https://www.myinstants.com/media/sounds/microphone-activated-teamspeak.mp3",
        volume: 2
    },
    connect: {
        label: "Connected (you join voice)",
        url: "https://www.myinstants.com/media/sounds/connected_bhfEc8z.mp3",
        volume: 2
    },
    disconnect: {
        label: "Disconnected (you leave voice)",
        url: "https://www.myinstants.com/media/sounds/disconnected_jY3MZ9B.mp3",
        volume: 2
    },
    otherJoin: {
        label: "User has joined your channel (someone else joins)",
        url: "https://www.myinstants.com/media/sounds/user-joined-your-channel-sound-xd.mp3",
        volume: 19
    },
    otherLeave: {
        label: "User has left your channel (someone else leaves)",
        url: "https://www.myinstants.com/media/sounds/user-disconnected-from-your-channel-teamspeak-3-sound-effect-free-download_VCDhOzT.mp3",
        volume: 2
    },
    speakingMuted: {
        label: "Hey, wake up (you speak while muted)",
        url: "https://www.myinstants.com/media/sounds/you_were_poked.mp3",
        volume: 2
    }
};

const PREVIOUS_DEFAULT_VOLUMES = {
    mute: 50,
    unmute: 50,
    connect: 50,
    disconnect: 50,
    otherJoin: 100,
    otherLeave: 7,
    speakingMuted: 50
};

const DISCORD_SOUNDS = {
    mute: "mute",
    unmute: "unmute",
    disconnect: "disconnect",
    user_join: "otherJoin",
    user_leave: "otherLeave"
};

module.exports = class TeamSpeakSounds {
    constructor(meta) {
        this.name = meta?.name || "TeamSpeakSounds";
        this.sounds = {};
        this.activeAudio = new Set();
        this.reportedPlaybackFailures = new Set();
        this.lastEvent = new Map();
        this.nativeHookStatus = "Not checked";
        this.lastDetectedEvent = "None yet";
        this.lastSpeakingAlert = 0;
        this.speakingCooldownMs = 600;
        this.silenceResetMs = 400;
        this.repeatIntervalMs = 0;
        this.micLevel = 0;
        this.speakingFrames = 0;
        this.speechActive = false;
        this.silenceStartedAt = 0;
        this.nativeSpeechActive = false;
        this.nativeSilenceStartedAt = 0;
        this.micStatus = "Waiting for microphone";
        this.micGeneration = 0;
        this.stopped = false;
    }

    start() {
        const {Webpack, Data, Patcher} = BdApi;
        this.stopped = false;
        this.media = Webpack.getStore("MediaEngineStore");
        this.selected = Webpack.getStore("SelectedChannelStore");
        this.voiceStates = Webpack.getStore("VoiceStateStore");
        this.users = Webpack.getStore("UserStore");
        if (!this.media || !this.selected || !this.voiceStates || !this.users) {
            BdApi.UI.showToast("TeamSpeakSounds: a Discord voice store was unavailable. Reload Discord and try again.", {type: "error"});
            return;
        }

        const migrateVolumes = !Data.load(this.name, "volumeDefaults132");
        for (const [id, clip] of Object.entries(CLIPS)) {
            const saved = Data.load(this.name, id) || {};
            const useNewDefault = migrateVolumes && saved.volume === PREVIOUS_DEFAULT_VOLUMES[id];
            this.sounds[id] = {
                url: typeof saved.url === "string" && saved.url ? saved.url : clip.url,
                volume: Number.isFinite(saved.volume) && !useNewDefault ? saved.volume : clip.volume
            };
            if (useNewDefault) Data.save(this.name, id, this.sounds[id]);
        }
        if (migrateVolumes) Data.save(this.name, "volumeDefaults132", true);
        const savedThreshold = Number(Data.load(this.name, "micThreshold"));
        this.micThreshold = Number.isFinite(savedThreshold) && savedThreshold >= 0.1 && savedThreshold <= 50
            ? savedThreshold : 1;
        const savedPause = Number(Data.load(this.name, "silenceResetMs"));
        this.silenceResetMs = Number.isFinite(savedPause) && savedPause >= 100 && savedPause <= 3000
            ? savedPause : 400;
        const savedRepeat = Number(Data.load(this.name, "repeatSeconds"));
        this.repeatIntervalMs = Number.isFinite(savedRepeat) && savedRepeat >= 1 && savedRepeat <= 60
            ? savedRepeat * 1000 : 0;

        this.channelId = this.getChannelId();
        this.muted = this.getMuted();
        this.channelMembers = this.getChannelMembers(this.channelId);
        this.onSpeaking = (_target, _args, speaking) => {
            // The microphone monitor detects new phrases; Discord's signal is
            // only a fallback when microphone access is unavailable.
            if (this.micAnalyser) return;
            if (!this.getMuted()) {
                this.nativeSpeechActive = false;
                this.nativeSilenceStartedAt = 0;
                return;
            }
            if (!speaking) {
                if (!this.nativeSilenceStartedAt) this.nativeSilenceStartedAt = Date.now();
                if (Date.now() - this.nativeSilenceStartedAt >= this.silenceResetMs) this.nativeSpeechActive = false;
                return;
            }
            if (this.nativeSilenceStartedAt && Date.now() - this.nativeSilenceStartedAt >= this.silenceResetMs) {
                this.nativeSpeechActive = false;
            }
            this.nativeSilenceStartedAt = 0;
            if (!this.nativeSpeechActive) {
                this.nativeSpeechActive = true;
                this.onMutedSpeaking();
            } else if (this.repeatIntervalMs > 0) {
                this.onMutedSpeaking(this.repeatIntervalMs);
            }
        };
        if (typeof this.media.getSpeakingWhileMuted === "function") {
            Patcher.after(this.name, this.media, "getSpeakingWhileMuted", this.onSpeaking);
        }
        this.patchDiscordSounds();
        this.timer = setInterval(() => this.updateVoice(), 250);
        this.startMicMonitor();
    }

    onMutedSpeaking(cooldownMs = this.speakingCooldownMs) {
        if (!this.getMuted()) return;
        const now = Date.now();
        if (now - this.lastSpeakingAlert < cooldownMs) return;
        this.lastSpeakingAlert = now;
        this.play("speakingMuted");
    }

    async startMicMonitor() {
        const generation = ++this.micGeneration;
        this.stopMicMonitor();
        if (this.stopped) return;
        this.micStatus = "Requesting microphone access";
        try {
            if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone API unavailable");
            const selected = this.media?.getInputDeviceId?.();
            const audio = selected && selected !== "default"
                ? {deviceId: {ideal: selected}, echoCancellation: false, noiseSuppression: false}
                : {echoCancellation: false, noiseSuppression: false};
            const stream = await navigator.mediaDevices.getUserMedia({audio, video: false});
            if (this.stopped || generation !== this.micGeneration) {
                stream.getTracks().forEach(track => track.stop());
                return;
            }
            this.micStream = stream;
            const Context = window.AudioContext || window.webkitAudioContext;
            if (!Context) throw new Error("Web Audio unavailable");
            this.micContext = new Context();
            this.micSource = this.micContext.createMediaStreamSource(stream);
            this.micAnalyser = this.micContext.createAnalyser();
            this.micAnalyser.fftSize = 2048;
            this.micSamples = new Float32Array(this.micAnalyser.fftSize);
            this.micSource.connect(this.micAnalyser);
            await this.micContext.resume();
            if (this.stopped || generation !== this.micGeneration) {
                if (generation === this.micGeneration) this.stopMicMonitor();
                return;
            }
            const micName = stream.getAudioTracks()[0]?.label || "microphone";
            this.micStatus = `Listening: ${micName}`;
            this.micTimer = setInterval(() => this.checkMicLevel(), 100);
        } catch (error) {
            if (this.stopped || generation !== this.micGeneration) return;
            this.micStatus = `Unavailable: ${error.message}. Press Retry mic access.`;
            this.stopMicMonitor(false);
            console.warn("[TeamSpeakSounds] Microphone monitor unavailable", error);
        }
    }

    checkMicLevel() {
        if (!this.micAnalyser || !this.micSamples) return;
        this.micAnalyser.getFloatTimeDomainData(this.micSamples);
        let sum = 0;
        for (const sample of this.micSamples) sum += sample * sample;
        this.micLevel = Math.min(100, Math.sqrt(sum / this.micSamples.length) * 100);
        if (!this.getMuted()) {
            this.speakingFrames = 0;
            this.speechActive = false;
            this.silenceStartedAt = 0;
            return;
        }
        if (this.micLevel < this.micThreshold) {
            this.speakingFrames = 0;
            if (!this.silenceStartedAt) this.silenceStartedAt = Date.now();
            if (Date.now() - this.silenceStartedAt >= this.silenceResetMs) this.speechActive = false;
            return;
        }
        this.silenceStartedAt = 0;
        if (!this.speechActive && ++this.speakingFrames >= 2) {
            this.speechActive = true;
            this.onMutedSpeaking();
        } else if (this.speechActive && this.repeatIntervalMs > 0) {
            this.onMutedSpeaking(this.repeatIntervalMs);
        }
    }

    stopMicMonitor(resetStatus = true) {
        clearInterval(this.micTimer);
        this.micTimer = null;
        this.micStream?.getTracks().forEach(track => track.stop());
        this.micStream = null;
        this.micSource?.disconnect();
        this.micSource = null;
        this.micAnalyser?.disconnect();
        this.micAnalyser = null;
        this.micSamples = null;
        if (this.micContext) this.micContext.close().catch(() => {});
        this.micContext = null;
        this.micLevel = 0;
        this.speakingFrames = 0;
        this.speechActive = false;
        this.silenceStartedAt = 0;
        this.nativeSpeechActive = false;
        this.nativeSilenceStartedAt = 0;
        if (resetStatus) this.micStatus = "Waiting for microphone";
    }

    patchDiscordSounds() {
        try {
            const {Webpack, Patcher} = BdApi;
            let sounds = Webpack.getByKeys("createSound", "playSound");
            let createKey = "createSound";
            let playKey = "playSound";
            if (!sounds) {
                // Discord minifies the exported function names. Resolve the
                // module by strings in the sound functions, then patch its
                // actual exported methods instead of a temporary copy.
                sounds = Webpack.getModule(exports => {
                    if (!exports || typeof exports !== "object") return false;
                    const functions = Object.values(exports).filter(value => typeof value === "function");
                    return functions.some(fn => String(fn).includes("Unable to find sound for pack name"))
                        && functions.some(fn => String(fn).includes("playWithListener"));
                }, {searchExports: false});
                if (!sounds) {
                    const results = Webpack.getWithKey?.(
                        Webpack.Filters.bySource("Unable to find sound for pack name"),
                        {searchExports: true}
                    );
                    sounds = results && [...results][0]?.[0];
                }
                const methods = Object.entries(sounds || {}).filter(([, value]) => typeof value === "function");
                createKey = methods.find(([, fn]) => /return new\s/.test(String(fn)))?.[0];
                playKey = methods.find(([, fn]) => String(fn).includes("playWithListener"))?.[0];
            }
            if (typeof sounds?.[createKey] !== "function") {
                this.nativeHookStatus = "Discord sound module not found";
                return;
            }
            const sample = sounds[createKey]("mute");
            const prototype = sample && Object.getPrototypeOf(sample);
            if (!prototype || typeof prototype.play !== "function") {
                this.nativeHookStatus = "Discord sound player not found";
                return;
            }
            let patched = 0;
            for (const method of ["play", "playWithListener", "loop"]) {
                if (typeof prototype[method] !== "function") continue;
                const cancel = Patcher.instead(this.name, prototype, method, (sound, args, original) => {
                    const id = this.clipForDiscordSound(sound?.name);
                    if (!id) return original(...args);
                    this.play(id);
                    if (method === "playWithListener") {
                        return new Promise(resolve => setTimeout(() => resolve(true), Math.max(0, sound.duration || 0)));
                    }
                });
                if (cancel) patched++;
            }
            if (typeof sounds[playKey] === "function") {
                Patcher.instead(this.name, sounds, playKey, (_scope, args, original) => {
                    const id = this.clipForDiscordSound(args[0]);
                    if (id) {
                        this.play(id);
                        return;
                    }
                    return original(...args);
                });
            }
            this.nativeHookStatus = patched ? "Active" : "Could not patch Discord sound player";
        } catch (error) {
            this.nativeHookStatus = "Error attaching to Discord sounds";
            console.error("[TeamSpeakSounds] Could not replace Discord sounds", error);
        }
    }

    clipForDiscordSound(name) {
        const id = DISCORD_SOUNDS[name];
        if (name === "user_join") {
            const channel = this.getChannelId();
            if (channel && channel !== this.channelId) {
                this.updateVoice();
                return "connect";
            }
            if (this.lastConnectedAt && Date.now() - this.lastConnectedAt < 1200) return "connect";
        }
        if (name === "user_leave" && this.channelId && !this.getChannelId()) {
            this.updateVoice();
            return "disconnect";
        }
        return id;
    }

    stop() {
        this.stopped = true;
        this.micGeneration++;
        clearInterval(this.timer);
        this.stopMicMonitor();
        BdApi.Patcher.unpatchAll(this.name);
        for (const audio of this.activeAudio) {
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
        }
        this.activeAudio.clear();
    }

    getChannelId() {
        return this.voiceStates?.getCurrentClientVoiceChannelId?.()
            || this.selected?.getVoiceChannelId?.()
            || null;
    }

    getMuted() {
        return !!this.media?.isSelfMute?.();
    }

    getChannelMembers(channelId) {
        if (!channelId) return new Set();
        const states = this.voiceStates?.getVoiceStatesForChannel?.(channelId);
        const ownId = this.users?.getCurrentUser?.()?.id;
        const ids = Array.isArray(states)
            ? states.map(state => state?.userId || state?.user_id)
            : Object.keys(states || {});
        return new Set(ids.filter(id => id && id !== ownId));
    }

    updateVoice() {
        try {
            const channel = this.getChannelId();
            const muted = this.getMuted();
            if (channel !== this.channelId) {
                if (this.channelId && !channel) this.play("disconnect");
                if (channel) {
                    this.lastConnectedAt = Date.now();
                    this.play("connect");
                }
                this.channelId = channel;
                this.channelMembers = this.getChannelMembers(channel);
                this.lastSpeakingAlert = 0;
            } else if (channel) {
                const members = this.getChannelMembers(channel);
                for (const id of members) {
                    if (!this.channelMembers.has(id)) this.play("otherJoin");
                }
                for (const id of this.channelMembers) {
                    if (!members.has(id)) this.play("otherLeave");
                }
                this.channelMembers = members;
            }
            // The user's own mute toggle can change before a voice channel is
            // reflected in the voice state store, or while in a DM call.
            if (muted !== this.muted) this.play(muted ? "mute" : "unmute");
            this.muted = muted;
        } catch (error) {
            console.error("[TeamSpeakSounds] Could not check voice state", error);
        }
    }

    play(id, status) {
        const sound = this.sounds[id];
        if (!sound?.url) return;
        if (!status && id !== "speakingMuted") {
            const now = Date.now();
            const last = this.lastEvent.get(id) || 0;
            const interval = id === "mute" || id === "unmute" ? 600 : 1300;
            if (now - last < interval) return;
            this.lastEvent.set(id, now);
        }
        if (!status) this.lastDetectedEvent = CLIPS[id].label;
        const audio = new Audio(sound.url);
        audio.volume = Math.max(0, Math.min(1, sound.volume / 100));
        this.activeAudio.add(audio);
        const release = () => {
            this.activeAudio.delete(audio);
            audio.removeEventListener("ended", release);
            audio.removeEventListener("error", failed);
        };
        const failed = () => {
            if (status) status.textContent = "Could not play URL. Download the MP3 and use Choose MP3.";
            if (!this.reportedPlaybackFailures.has(id)) {
                this.reportedPlaybackFailures.add(id);
                BdApi.UI.showToast(`${CLIPS[id].label}: audio could not load. Download the MP3 and select it in TeamSpeakSounds settings.`, {type: "error"});
            }
            release();
        };
        audio.addEventListener("ended", release);
        audio.addEventListener("error", failed);
        const result = audio.play();
        result?.catch(failed);
    }

    save(id) {
        BdApi.Data.save(this.name, id, this.sounds[id]);
    }

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.className = "tss-settings";
        const styles = document.createElement("style");
        styles.textContent = `
            .tss-settings { color:var(--text-normal);padding:12px 16px;max-width:700px;box-sizing:border-box }
            .tss-settings .tss-intro { color:var(--text-muted);line-height:1.5;margin:0 0 14px }
            .tss-settings .tss-diagnostic { color:var(--text-muted);font-size:12px;margin:0 0 16px }
            .tss-settings .tss-card { background:var(--background-secondary);border:1px solid var(--background-modifier-accent);border-radius:12px;padding:16px;margin:12px 0 }
            .tss-settings .tss-card-title { display:block;font-size:14px;margin:0 0 12px;color:var(--text-normal) }
            .tss-settings .tss-mic-grid { display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px }
            .tss-settings .tss-field { display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-muted);line-height:1.3 }
            .tss-settings .tss-input { box-sizing:border-box;background:var(--background-primary);color:var(--text-normal);border:1px solid var(--background-modifier-accent);border-radius:8px;padding:9px 10px;outline:none;font:inherit;min-height:36px }
            .tss-settings .tss-input:focus-visible { border-color:var(--brand-500,#5865f2);box-shadow:0 0 0 2px color-mix(in srgb,var(--brand-500,#5865f2) 28%,transparent) }
            .tss-settings .tss-number { width:76px;text-align:center }
            .tss-settings .tss-url { width:100%;margin:0 0 14px;font-size:12px }
            .tss-settings .tss-volume-row { display:grid;grid-template-columns:auto minmax(90px,1fr) 76px;gap:12px;align-items:center;margin-bottom:14px }
            .tss-settings .tss-volume-label { font-size:12px;font-weight:600;white-space:nowrap }
            .tss-settings .tss-slider { appearance:none;-webkit-appearance:none;width:100%;height:6px;border-radius:20px;outline:none;cursor:pointer;background:linear-gradient(to right,var(--brand-500,#5865f2) var(--tss-level),var(--background-modifier-accent) var(--tss-level)) }
            .tss-settings .tss-slider::-webkit-slider-thumb { appearance:none;-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--brand-500,#5865f2);border:3px solid var(--background-secondary);box-shadow:0 0 0 1px var(--brand-500,#5865f2) }
            .tss-settings .tss-slider::-moz-range-thumb { width:10px;height:10px;border-radius:50%;background:var(--brand-500,#5865f2);border:3px solid var(--background-secondary);box-shadow:0 0 0 1px var(--brand-500,#5865f2) }
            .tss-settings .tss-slider:focus-visible { outline:2px solid var(--brand-500,#5865f2);outline-offset:6px }
            .tss-settings .tss-actions { display:flex;flex-wrap:wrap;gap:8px }
            .tss-settings .tss-button { appearance:none;min-height:34px;padding:7px 12px;border:1px solid var(--background-modifier-accent);border-radius:8px;background:var(--background-tertiary);color:var(--text-normal);font:inherit;font-size:12px;font-weight:600;line-height:1.3;cursor:pointer;transition:background-color .15s ease,transform .15s ease }
            .tss-settings .tss-button:hover { background:var(--background-modifier-hover);transform:translateY(-1px) }
            .tss-settings .tss-button:focus-visible { outline:2px solid var(--brand-500,#5865f2);outline-offset:2px }
            .tss-settings .tss-button-primary { background:var(--brand-500,#5865f2);border-color:var(--brand-500,#5865f2);color:#fff }
            .tss-settings .tss-button-primary:hover { background:var(--brand-560,#4752c4) }
            .tss-settings .tss-status { display:block;min-height:15px;color:var(--text-muted);font-size:12px;margin-top:10px }
            .tss-settings .tss-mic-reading { display:block;color:var(--text-muted);line-height:1.5;margin-top:12px }
        `;
        panel.append(styles);
        const intro = document.createElement("p");
        intro.className = "tss-intro";
        intro.textContent = "Adjust your TeamSpeak sounds. Set a volume, play a preview, or choose your own audio file.";
        panel.append(intro);
        const diagnostic = document.createElement("p");
        diagnostic.className = "tss-diagnostic";
        const showDiagnostic = () => {
            diagnostic.textContent = `Discord sound replacement: ${this.nativeHookStatus}. Last detected: ${this.lastDetectedEvent}.`;
        };
        showDiagnostic();
        panel.append(diagnostic);
        const diagnosticTimer = setInterval(() => {
            if (!panel.isConnected) clearInterval(diagnosticTimer);
            else showDiagnostic();
        }, 1000);

        const micCard = document.createElement("div");
        micCard.className = "tss-card";
        const micTitle = document.createElement("strong");
        micTitle.className = "tss-card-title";
        micTitle.textContent = "Speaking while muted";
        const micRow = document.createElement("div");
        micRow.className = "tss-mic-grid";
        const micLabel = document.createElement("label");
        micLabel.textContent = "Muted speech threshold (%)";
        micLabel.className = "tss-field";
        const threshold = document.createElement("input");
        threshold.type = "number";
        threshold.min = "0.1";
        threshold.max = "50";
        threshold.step = "0.1";
        threshold.value = String(this.micThreshold);
        threshold.className = "tss-input tss-number";
        threshold.addEventListener("change", () => {
            const value = Number(threshold.value);
            if (!Number.isFinite(value)) return;
            this.micThreshold = Math.max(0.1, Math.min(50, Math.round(value * 10) / 10));
            threshold.value = String(this.micThreshold);
            BdApi.Data.save(this.name, "micThreshold", this.micThreshold);
        });
        micLabel.append(threshold);
        const repeatLabel = document.createElement("label");
        repeatLabel.textContent = "Repeat while talking (seconds, 0 = off)";
        repeatLabel.className = "tss-field";
        const repeat = document.createElement("input");
        repeat.type = "number";
        repeat.min = "0";
        repeat.max = "60";
        repeat.step = "1";
        repeat.value = String(this.repeatIntervalMs / 1000);
        repeat.className = "tss-input tss-number";
        repeat.addEventListener("change", () => {
            const value = Number(repeat.value);
            if (!Number.isFinite(value)) return;
            const seconds = Math.max(0, Math.min(60, Math.round(value)));
            this.repeatIntervalMs = seconds * 1000;
            repeat.value = String(seconds);
            BdApi.Data.save(this.name, "repeatSeconds", seconds);
        });
        repeatLabel.append(repeat);
        const pauseLabel = document.createElement("label");
        pauseLabel.textContent = "Pause before a new reminder (ms)";
        pauseLabel.className = "tss-field";
        const pause = document.createElement("input");
        pause.type = "number";
        pause.min = "100";
        pause.max = "3000";
        pause.step = "100";
        pause.value = String(this.silenceResetMs);
        pause.className = "tss-input tss-number";
        pause.addEventListener("change", () => {
            const value = Number(pause.value);
            if (!Number.isFinite(value)) return;
            this.silenceResetMs = Math.max(100, Math.min(3000, Math.round(value / 100) * 100));
            pause.value = String(this.silenceResetMs);
            BdApi.Data.save(this.name, "silenceResetMs", this.silenceResetMs);
        });
        pauseLabel.append(pause);
        const retryMic = document.createElement("button");
        retryMic.type = "button";
        retryMic.className = "tss-button";
        retryMic.textContent = "Retry mic access";
        retryMic.addEventListener("click", () => this.startMicMonitor());
        const micReading = document.createElement("small");
        micReading.className = "tss-mic-reading";
        const micReadingTimer = setInterval(() => {
            if (!panel.isConnected) {
                clearInterval(micReadingTimer);
                return;
            }
            micReading.textContent = `${this.micStatus}. Current level: ${this.micLevel.toFixed(1)}%. Threshold is the mic loudness needed to trigger an alert; 0 repeats only on a new sentence.`;
        }, 200);
        micReading.textContent = this.micStatus;
        micRow.append(micLabel, repeatLabel, pauseLabel, retryMic);
        micCard.append(micTitle, micRow, micReading);
        panel.append(micCard);

        for (const [id, clip] of Object.entries(CLIPS)) {
            const row = document.createElement("div");
            row.className = "tss-card";
            const label = document.createElement("strong");
            label.textContent = clip.label;
            label.className = "tss-card-title";

            const url = document.createElement("input");
            url.type = "text";
            url.value = this.sounds[id].url.startsWith("data:") ? "MP3 saved locally (paste a URL to replace it)" : this.sounds[id].url;
            url.title = "Direct audio URL";
            url.className = "tss-input tss-url";
            url.addEventListener("change", () => {
                const value = url.value.trim();
                if (/^https:\/\//i.test(value) || /^data:audio\//i.test(value)) {
                    this.sounds[id].url = value;
                    this.save(id);
                    this.reportedPlaybackFailures.delete(id);
                } else {
                    url.value = this.sounds[id].url;
                    status.textContent = "Use an HTTPS direct audio link or Choose MP3.";
                }
            });

            const controls = document.createElement("div");
            controls.className = "tss-volume-row";
            const volumeLabel = document.createElement("span");
            volumeLabel.textContent = `Volume ${this.sounds[id].volume}%`;
            volumeLabel.className = "tss-volume-label";
            const volume = document.createElement("input");
            volume.type = "range";
            volume.className = "tss-slider";
            volume.setAttribute("aria-label", `${clip.label} volume`);
            volume.min = "0";
            volume.max = "100";
            volume.value = String(this.sounds[id].volume);
            volume.style.setProperty("--tss-level", `${this.sounds[id].volume}%`);
            const volumeNumber = document.createElement("input");
            volumeNumber.type = "number";
            volumeNumber.min = "0";
            volumeNumber.max = "100";
            volumeNumber.step = "1";
            volumeNumber.value = String(this.sounds[id].volume);
            volumeNumber.title = "Volume percent";
            volumeNumber.className = "tss-input tss-number";
            const saveVolume = value => {
                const number = Math.max(0, Math.min(100, Math.round(Number(value))));
                if (!Number.isFinite(number)) return;
                this.sounds[id].volume = number;
                volume.value = String(number);
                volume.style.setProperty("--tss-level", `${number}%`);
                volumeNumber.value = String(number);
                volumeLabel.textContent = `Volume ${number}%`;
                this.save(id);
            };
            volume.addEventListener("input", () => {
                saveVolume(volume.value);
            });
            volumeNumber.addEventListener("change", () => saveVolume(volumeNumber.value));
            const test = document.createElement("button");
            test.type = "button";
            test.className = "tss-button tss-button-primary";
            test.textContent = "▶  Play test";
            test.addEventListener("click", () => this.play(id, status));
            const actions = document.createElement("div");
            actions.className = "tss-actions";
            const file = document.createElement("input");
            file.type = "file";
            file.accept = "audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/*";
            file.title = "Choose MP3";
            file.style.display = "none";
            const fileButton = document.createElement("button");
            fileButton.type = "button";
            fileButton.className = "tss-button";
            fileButton.textContent = "↑  Choose audio file";
            fileButton.addEventListener("click", () => file.click());
            const status = document.createElement("small");
            status.className = "tss-status";
            file.addEventListener("change", () => {
                const selected = file.files?.[0];
                if (!selected) return;
                const reader = new FileReader();
                reader.onload = () => {
                    this.sounds[id].url = String(reader.result);
                    this.save(id);
                    this.reportedPlaybackFailures.delete(id);
                    url.value = `${selected.name} (saved locally in BetterDiscord)`;
                    status.textContent = "Saved. Press Test to hear it.";
                };
                reader.onerror = () => { status.textContent = "The MP3 could not be read."; };
                reader.readAsDataURL(selected);
            });
            const reset = document.createElement("button");
            reset.type = "button";
            reset.className = "tss-button";
            reset.textContent = "↺  Reset URL";
            reset.addEventListener("click", () => {
                this.sounds[id].url = clip.url;
                this.save(id);
                this.reportedPlaybackFailures.delete(id);
                url.value = clip.url;
                file.value = "";
                status.textContent = "Restored original MP3 URL.";
            });

            controls.append(volumeLabel, volume, volumeNumber);
            actions.append(test, fileButton, reset, file);
            row.append(label, url, controls, actions, status);
            panel.append(row);
        }
        return panel;
    }
};
