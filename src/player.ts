// Plays the Voice's audio chunks strictly one after another and reports
// loudness, so Broca's area can pulse with what is being said.
//
// Rules that keep it from ever talking over itself:
// - only the current element may advance the queue, and only once;
// - an element that is left behind is paused and emptied, so it can't start
//   playing later when its download finishes;
// - an interrupted play() (AbortError) is retried, not skipped;
// - if the browser blocks sound (no click yet), playback stops instead of
//   racing through the queue.

export class VoicePlayer {
  private queue: string[] = [];
  private current: HTMLAudioElement | null = null;
  private next: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buf = new Uint8Array(1024);
  private raf = 0;
  onLevel: (level: number) => void = () => {};
  onState: (playing: boolean) => void = () => {};
  onBlocked: () => void = () => {};
  /** Turns a queued chunk key into a playable URL (making the audio if needed). */
  resolve: (key: string) => Promise<string> = async (k) => k;
  private keys = new WeakMap<HTMLAudioElement, string>();
  private loading = new WeakMap<HTMLAudioElement, Promise<void>>();

  get playing(): boolean {
    return !!this.current;
  }

  /** The chunk being played right now ("<session>/<name>"), if any. */
  get currentKey(): string | null {
    return this.current ? this.keys.get(this.current) ?? null : null;
  }

  /** Create/resume the audio context; call from a click so browsers allow sound. */
  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  enqueue(url: string) {
    this.queue.push(url);
    if (!this.current) this.playNext();
    else this.prefetch();
  }

  stop() {
    this.queue = [];
    this.discard(this.next);
    this.next = null;
    this.discard(this.current);
    this.current = null;
    cancelAnimationFrame(this.raf);
    this.onLevel(0);
    this.onState(false);
  }

  private discard(a: HTMLAudioElement | null) {
    if (!a) return;
    a.onended = a.onerror = null;
    this.keys.delete(a); // a late-resolving URL is no longer attached
    a.pause();
    a.removeAttribute("src");
    a.load(); // drops the download, so it can never start on its own
  }

  private element(key: string): HTMLAudioElement {
    const a = new Audio();
    a.preload = "auto";
    this.keys.set(a, key);
    // resolving also makes an on-demand chunk ahead of time (prefetch)
    this.loading.set(a, this.resolve(key).then((u) => {
      if (this.keys.has(a)) a.src = u;
    }));
    return a;
  }

  /** Ask for the following chunk while the current one plays. */
  private prefetch() {
    if (!this.next && this.queue.length) this.next = this.element(this.queue[0]);
  }

  private playNext() {
    this.discard(this.current);
    const url = this.queue.shift();
    if (!url) {
      this.current = null;
      cancelAnimationFrame(this.raf);
      this.onLevel(0);
      this.onState(false);
      return;
    }
    let a: HTMLAudioElement;
    if (this.next && this.keys.get(this.next) === url) a = this.next;
    else {
      this.discard(this.next);
      a = this.element(url);
    }
    this.next = null;
    this.current = a;
    if (this.ctx && this.analyser) {
      try {
        this.ctx.createMediaElementSource(a).connect(this.analyser);
      } catch {
        /* already connected */
      }
    }
    const advance = () => {
      if (this.current === a) this.playNext(); // only once, only for the current chunk
    };
    a.onended = advance;
    a.onerror = advance; // a broken chunk is skipped
    (this.loading.get(a) ?? Promise.resolve()).then(() => this.start(a, 0), advance);
    this.prefetch();
  }

  private start(a: HTMLAudioElement, attempt: number) {
    if (this.current !== a) return;
    a.play().then(() => {
      if (this.current !== a) return;
      this.onState(true);
      cancelAnimationFrame(this.raf);
      this.meter();
    }).catch((e: DOMException) => {
      if (this.current !== a) return;
      if (e.name === "NotAllowedError") {
        // the browser wants a click first: stop cleanly instead of skipping everything
        this.stop();
        this.onBlocked();
      } else if (e.name === "AbortError" && attempt < 3) {
        setTimeout(() => this.current === a && this.start(a, attempt + 1), 150);
      } else {
        this.playNext();
      }
    });
  }

  private meter = () => {
    if (!this.current || !this.analyser) return;
    this.analyser.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += ((v - 128) / 128) ** 2;
    this.onLevel(Math.min(1, Math.sqrt(sum / this.buf.length) * 5));
    this.raf = requestAnimationFrame(this.meter);
  };
}
